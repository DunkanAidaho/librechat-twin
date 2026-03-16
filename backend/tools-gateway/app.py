from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections import deque
from datetime import datetime
from typing import Any, Deque, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from temporalio.exceptions import WorkflowAlreadyStartedError
from sqlalchemy.sql import text

from core.clients import (
    close_neo4j_driver,
    dispose_engine,
    get_engine,
    shutdown_http_client,
)
from core.config import is_production, settings
from core.logging import configure_logging
from models.pydantic_models import (
    Chunk,
    CypherRequest,
    CypherResponse,
    DeleteConversationRequest,
    EntityExtractionRequest,
    EntityExtractionResponse,
    GraphContextRequest,
    GraphContextResponse,
    IngestGraphDataRequest,
    IngestGraphDataResponse,
    IngestMessageRequest,
    IngestSummaryRequest,
    MessageForSummary,
    SearchRequest,
    SearchResponse,
    ToolSearchContextRequest,
    ToolSearchContextResponse,
    ToolSubmitIngestRequest,
    ToolSubmitIngestResponse,
    ToolContextPack,
    ToolBudgetHint,
    ToolSearchFilters,
    ToolRecentMessage,
    TemporalGraphRequest,
    TemporalMemoryRequest,
    TemporalSummaryRequest,
)
from services.context_manager import context_manager
from services.mongo_repository import fetch_messages, fetch_messages_window_by_message_id
from services.embeddings import embed_with_fallback
from services.llm import (
    RELATION_FALLBACK_TYPE,
    call_llm,
    detect_context_flags,
    get_stats as get_llm_stats,
    set_http_client,
    set_vertex_model,
)
from services.metrics import (
    render_prometheus_metrics,
    inc_tool_ingest_status_not_found,
    inc_tool_ingest_status_requests,
    inc_tool_search_context_failures,
    inc_tool_search_context_requests,
    inc_tool_submit_ingest_failures,
    inc_tool_submit_ingest_profile,
    inc_tool_submit_ingest_requests,
    inc_tool_submit_ingest_status,
)
from services.model_watchdog import periodically_check_primary_model
from services.summary import generate_summary_text
from services.temporal_client import (
    get_temporal_client,
    shutdown_temporal_client,
    temporal_settings,
)
from services.workflow_launcher import (
    start_graph_workflow,
    start_memory_workflow,
    start_summary_workflow,
)
from services.nats_dispatcher import NatsDispatcher
from services.status_store import add_event, list_events, list_events_for_job
from services.neo4j import (
    delete_conversation as delete_conversation_service,
    execute_cypher_query,
    fetch_graph_context,
    ingest_entities_neo4j,
    set_conversation_summary,
)
from services.rag import search_documents, vector_literal
from services.cleanup import delete_conversation_everywhere
from services.text_utils import extract_content_dates

logger = configure_logging()

HTTPX_TIMEOUT_SECONDS = settings.HTTPX_TIMEOUT_SECONDS
TEI_URL_MX = settings.TEI_URL_MX
TEI_URL_E5 = settings.TEI_URL_E5

USE_OLLAMA = settings.USE_OLLAMA_FOR_ENTITY_EXTRACTION
USE_OPENROUTER = settings.USE_OPENROUTER_FOR_ENTITY_EXTRACTION
OPENROUTER_API_KEY = settings.OPENROUTER_API_KEY
OPENROUTER_BASE_URL = settings.OPENROUTER_BASE_URL
OPENROUTER_MODEL_PRIMARY = settings.OPENROUTER_MODEL_PRIMARY
SUMMARY_WORKFLOWS_ENABLED = settings.SUMMARY_WORKFLOWS_ENABLED

app = FastAPI(
    title="RAG + Graph Tools",
    description="Векторный поиск и граф для LibreChat и вложенных переписок.",
    version="5.4.2",
)

engine = get_engine()
global_http_client: Optional[httpx.AsyncClient] = None
nats_dispatcher: Optional[NatsDispatcher] = None

FORBIDDEN_CYPHER_PATTERN = re.compile(
    r"\b(DELETE|CALL|MERGE|CREATE|DROP|REMOVE|SET|LOAD\s+CSV|INDEX|CONSTRAINT)\b",
    re.IGNORECASE,
)

TOOL_RATE_WINDOW_SECONDS = 60
tool_rate_lock = asyncio.Lock()
tool_rate_buckets: Dict[str, Deque[float]] = {}


def _extract_bearer_token(request: Request) -> Optional[str]:
    auth_header = request.headers.get("authorization")
    if not auth_header:
        return None
    parts = auth_header.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None


def _get_client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


async def _allow_tool_request(token: Optional[str], client_ip: str) -> bool:
    limit = max(0, settings.TOOLS_GATEWAY_TOOL_RATE_LIMIT_PER_MINUTE)
    if limit == 0:
        return True
    key = f"{token or 'anon'}:{client_ip}"
    now = time.time()
    async with tool_rate_lock:
        bucket = tool_rate_buckets.get(key)
        if bucket is None:
            bucket = deque()
            tool_rate_buckets[key] = bucket
        cutoff = now - TOOL_RATE_WINDOW_SECONDS
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= limit:
            return False
        bucket.append(now)
    return True


@app.middleware("http")
async def tools_gateway_security_middleware(request: Request, call_next):
    path = request.url.path or ""
    if path.startswith("/tool/") or path.startswith("/temporal/"):
        # Skip token verification only in dev environment with auth bypass enabled
        is_dev_env = settings.TOOLS_GATEWAY_ENV.strip().lower() == "dev"
        auth_bypass_enabled = settings.TOOLS_GATEWAY_AUTH_BYPASS_IN_DEV
        
        # Log warning if auth bypass is enabled
        if auth_bypass_enabled and is_dev_env:
            logger.warning("⚠️  AUTH BYPASS IS ENABLED - ONLY FOR DEVELOPMENT!")
        
        if not (is_dev_env and auth_bypass_enabled):
            if not settings.TOOLS_GATEWAY_SERVICE_TOKEN:
                return JSONResponse(status_code=503, content={"error": "Service token is not configured"})
            token = _extract_bearer_token(request)
            if token != settings.TOOLS_GATEWAY_SERVICE_TOKEN:
                return JSONResponse(status_code=401, content={"error": "Unauthorized"})
        if path.startswith("/tool/"):
            client_ip = _get_client_ip(request)
            # Use debug token only when auth bypass is enabled in dev
            token_key = token if not (is_dev_env and auth_bypass_enabled) else "debug"
            allowed = await _allow_tool_request(token_key, client_ip)
            if not allowed:
                return JSONResponse(status_code=429, content={"error": "Rate limit exceeded"})

    return await call_next(request)


if not USE_OLLAMA and not USE_OPENROUTER:
    try:
        import vertexai
        from vertexai.generative_models import GenerativeModel

        project = os.getenv("GCP_PROJECT_ID")
        location = os.getenv("GCP_LOCATION")
        model_name = os.getenv("ENTITY_EXTRACTION_MODEL_NAME", "gemini-2.5-flash")
        if project and location:
            vertexai.init(project=project, location=location)
            set_vertex_model(GenerativeModel(model_name))
            logger.info("[Startup] Vertex AI готов.")
        else:
            logger.warning("[Startup] GCP_PROJECT_ID/GCP_LOCATION не заданы; Vertex AI отключён.")
    except Exception as exc:
        logger.error("[Startup] Vertex AI init error: %s", exc, exc_info=True)


@app.on_event("startup")
async def startup_event() -> None:
    global global_http_client, nats_dispatcher

    timeout = httpx.Timeout(
        settings.HTTPX_TIMEOUT_SECONDS,
        connect=30.0,
        read=settings.HTTPX_TIMEOUT_SECONDS,
        write=settings.HTTPX_TIMEOUT_SECONDS,
        pool=30.0,
    )
    limits = httpx.Limits(max_connections=50, max_keepalive_connections=20)
    global_http_client = httpx.AsyncClient(timeout=timeout, limits=limits)
    set_http_client(global_http_client)
    logger.info("[Startup] httpx.AsyncClient инициализирован (timeout=%s)", settings.HTTPX_TIMEOUT_SECONDS)

    if settings.NATS_ENABLED:
        nats_dispatcher = NatsDispatcher()
        await nats_dispatcher.start()

    asyncio.create_task(periodically_check_primary_model())
    asyncio.create_task(context_manager.cleanup_periodically())
    logger.info("[Startup] Фоновая очистка контекстов запущена.")

    if settings.ENABLE_CONTENT_DATES_BACKFILL:
        asyncio.create_task(backfill_content_dates_on_startup())


async def backfill_content_dates_on_startup() -> None:
    """Backfill content_dates for chunks that have dates in content but empty content_dates."""
    logger.info("[Startup] content_dates backfill started (all conversations)")
    sql = text(
        """
        SELECT doc_id, chunk_id, content
        FROM chunks
        WHERE content IS NOT NULL
          AND content <> ''
          AND (
            metadata->'content_dates' IS NULL
            OR jsonb_typeof(metadata->'content_dates') <> 'array'
            OR jsonb_array_length(metadata->'content_dates') = 0
            OR NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(metadata->'content_dates') d
              WHERE btrim(d) <> ''
            )
          )
        """
    )
    update_sql = text(
        """
        UPDATE chunks
        SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{content_dates}',
            CAST(:dates AS jsonb),
            true
        )
        WHERE doc_id = :doc_id AND chunk_id = :chunk_id
        """
    )

    engine = get_engine()
    updated = 0
    try:
        with engine.begin() as conn:
            rows = conn.execute(sql).mappings().all()
            for row in rows:
                dates = extract_content_dates(row.get("content") or "")
                if not dates:
                    continue
                conn.execute(
                    update_sql,
                    {
                        "doc_id": row["doc_id"],
                        "chunk_id": row["chunk_id"],
                        "dates": json.dumps(dates),
                    },
                )
                updated += 1
        logger.info("[Startup] content_dates backfill finished, updated=%d", updated)
    except Exception as exc:
        logger.error("[Startup] content_dates backfill failed: %s", exc, exc_info=True)


@app.on_event("shutdown")
async def shutdown_event() -> None:
    global global_http_client, nats_dispatcher

    logger.info("[Shutdown] Останавливаем сервис...")

    if nats_dispatcher:
        try:
            await nats_dispatcher.stop()
        except Exception as exc:  # pragma: no cover
            logger.warning("[Shutdown] Ошибка при остановке NATS dispatcher: %s", exc)
        finally:
            nats_dispatcher = None

    await context_manager.shutdown()
    await shutdown_temporal_client()

    if global_http_client:
        try:
            await global_http_client.aclose()
        except Exception as exc:  # pragma: no cover
            logger.warning("[Shutdown] Ошибка при закрытии httpx.AsyncClient: %s", exc)
        finally:
            global_http_client = None

    await shutdown_http_client()
    await close_neo4j_driver()
    dispose_engine()
    logger.info("[Shutdown] Завершено.")


@app.get("/healthz", include_in_schema=False)
async def healthz() -> Dict[str, str]:
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat() + "Z"}


@app.get("/metrics", include_in_schema=False)
async def metrics() -> Response:
    context_stats = await context_manager.list_contexts()
    return Response(render_prometheus_metrics(context_stats=context_stats), media_type="text/plain; version=0.0.4")


@app.post("/rag/search", response_model=SearchResponse)
async def rag_search(request: SearchRequest) -> SearchResponse:
    return await search_documents(request)


@app.post("/neo4j/graph_context", response_model=GraphContextResponse)
async def graph_context(request: GraphContextRequest) -> GraphContextResponse:
    data = await fetch_graph_context(
        request.conversation_id,
        request.limit,
    )
    return GraphContextResponse(**data)


@app.post("/neo4j/set_summary")
async def set_summary(request: IngestSummaryRequest) -> Dict[str, Any]:
    """Ручное обновление summary беседы без участия Temporal."""
    summary_text = (request.summary_text or "").strip()
    if not summary_text:
        raise HTTPException(
            status_code=400,
            detail="summary_text is required for /neo4j/set_summary",
        )

    metadata: Dict[str, Any] = dict(request.metadata or {})
    if request.summary_range:
        metadata.setdefault("summary_range", request.summary_range)

    await set_conversation_summary(
        conversation_id=request.conversation_id,
        summary=summary_text,
        summary_level=request.summary_level,
        metadata=metadata or None,
    )

    return {"status": "ok"}


@app.post("/neo4j/delete_conversation")
async def delete_conversation(request: DeleteConversationRequest) -> Dict[str, Any]:
    logger.info("[Delete] Запрос на удаление беседы: conv_id=%s", request.conversation_id)
    await delete_conversation_everywhere(request.conversation_id, request.user_id)
    logger.info("[Delete] Беседа conv_id=%s удалена (graph+pg+mongo)", request.conversation_id)
    return {"status": "deleted"}


@app.post("/cypher", response_model=CypherResponse)
async def run_cypher(request: CypherRequest) -> CypherResponse:
    if is_production() and not settings.ENABLE_CYPHER_DEBUG:
        raise HTTPException(status_code=403, detail="Cypher endpoint is disabled in production")
    if request.query and FORBIDDEN_CYPHER_PATTERN.search(request.query):
        raise HTTPException(status_code=403, detail="Этот Cypher-запрос запрещён.")
    try:
        rows = await execute_cypher_query(request.query, request.parameters or {})
    except Exception as exc:
        logger.exception("[Cypher] Ошибка при выполнении запроса.")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return CypherResponse(results=rows)


@app.post("/temporal/memory/run")
async def temporal_memory_run(request: TemporalMemoryRequest) -> Dict[str, Any]:
    try:
        return await start_memory_workflow(request)
    except WorkflowAlreadyStartedError as exc:
        raise HTTPException(status_code=409, detail="MemoryWorkflow уже запущен") from exc
    except Exception as exc:
        logger.error("[Temporal] Ошибка при запуске MemoryWorkflow: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Ошибка при запуске MemoryWorkflow: {exc}") from exc


@app.post("/temporal/summary/run")
async def temporal_summary_run(request: TemporalSummaryRequest) -> Dict[str, Any]:
    if not SUMMARY_WORKFLOWS_ENABLED:
        raise HTTPException(status_code=503, detail="Summary workflows are disabled")
    try:
        return await start_summary_workflow(request)
    except WorkflowAlreadyStartedError as exc:
        raise HTTPException(status_code=409, detail="SummaryWorkflow уже запущен") from exc
    except Exception as exc:
        logger.error("[Temporal] Ошибка при запуске SummaryWorkflow: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Ошибка при запуске SummaryWorkflow: {exc}") from exc


@app.get("/status/summary")
async def summary_status(limit: int = 100) -> Dict[str, Any]:
    return {"events": list_events(limit=limit)}


def _map_event_status(raw_status: Optional[str]) -> str:
    if not raw_status:
        return "not_found"
    status = raw_status.lower()
    if status in {"started", "running"}:
        return "running"
    if status in {"already_running"}:
        return "running"
    if status in {"queued"}:
        return "queued"
    if status in {"success", "completed", "done"}:
        return "completed"
    if status in {"partial_failure"}:
        return "partial"
    if status in {"skip", "skipped"}:
        return "completed"
    if status in {"failure", "error", "temporal_error", "transport_error"}:
        return "failed"
    return status


@app.get("/tool/ingest_status/{job_id}")
async def tool_ingest_status(job_id: str) -> Dict[str, Any]:
    inc_tool_ingest_status_requests()
    def _child_status(child_id: str) -> Dict[str, Any]:
        child_events = list_events_for_job(child_id, limit=50)
        if not child_events:
            return {"status": "not_found", "events": []}
        return {
            "status": _map_event_status(child_events[-1].get("status")),
            "events": child_events,
        }

    suffixes = {":graph", ":summary", ":memory"}
    base_id = job_id
    for suffix in suffixes:
        if job_id.endswith(suffix):
            base_id = job_id[: -len(suffix)]
            break

    events = list_events_for_job(job_id, limit=200)
    children = {
        "graph": _child_status(f"{base_id}:graph"),
        "summary": _child_status(f"{base_id}:summary"),
        "memory": _child_status(f"{base_id}:memory"),
    }

    if not events:
        inc_tool_ingest_status_not_found()
        return {
            "status": "not_found",
            "job_id": job_id,
            "children": children,
            "events": [],
        }

    last_event = events[-1]
    status = _map_event_status(last_event.get("status"))
    return {
        "status": status,
        "job_id": job_id,
        "children": children,
        "events": events,
    }


@app.post("/temporal/graph/run")
async def temporal_graph_run(request: TemporalGraphRequest) -> Dict[str, Any]:
    try:
        return await start_graph_workflow(request)
    except WorkflowAlreadyStartedError as exc:
        raise HTTPException(status_code=409, detail="GraphWorkflow уже запущен") from exc
    except Exception as exc:
        logger.error("[Temporal] Ошибка при запуске GraphWorkflow: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Ошибка при запуске GraphWorkflow: {exc}") from exc


@app.post("/llm/entities/extract", response_model=EntityExtractionResponse)
async def extract_entities(request: EntityExtractionRequest) -> EntityExtractionResponse:
    """Напрямую вызываем LLM, минуя Temporal, и возвращаем сущности."""
    base_flags = request.context_flags or []
    combined_flags = await detect_context_flags(request.text or "", base_flags)

    entities, error = await call_llm(
        text=request.text,
        reasoning=request.reasoning_text,
        context_flags=combined_flags,
        conversation_id=request.conversation_id,
        message_id=request.message_id,
        user_id=request.user_id,
    )

    status = "success" if not error else "error"
    return EntityExtractionResponse(
        status=status,
        extracted_entities=entities,
        message=error,
        context_flags=combined_flags,
    )


@app.post("/ingest/message")
async def ingest_message(request: IngestMessageRequest) -> Dict[str, Any]:
    """
    Принимает сообщение из фронтенда для обработки контекстом и, возможно, запуска Graph Workflow.
    """
    logger.info("[Ingest] Получен запрос на ingest сообщения: conv_id=%s, msg_id=%s",
                request.conversation_id, request.message_id)
    
    response_data = await context_manager.ingest_message(request)
    
    logger.info("[Ingest] Завершено ingest сообщения для conv_id=%s, msg_id=%s. Ответ: %s",
                request.conversation_id, request.message_id, response_data)
    return response_data


@app.post("/ingest/summary")
async def ingest_summary(request: IngestSummaryRequest) -> Dict[str, Any]:
    """
    Принимает запрос на прием данных для суммаризации и запускает Temporal Summary Workflow.
    """
    logger.info("[Ingest] Получен запрос на ingest резюме: conv_id=%s, level=%s",
                request.conversation_id, request.summary_level)
    if not SUMMARY_WORKFLOWS_ENABLED:
        logger.info("[Ingest] Summary workflows disabled, пропускаем ingest для conv_id=%s", request.conversation_id)
        return {
            "status": "disabled",
            "summary": {
                "status": "skip",
                "reason": "summary_disabled",
            },
        }
    
    response_data = await context_manager.ingest_summary(request)
    
    logger.info("[Ingest] Завершено ingest резюме для conv_id=%s. Ответ: %s",
                request.conversation_id, response_data.get("status"))
    return response_data


@app.post("/ingest/graph")
async def ingest_graph(request: IngestGraphDataRequest) -> IngestGraphDataResponse:
    """
    Принимает готовые триплеты и напрямую пишет их в Neo4j (без Temporal).
    """
    logger.info("[Ingest] Получен запрос на ingest данных графа: conv_id=%s, msg_id=%s",
                request.conversation_id, request.message_id)

    try:
        ingested_count = await ingest_entities_neo4j(
            user_id=request.user_id,
            conversation_id=request.conversation_id,
            message_id=request.message_id,
            entities=request.extracted_entities,
            created_at=request.created_at,
            text_content=request.text_content,
            reasoning_text=request.reasoning_text,
            context_flags=request.context_flags or [],
            relation_fallback_type=RELATION_FALLBACK_TYPE,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "[Ingest] Ошибка при записи графа (conv_id=%s, msg_id=%s): %s",
            request.conversation_id,
            request.message_id,
            exc,
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail="Не удалось сохранить данные графа") from exc

    logger.info("[Ingest] Завершено ingest данных графа для conv_id=%s, msg_id=%s. ingested=%d",
                request.conversation_id, request.message_id, ingested_count)

    return IngestGraphDataResponse(status="success", ingested_count=ingested_count)


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, len(text) // 4)


def _compute_budget_hint(model_limit: Optional[int], chunks: List[Chunk]) -> ToolBudgetHint:
    context_tokens = 0
    for chunk in chunks:
        meta = chunk.metadata
        context_tokens += _estimate_tokens(chunk.content or "")

    if model_limit is None:
        recommended_output_tokens = 2000
    elif model_limit >= 64000:
        recommended_output_tokens = 4000
    elif model_limit >= 16000:
        recommended_output_tokens = 2000
    else:
        recommended_output_tokens = 1000

    return ToolBudgetHint(
        context_tokens=context_tokens,
        recommended_output_tokens=recommended_output_tokens,
    )


def _build_short_context(recent_messages: Optional[List[ToolRecentMessage]]) -> Optional[str]:
    if not recent_messages:
        return None
    lines = []
    for message in recent_messages:
        role = message.role
        content = (message.content or "").strip()
        if not content:
            continue
        lines.append(f"{role}: {content}")
    return "\n".join(lines) if lines else None


def _build_ingest_base_id(request: ToolSubmitIngestRequest) -> str:
    if request.idempotency_key:
        return f"ingest:{request.chat_id}:{request.idempotency_key}"
    if request.message_id:
        return f"ingest:{request.chat_id}:msg:{request.message_id}"
    return f"ingest:{request.chat_id}:ts:{int(datetime.utcnow().timestamp())}"


def _ensure_source_context(request: ToolSubmitIngestRequest) -> bool:
    if request.chat_id and request.message_id:
        return True
    if request.source_system and request.source_chat_id and (request.source_message_id or request.content):
        return True
    return False


@app.post("/tool/search_context", response_model=ToolSearchContextResponse)
async def tool_search_context(request: ToolSearchContextRequest) -> ToolSearchContextResponse:
    inc_tool_search_context_requests()
    logger.info(
        "[ToolSearch] Request received (chat_id=%s, message_id=%s, user_id=%s)",
        request.chat_id,
        request.message_id,
        request.user_id,
    )
    filters = request.filters or ToolSearchFilters()
    content_types = filters.content_types or []
    if len(content_types) > 1:
        inc_tool_search_context_failures()
        raise HTTPException(status_code=400, detail="filters.content_types supports only one value in MVP")

    date_filter = None
    if filters.date_from or filters.date_to:
        date_filter = {
            "from": filters.date_from,
            "to": filters.date_to,
        }

    search_request = SearchRequest(
        query=request.query,
        conversation_id=request.chat_id,
        user_id=request.user_id,
        top_k=10,
        include_graph=bool(request.include_graph),
        roles=filters.roles,
        content_type=content_types[0] if content_types else None,
        date_filter=date_filter,
    )

    try:
        search_response = await search_documents(search_request)
    except Exception:
        inc_tool_search_context_failures()
        raise

    context_pack = ToolContextPack(
        short_context=_build_short_context(request.recent_messages),
        retrieved_chunks=search_response.results,
        graph_context=search_response.graph_context,
        summaries=[],
        sources=[],
        budget_hint=_compute_budget_hint(request.model_token_limit, search_response.results),
    )

    return ToolSearchContextResponse(status="ok", context_pack=context_pack)


@app.post("/tool/submit_ingest", response_model=ToolSubmitIngestResponse)
async def tool_submit_ingest(request: ToolSubmitIngestRequest) -> ToolSubmitIngestResponse:
    inc_tool_submit_ingest_requests()
    logger.info(
        "[ToolIngest] Request received (chat_id=%s, message_id=%s, user_id=%s, profile=%s)",
        request.chat_id,
        request.message_id,
        request.user_id,
        request.ingest_profile,
    )
    if not (request.content or request.message_id):
        inc_tool_submit_ingest_failures()
        raise HTTPException(status_code=400, detail="Either content or message_id is required")

    if not _ensure_source_context(request):
        inc_tool_submit_ingest_failures()
        raise HTTPException(status_code=400, detail="Insufficient source context for ingest")

    ingest_profile = request.ingest_profile or "full"
    base_id = _build_ingest_base_id(request)

    if ingest_profile not in {"graph_only", "summary_only", "memory_only", "full"}:
        inc_tool_submit_ingest_failures()
        raise HTTPException(status_code=400, detail="Invalid ingest_profile")

    inc_tool_submit_ingest_profile(ingest_profile)

    metadata_payload: Dict[str, Any] = dict(request.metadata or {})
    metadata_payload.setdefault("source_system", request.source_system)
    metadata_payload.setdefault("source_chat_id", request.source_chat_id or request.chat_id)
    metadata_payload.setdefault("source_message_id", request.source_message_id or request.message_id)
    metadata_payload.setdefault("source_user_id", request.source_user_id)
    metadata_payload.setdefault("workspace_id", request.workspace_id)
    if request.chat_id:
        metadata_payload.setdefault("chat_id", request.chat_id)
    if request.message_id:
        metadata_payload.setdefault("message_id", request.message_id)

    user_id = request.user_id
    role = request.role

    if request.message_id and (user_id is None or role is None):
        try:
            anchor_messages = await fetch_messages_window_by_message_id(request.chat_id, request.message_id, limit=1)
            if anchor_messages:
                anchor = anchor_messages[-1]
                user_id = user_id or anchor.get("user_id")
                role = role or anchor.get("role")
        except Exception as exc:
            logger.warning("[ToolIngest] Failed to fetch anchor message (conv=%s, msg=%s): %s",
                           request.chat_id, request.message_id, exc)

    role = role or "user"

    response_status = "queued"
    graph_status = None
    summary_status = None
    memory_status = None

    if ingest_profile in {"graph_only", "full"}:
        graph_req = TemporalGraphRequest(
            user_id=user_id,
            conversation_id=request.chat_id,
            message_id=request.message_id or base_id,
            content=request.content or "",
            created_at=datetime.utcnow().isoformat(),
            reasoning_text=None,
            context_flags=[],
            metadata=metadata_payload or None,
        )
        graph_status = await start_graph_workflow(graph_req, base_workflow_id=f"{base_id}:graph")
        add_event(
            {
                "service": "tools-gateway",
                "workflow": "graph",
                "workflow_id": f"{base_id}:graph",
                "status": graph_status.get("status"),
                "conversation_id": request.chat_id,
                "message_id": request.message_id,
                "user_id": user_id,
            }
        )

    if ingest_profile in {"summary_only", "full"}:
        messages: List[MessageForSummary] = []
        if request.message_id:
            try:
                docs = await fetch_messages_window_by_message_id(request.chat_id, request.message_id, limit=10)
                messages = [
                    MessageForSummary(
                        role=doc.get("role") or role,
                        content=doc.get("content") or "",
                        message_id=doc.get("message_id") or request.message_id,
                        created_at=doc.get("created_at"),
                    )
                    for doc in docs
                ]
            except Exception as exc:
                logger.warning("[ToolIngest] Summary fetch by anchor failed (conv=%s, msg=%s): %s",
                               request.chat_id, request.message_id, exc)

        if not messages:
            docs = await fetch_messages(request.chat_id, limit=10, order="desc")
            messages = [
                MessageForSummary(
                    role=doc.get("role") or role,
                    content=doc.get("content") or "",
                    message_id=doc.get("message_id") or request.message_id or base_id,
                    created_at=doc.get("created_at"),
                )
                for doc in docs
            ]

        if not messages and request.content:
            messages = [
                MessageForSummary(
                    role=role,
                    content=request.content,
                    message_id=request.message_id or base_id,
                    created_at=datetime.utcnow().isoformat(),
                )
            ]

        if messages:
            start_message_id = messages[0].message_id
            end_message_id = messages[-1].message_id
        else:
            start_message_id = request.message_id or base_id
            end_message_id = request.message_id or base_id

        summary_req = TemporalSummaryRequest(
            user_id=user_id,
            conversation_id=request.chat_id,
            messages=messages,
            start_message_id=start_message_id,
            end_message_id=end_message_id,
            summary_level="batch",
            summary_model=None,
            summary_range={"start_message_id": start_message_id, "end_message_id": end_message_id},
            metadata=metadata_payload or None,
        )
        summary_status = await start_summary_workflow(summary_req, base_workflow_id=f"{base_id}:summary")
        add_event(
            {
                "service": "tools-gateway",
                "workflow": "summary",
                "workflow_id": f"{base_id}:summary",
                "status": summary_status.get("status"),
                "conversation_id": request.chat_id,
                "message_id": request.message_id,
                "user_id": user_id,
            }
        )

    if ingest_profile in {"memory_only", "full"}:
        memory_req = TemporalMemoryRequest(
            user_id=user_id,
            conversation_id=request.chat_id,
            message_id=request.message_id or base_id,
            role=role,
            content=request.content or "",
            created_at=datetime.utcnow().isoformat(),
            reasoning_text=None,
            context_flags=[],
        )
        memory_status = await context_manager.ingest_memory(
            memory_req,
            workflow_base_id=f"{base_id}:memory",
        )
        add_event(
            {
                "service": "tools-gateway",
                "workflow": "memory",
                "workflow_id": f"{base_id}:memory",
                "status": memory_status.get("status") if isinstance(memory_status, dict) else None,
                "conversation_id": request.chat_id,
                "message_id": request.message_id,
                "user_id": user_id,
            }
        )

    job_id = f"{base_id}:graph" if ingest_profile == "full" else {
        "graph_only": f"{base_id}:graph",
        "summary_only": f"{base_id}:summary",
        "memory_only": f"{base_id}:memory",
    }.get(ingest_profile, f"{base_id}:graph")

    response = ToolSubmitIngestResponse(
        status=response_status,
        job_id=job_id,
        ingest_profile=ingest_profile,
    )
    inc_tool_submit_ingest_status(response_status)
    return response
