from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime, time
from typing import Any, Dict, List, Optional

from neo4j.exceptions import Neo4jError

from core.clients import get_neo4j_driver
from core.config import settings
from models.pydantic_models import ExtractedEntity
# NOTE: Логика нормализации сущностей и fallback-типов синхронизируется
# с tools-gateway/services/llm.py. При изменении схемы нужно обновлять оба файла.


logger = logging.getLogger("tools-gateway.neo4j")

GRAPH_CONTEXT_CYPHER = """
MATCH (s:Entity {conversation_id: $conv})-[r]->(o:Entity {conversation_id: $conv})
RETURN
  s.name AS subject,
  s.type AS subject_type,
  type(r) AS relation,
  r.original_relation AS original_relation,
  o.name AS object,
  o.type AS object_type,
  r.source_message_id AS source_message_id,
  r.updatedAt AS updated_at
ORDER BY r.updatedAt DESC
LIMIT $limit
"""


def _sanitize_cypher_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()

    cls_name = value.__class__.__name__
    if cls_name == "Node":
        props = {str(k): _sanitize_cypher_value(v) for k, v in dict(value).items()}
        labels = sorted(list(getattr(value, "labels", [])))
        node_id = getattr(value, "id", None)
        return {"id": node_id, "labels": labels, "properties": props}

    if cls_name == "Relationship":
        props = {str(k): _sanitize_cypher_value(v) for k, v in dict(value).items()}
        rel_id = getattr(value, "id", None)
        rel_type = getattr(value, "type", None)
        start_node = _sanitize_cypher_value(getattr(value, "start_node", None))
        end_node = _sanitize_cypher_value(getattr(value, "end_node", None))
        return {
            "id": rel_id,
            "type": rel_type,
            "start": start_node,
            "end": end_node,
            "properties": props,
        }

    if cls_name == "Path":
        nodes = [_sanitize_cypher_value(n) for n in getattr(value, "nodes", [])]
        rels = [_sanitize_cypher_value(r) for r in getattr(value, "relationships", [])]
        return {"nodes": nodes, "relationships": rels}

    if hasattr(value, "items"):
        return {str(k): _sanitize_cypher_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_sanitize_cypher_value(v) for v in value]
    if hasattr(value, "__iter__") and not isinstance(value, (str, bytes)):
        try:
            return [_sanitize_cypher_value(v) for v in value]
        except TypeError:
            pass
    return str(value)


def _format_graph_context(records: List[dict]) -> Dict[str, Any]:
    lines: List[str] = []
    entities: set[str] = set()
    relation_snippets: List[str] = []

    for record in records:
        subject = (record.get("subject") or "").strip()
        obj = (record.get("object") or "").strip()
        relation = (record.get("relation") or "").strip()
        original = (record.get("original_relation") or "").strip()
        subject_type = (record.get("subject_type") or "").strip()
        object_type = (record.get("object_type") or "").strip()
        source_message_id = (record.get("source_message_id") or "").strip()

        if not subject or not obj or not relation:
            continue

        subject_label = f"{subject} ({subject_type})" if subject_type else subject
        object_label = f"{obj} ({object_type})" if object_type else obj
        relation_label = relation or original or "RELATED_TO"

        details: List[str] = []
        if original and original != relation:
            details.append(f"original: {original}")
        if source_message_id:
            details.append(f"message: {source_message_id}")

        suffix = f" ({', '.join(details)})" if details else ""
        lines.append(f"• {subject_label} --{relation_label}--> {object_label}{suffix}")

        entities.add(subject)
        entities.add(obj)
        relation_snippets.append(f"{subject} {relation_label} {obj}")

        if len(lines) >= settings.GRAPH_CONTEXT_LINE_LIMIT:
            break

    if not lines:
        return {"lines": [], "query_hint": None}

    entities_text = ", ".join(sorted(entities))
    relations_text = "; ".join(relation_snippets[: settings.GRAPH_CONTEXT_LINE_LIMIT])
    hint = f"Entities: {entities_text}. Relations: {relations_text}".strip()

    if hint and len(hint) > settings.GRAPH_CONTEXT_HINT_MAX_CHARS:
        hint = hint[: settings.GRAPH_CONTEXT_HINT_MAX_CHARS].rstrip() + "…"

    return {"lines": lines, "query_hint": hint or None}


def _fetch_graph_context_sync(conversation_id: str, limit: int) -> Dict[str, Any]:
    driver = get_neo4j_driver()
    try:
        with driver.session() as session:
            # 1. Fetch graph relations
            result = session.run(GRAPH_CONTEXT_CYPHER, conv=conversation_id, limit=limit)
            records = [record.data() for record in result]

            # 2. Fetch conversation summary
            summary_result = session.run(
                "MATCH (c:Conversation {conversation_id: $conv}) RETURN c.summary AS summary",
                conv=conversation_id,
            )
            summary_record = summary_result.single()
            summary = summary_record["summary"] if summary_record else None

    except Neo4jError as exc:
        logger.exception("[Neo4j] Ошибка выборки графового контекста (conv=%s): %s", conversation_id, exc)
        raise RuntimeError("Не удалось получить графовый контекст") from exc

    context = _format_graph_context(records)
    context["summary"] = summary
    return context


async def fetch_graph_context(conversation_id: str, limit: Optional[int] = None) -> Dict[str, Any]:
    safe_limit = limit or settings.GRAPH_CONTEXT_RELATION_LIMIT
    safe_limit = max(1, min(safe_limit, settings.GRAPH_CONTEXT_RELATION_LIMIT))
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _fetch_graph_context_sync, conversation_id, safe_limit)


def _sanitize_summary_metadata(metadata: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if metadata is None:
        return None

    def _convert(value: Any) -> Any:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, (datetime, date, time)):
            return value.isoformat()
        if isinstance(value, dict):
            return {str(k): _convert(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_convert(v) for v in value]
        return str(value)

    return _convert(metadata)


def _set_conversation_summary_sync(
    conversation_id: str,
    summary: str,
    summary_level: str = "batch",
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    driver = get_neo4j_driver()
    safe_metadata = _sanitize_summary_metadata(metadata)
    metadata_json = (
        json.dumps(safe_metadata, ensure_ascii=False) if safe_metadata is not None else None
    )
    timestamp = datetime.utcnow().isoformat()

    try:
        with driver.session() as session:
            session.run(
                """
                MERGE (c:Conversation {conversation_id: $id})
                SET
                    c.id = coalesce(c.id, $id),
                    c.summary = $summary,
                    c.summary_level = $summary_level,
                    c.summary_metadata = $metadata_json,
                    c.summaryUpdatedAt = datetime($updated_at)
                """,
                id=conversation_id,
                summary=summary,
                summary_level=summary_level,
                metadata_json=metadata_json,
                updated_at=timestamp,
            ).consume()
    except Neo4jError as exc:
        logger.exception("[Neo4j] Ошибка обновления summary (conv=%s): %s", conversation_id, exc)
        raise RuntimeError("Не удалось сохранить summary в графе") from exc
    else:
        logger.info(
            "[Neo4j] Summary обновлён (conv=%s, level=%s, metadata=%s)",
            conversation_id,
            summary_level,
            metadata_json or "{}",
        )
async def set_conversation_summary(
    conversation_id: str,
    summary: str,
    *,
    summary_level: str = "batch",
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(
        None,
        _set_conversation_summary_sync,
        conversation_id,
        summary,
        summary_level,
        metadata,
    )


def _delete_conversation_sync(conversation_id: str) -> None:
    driver = get_neo4j_driver()
    try:
        with driver.session() as session:
            session.run(
                """
                MATCH (c:Conversation {conversation_id: $id})
                OPTIONAL MATCH (c)-[*0..]->(n)
                DETACH DELETE c, n
                """,
                id=conversation_id,
            ).consume()
    except Neo4jError as exc:
        logger.exception("[Neo4j] Ошибка удаления беседы %s: %s", conversation_id, exc)
        raise RuntimeError("Не удалось удалить данные беседы из графа") from exc
    else:
        logger.info("[Neo4j] Беседа %s и связанная структура удалены.", conversation_id)


async def delete_conversation(conversation_id: str) -> None:
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _delete_conversation_sync, conversation_id)


def _execute_cypher_sync(statement: str, params: Optional[dict]) -> List[dict]:
    driver = get_neo4j_driver()
    try:
        with driver.session() as session:
            result = session.run(statement, params or {})
            raw_records = [record.data() for record in result]
    except Neo4jError as exc:
        logger.exception("[Neo4j] Ошибка выполнения Cypher: %s", exc)
        raise RuntimeError("Не удалось выполнить запрос к графу") from exc

    sanitized = [_sanitize_cypher_value(record) for record in raw_records]
    logger.info("[Neo4j] Выполнен Cypher-запрос (строк: %d).", len(sanitized))
    return sanitized


async def execute_cypher_query(statement: str, params: Optional[dict]) -> List[dict]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _execute_cypher_sync, statement, params)


def _ingest_entities_sync(
    user_id: str,
    conversation_id: str,
    message_id: str,
    entities: List[ExtractedEntity],
    created_at: str,
    text_content: str,
    reasoning_text: Optional[str],
    context_flags: Optional[List[str]],
    relation_fallback_type: str,
) -> int:
    if not entities and not reasoning_text:
        logger.info("[Neo4j] Сообщение %s: нет данных для записи.", message_id)
        return 0

    driver = get_neo4j_driver()
    ingested = 0
    timestamp = created_at or datetime.utcnow().isoformat()

    try:
        with driver.session() as session:
            with session.begin_transaction() as tx:
                tx.run(
                    """
                    MERGE (u:User {id: $user_id})
                    ON CREATE SET u.createdAt = datetime($created_at)
                    SET u.updatedAt = datetime()
                    """,
                    user_id=user_id,
                    created_at=timestamp,
                )
                tx.run(
                    """
                    MERGE (c:Conversation {conversation_id: $conversation_id})
                    ON CREATE SET
                        c.id = $conversation_id,
                        c.createdAt = datetime($created_at)
                    SET
                        c.updatedAt = datetime()
                    """,
                    conversation_id=conversation_id,
                    created_at=timestamp,
                )
                tx.run(
                    """
                    MATCH (u:User {id: $user_id})
                    MATCH (c:Conversation {conversation_id: $conversation_id})
                    MERGE (u)-[:HAS_CONVERSATION]->(c)
                    """,
                    user_id=user_id,
                    conversation_id=conversation_id,
                )
                tx.run(
                    """
                    MERGE (m:Message {id: $message_id})
                    ON CREATE SET
                        m.createdAt = datetime($created_at),
                        m.rawContent = $content,
                        m.source_user_id = $user_id,
                        m.conversationId = $conversation_id
                    SET
                        m.updatedAt = datetime(),
                        m.rawContent = $content
                    """,
                    message_id=message_id,
                    created_at=timestamp,
                    content=text_content,
                    user_id=user_id,
                    conversation_id=conversation_id,
                )
                tx.run(
                    """
                    MATCH (c:Conversation {conversation_id: $conversation_id})
                    MATCH (m:Message {id: $message_id})
                    MERGE (c)-[:CONTAINS_MESSAGE]->(m)
                    """,
                    conversation_id=conversation_id,
                    message_id=message_id,
                )

                if context_flags:
                    tx.run(
                        """
                        MATCH (m:Message {id: $message_id})
                        SET m.contextFlags = $flags
                        """,
                        message_id=message_id,
                        flags=context_flags,
                    )

                if reasoning_text:
                    tx.run(
                        """
                        MERGE (r:Reasoning {message_id: $message_id})
                        ON CREATE SET
                            r.createdAt = datetime($created_at),
                            r.content = $reasoning
                        SET r.updatedAt = datetime(), r.content = $reasoning
                        MERGE (m:Message {id: $message_id})
                        MERGE (m)-[:HAS_REASONING]->(r)
                        """,
                        message_id=message_id,
                        created_at=timestamp,
                        reasoning=reasoning_text,
                    )

                for entity in entities:
                    relation_type_raw = entity.relation or relation_fallback_type
                    relation_type = relation_type_raw.replace(" ", "_").upper()
                    relation_type = relation_type.encode("ascii", "ignore").decode("ascii")
                    relation_type = relation_type or relation_fallback_type
                    relation_type = relation_type[:64]

                    subject_TYPE = entity.subject_type or "Unknown"
                    object_TYPE = entity.object_type or "Unknown"

                    tx.run(
                        """
                        MERGE (subj:Entity {conversation_id: $conversation_id, name: $subject})
                        ON CREATE SET
                            subj.createdAt = datetime($created_at),
                            subj.type = $subject_type,
                            subj.source_user_id = $user_id,
                            subj.source_message_id = $message_id
                        SET
                            subj.updatedAt = datetime(),
                            subj.type = COALESCE(subj.type, $subject_type)
                        """,
                        conversation_id=conversation_id,
                        subject=entity.subject,
                        created_at=timestamp,
                        subject_type=subject_TYPE,
                        user_id=user_id,
                        message_id=message_id,
                    )
                    tx.run(
                        """
                        MERGE (obj:Entity {conversation_id: $conversation_id, name: $object})
                        ON CREATE SET
                            obj.createdAt = datetime($created_at),
                            obj.type = $object_type,
                            obj.source_user_id = $user_id,
                            obj.source_message_id = $message_id
                        SET
                            obj.updatedAt = datetime(),
                            obj.type = COALESCE(obj.type, $object_type)
                        """,
                        conversation_id=conversation_id,
                        object=entity.object,
                        created_at=timestamp,
                        object_type=object_TYPE,
                        user_id=user_id,
                        message_id=message_id,
                    )

                    relation_props = {
                        "source_message_id": message_id,
                        "source_conversation_id": conversation_id,
                        "conversation_id": conversation_id,
                        "source_user_id": user_id,
                        "createdAt": timestamp,
                        "updatedAt": datetime.utcnow().isoformat(),
                        "source_chunk_id": message_id,  # Using message_id as chunk_id fallback
                    }
                    if entity.original_relation:
                        relation_props["original_relation"] = entity.original_relation
                    if entity.relation_properties:
                        for key, value in entity.relation_properties.items():
                            if isinstance(value, (dict, list)):
                                relation_props[f"json_{key}"] = json.dumps(value, ensure_ascii=False)
                            else:
                                relation_props[key] = value

                    merge_query = (
                        "MATCH (s:Entity {conversation_id: $conversation_id, name: $subject})\n"
                        "MATCH (o:Entity {conversation_id: $conversation_id, name: $object})\n"
                        f"MERGE (s)-[rel:`{relation_type}`]->(o)\n"
                        "SET rel += $props"
                    )

                    tx.run(
                        merge_query,
                        conversation_id=conversation_id,
                        subject=entity.subject,
                        object=entity.object,
                        props=relation_props,
                    )

                    tx.run(
                        """
                        MATCH (m:Message {id: $message_id})
                        MATCH (e:Entity {conversation_id: $conversation_id, name: $entity_name})
                        MERGE (m)-[:MENTIONS {role: $role}]->(e)
                        """,
                        message_id=message_id,
                        conversation_id=conversation_id,
                        entity_name=entity.subject,
                        role="subject",
                    )
                    tx.run(
                        """
                        MATCH (m:Message {id: $message_id})
                        MATCH (e:Entity {conversation_id: $conversation_id, name: $entity_name})
                        MERGE (m)-[:MENTIONS {role: $role}]->(e)
                        """,
                        message_id=message_id,
                        conversation_id=conversation_id,
                        entity_name=entity.object,
                        role="object",
                    )
                    ingested += 1

                tx.commit()
    except Neo4jError as exc:
        logger.exception("[Neo4j] Ошибка записи message=%s: %s", message_id, exc)
        raise RuntimeError("Не удалось сохранить данные в граф") from exc

    logger.info(
        "[Neo4j] Сохранено %d отношений (message=%s, conversation=%s).",
        ingested,
        message_id,
        conversation_id,
    )
    return ingested


async def ingest_entities_neo4j(
    user_id: str,
    conversation_id: str,
    message_id: str,
    entities: List[ExtractedEntity],
    created_at: str,
    text_content: str,
    reasoning_text: Optional[str],
    context_flags: Optional[List[str]],
    relation_fallback_type: str,
) -> int:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None,
        _ingest_entities_sync,
        user_id,
        conversation_id,
        message_id,
        entities,
        created_at,
        text_content,
        reasoning_text,
        context_flags,
        relation_fallback_type,
    )
