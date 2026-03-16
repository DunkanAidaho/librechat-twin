from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.exc import DataError

from core.clients import get_engine
from models.pydantic_models import (
    Chunk,
    ChunkMetadata,
    GraphContextResponse,
    SearchRequest,
    SearchResponse,
)
from services.embeddings import embed_with_fallback
from services.neo4j import fetch_graph_context

logger = logging.getLogger("tools-gateway.rag")

EMBEDDING_CONFIG: dict[str, tuple[str, int]] = {
    "e5": ("embedding_e5", 768),
    "mxbai": ("embedding_mxbai", 1024),
}

FALLBACK_ORDER: Sequence[str] = ("e5", "mxbai")
DEFAULT_TOP_K = 10
RRF_K = 60  # Constant for Reciprocal Rank Fusion


class RAGQueryBuilder:
    """Helper class to build safe SQL queries for RAG."""

    def __init__(self, req: SearchRequest, column: str, dim: int, vector: Sequence[float]):
        self.req = req
        self.column = column
        self.dim = dim
        self.vector = vector
        self.params: Dict[str, Any] = {
            "query_vec": json.dumps(list(vector), separators=(",", ":")),
            "query_text": req.query,
            "top_k": req.top_k * 2,  # Fetch more for RRF
            "user_id": req.user_id,
        }
        self.clauses: List[str] = [f"{column} IS NOT NULL"]

    def build_where_clauses(self):
        if self.req.conversation_id:
            self.clauses.append("doc_id = :conv_id")
            self.params["conv_id"] = self.req.conversation_id

        self.clauses.append("metadata->>'user_id' = :user_id")

        if not self.req.include_noise:
            self.clauses.append("COALESCE((metadata->>'is_noise')::boolean, false) = false")

        if self.req.roles:
            self.clauses.append("metadata->>'role' = ANY(:roles)")
            self.params["roles"] = list(self.req.roles)

        if self.req.content_type:
            self.clauses.append("metadata->>'content_type' = :content_type")
            self.params["content_type"] = self.req.content_type

        if self.req.date_filter:
            self._add_date_filter()

    def _add_date_filter(self):
        df = self.req.date_filter
        date_from = _parse_date(df.from_date)
        date_to = _parse_date(df.to_date, end_of_day=True)

        if not date_from and not date_to:
            return

        if date_from:
            self.params["date_from"] = date_from
        if date_to:
            self.params["date_to"] = date_to

        # Logic for content_dates vs created_at
        # 1. If content_dates exists, it must match.
        # 2. If content_dates is empty/null, fallback to created_at ONLY for non-assistant roles.
        
        range_pred = ""
        if date_from and date_to:
            range_pred = "BETWEEN :date_from AND :date_to"
        elif date_from:
            range_pred = ">= :date_from"
        else:
            range_pred = "<= :date_to"

        content_dates_match = (
            f"EXISTS (SELECT 1 FROM jsonb_array_elements_text(metadata->'content_dates') d "
            f"WHERE d::timestamptz {range_pred})"
        )
        
        created_at_match = f"(metadata->>'created_at')::timestamptz {range_pred}"
        
        content_dates_present = (
            "jsonb_typeof(metadata->'content_dates') = 'array' "
            "AND jsonb_array_length(metadata->'content_dates') > 0"
        )

        if df.strict_content_only:
            self.clauses.append(f"({content_dates_present} AND {content_dates_match})")
        else:
            is_not_assistant = "metadata->>'role' <> 'assistant'"
            self.clauses.append(
                f"(({content_dates_present} AND {content_dates_match}) OR "
                f"(NOT ({content_dates_present}) AND {is_not_assistant} AND {created_at_match}))"
            )

    def get_vector_sql(self) -> str:
        return f"""
            SELECT doc_id, chunk_id, content, metadata,
                   ({self.column} <=> (:query_vec)::vector({self.dim})) as distance
            FROM chunks
            WHERE {" AND ".join(self.clauses)}
            ORDER BY distance ASC
            LIMIT :top_k
        """

    def get_keyword_sql(self) -> str:
        # Using the pre-computed content_tsvector column for performance
        return f"""
            SELECT doc_id, chunk_id, content, metadata,
                   ts_rank_cd(content_tsvector, plainto_tsquery('russian', :query_text)) as rank
            FROM chunks
            WHERE {" AND ".join(self.clauses)}
              AND content_tsvector @@ plainto_tsquery('russian', :query_text)
            ORDER BY rank DESC
            LIMIT :top_k
        """


def _parse_date(value: Optional[str], *, end_of_day: bool = False) -> Optional[str]:
    if not value:
        return None
    raw = value.strip()
    candidates = ("%d.%m.%Y", "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ")
    parsed: Optional[datetime] = None
    for fmt in candidates:
        try:
            parsed = datetime.strptime(raw, fmt)
            break
        except ValueError:
            continue
    if parsed is None:
        return None
    if end_of_day and parsed.time() == datetime.min.time():
        parsed = parsed + timedelta(days=1) - timedelta(seconds=1)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.utcnow().astimezone().tzinfo)
    return parsed.isoformat()


def rrf_combine(vector_results: List[Dict], keyword_results: List[Dict], top_k: int) -> List[Tuple[Dict, float, str]]:
    """Combines results using Reciprocal Rank Fusion."""
    scores: Dict[Tuple[str, Union[int, str]], float] = {}
    data: Dict[Tuple[str, Union[int, str]], Dict] = {}
    
    for rank, res in enumerate(vector_results):
        key = (res["doc_id"], res["chunk_id"])
        scores[key] = scores.get(key, 0) + 1.0 / (RRF_K + rank + 1)
        data[key] = res
        res["match_type"] = "vector"

    for rank, res in enumerate(keyword_results):
        key = (res["doc_id"], res["chunk_id"])
        scores[key] = scores.get(key, 0) + 1.0 / (RRF_K + rank + 1)
        if key in data:
            data[key]["match_type"] = "hybrid"
        else:
            data[key] = res
            res["match_type"] = "keyword"

    sorted_keys = sorted(scores.keys(), key=lambda k: scores[k], reverse=True)
    
    combined = []
    for key in sorted_keys[:top_k]:
        combined.append((data[key], scores[key], data[key].get("match_type", "unknown")))
    
    return combined


async def search_documents(req: SearchRequest) -> SearchResponse:
    logger.info("[Search] query='%s' user_id=%s", req.query, req.user_id)

    # 1. Embeddings
    embeddings = await embed_with_fallback(req.query)
    model_used, column, dim, vector = _resolve_embedding(embeddings, req.embedding_model)
    
    builder = RAGQueryBuilder(req, column, dim, vector)
    builder.build_where_clauses()

    engine = get_engine()
    vector_rows = []
    keyword_rows = []

    # 2. Parallel/Sequential Search
    try:
        with engine.connect() as conn:
            vector_rows = conn.execute(text(builder.get_vector_sql()), builder.params).mappings().all()
            try:
                keyword_rows = conn.execute(text(builder.get_keyword_sql()), builder.params).mappings().all()
            except Exception as e:
                logger.warning("[Search] Keyword search failed (maybe no tsvector index?): %s", e)
                keyword_rows = []
    except DataError as exc:
        logger.exception("[Search] Database error")
        raise HTTPException(status_code=500, detail="Search failed") from exc

    # 3. RRF Combination
    combined = rrf_combine(
        [dict(r) for r in vector_rows],
        [dict(r) for r in keyword_rows],
        req.top_k
    )

    # 4. Graph Enrichment (Optional)
    graph_context = None
    if req.include_graph:
        if req.conversation_id:
            try:
                graph_data = await fetch_graph_context(req.conversation_id)
                if graph_data and (graph_data.get("lines") or graph_data.get("summary")):
                    graph_context = GraphContextResponse(**graph_data)
                    logger.info(
                        "[Search] Graph context enriched (lines: %d, summary: %s)",
                        len(graph_data.get("lines", [])),
                        "yes" if graph_data.get("summary") else "no",
                    )
                else:
                    logger.info(
                        "[Search] No graph context found for conversation_id=%s",
                        req.conversation_id,
                    )
            except Exception as e:
                logger.error("[Search] Graph enrichment failed: %s", e)
        else:
            logger.warning("[Search] include_graph is True but conversation_id is missing")

    # 5. Final Assembly
    final_results = []
    for row_dict, rrf_score, match_type in combined:
        raw_meta = row_dict.get("metadata") or {}
        
        # Boost score if entities match graph (simplified logic)
        if graph_context and any(ent.lower() in row_dict["content"].lower() for ent in (graph_context.query_hint or "").split(",")):
            match_type = "graph"
            rrf_score *= 1.2

        meta = ChunkMetadata(
            score=rrf_score,
            match_type=match_type,
            role=raw_meta.get("role"),
            created_at=raw_meta.get("created_at"),
            content_dates=raw_meta.get("content_dates") or [],
            is_noise=raw_meta.get("is_noise", False),
            entities=raw_meta.get("entities") or [],
            source_chunk_id=raw_meta.get("source_chunk_id")
        )
        
        final_results.append(Chunk(
            doc_id=row_dict["doc_id"],
            chunk_id=row_dict["chunk_id"],
            content=row_dict["content"],
            metadata=meta,
            score=rrf_score
        ))

    return SearchResponse(
        query=req.query,
        results=final_results,
        graph_context=graph_context
    )


def _resolve_embedding(
    embeddings: Dict[str, Sequence[float]],
    requested_model: Optional[str],
) -> tuple[str, str, int, Sequence[float]]:
    candidates: list[str] = []
    if requested_model:
        candidates.append(requested_model)
    candidates.extend(model for model in FALLBACK_ORDER if model not in candidates)

    for model in candidates:
        config = EMBEDDING_CONFIG.get(model)
        vector = embeddings.get(model)
        if config and vector:
            column, dim = config
            return model, column, dim, vector

    raise RuntimeError(f"No suitable embedding for {requested_model}")


def vector_literal(vector: Sequence[float]) -> str:
    """Converts a vector to a PostgreSQL-compatible string literal."""
    return json.dumps(list(vector), separators=(",", ":"))
