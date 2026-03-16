"""Асинхронный доступ к коллекциям LibreChat (messages, conversation_summaries).

Файл выполняет роль thin repository-слоя для:
- чтения последних сообщений беседы (коллекция MONGO_MESSAGES_COLLECTION);
- хранения и чтения агрегированных суммаризаций (коллекция MONGO_SUMMARIES_COLLECTION).

Структура документа в ``conversation_summaries`` согласована с командой LibreChat::

    {
        "conversation_id": str,
        "user_id": str,
        "summary_level": "batch" | "rolling" | "hierarchical_level_X",
        "messages_range": {"start_index": int, "end_index": int},
        "start_message_id": Optional[str],
        "end_message_id": Optional[str],
        "summary_text": str,
        "source_model": str,
        "created_at": datetime (UTC),
        "updated_at": datetime (UTC),
        "extra": Optional[dict]
    }

Рекомендуемые индексы (не создаются автоматически кодом):
    * ``conversation_id`` (single field);
    * составной ``conversation_id`` + ``created_at`` (DESC) для быстрых выборок;
    * по необходимости — уникальный составной индекс на
      ``conversation_id`` + ``messages_range.start_index`` + ``messages_range.end_index``.

Команде LibreChat необходимо добавить модель ``ConversationSummary`` в
``api/models/ConversationSummary.js`` и подключить её в общий реестр моделей.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence

from motor.motor_asyncio import AsyncIOMotorCollection
from pymongo import ASCENDING, DESCENDING

from core.clients import get_mongo_database
from core.config import settings

logger = logging.getLogger("tools-gateway.mongo.repository")


def _candidate_conversation_fields() -> List[str]:
    configured = settings.SUMMARY_MESSAGES_CONVERSATION_FIELD or "conversationId"

    def to_camel_case(value: str) -> str:
        parts = value.split("_")
        if len(parts) == 1:
            return value
        return parts[0] + "".join(part.capitalize() for part in parts[1:])

    def to_snake_case(value: str) -> str:
        result: List[str] = []
        for char in value:
            if char.isupper():
                result.append("_")
                result.append(char.lower())
            else:
                result.append(char)
        return "".join(result).lstrip("_")

    candidates = [
        configured,
        to_camel_case(configured),
        to_snake_case(configured),
        "conversationId",
        "conversation_id",
    ]
    unique: List[str] = []
    for item in candidates:
        if item and item not in unique:
            unique.append(item)
    return unique


def _build_conversation_filter(conversation_id: str) -> Dict[str, Any]:
    return {"$or": [{field: conversation_id} for field in _candidate_conversation_fields()]}


def _candidate_message_id_fields() -> List[str]:
    configured = settings.SUMMARY_MESSAGES_ID_FIELD or "message_id"
    candidates = [
        configured,
        "message_id",
        "messageId",
        "_id",
    ]
    unique: List[str] = []
    for item in candidates:
        if item and item not in unique:
            unique.append(item)
    return unique


def _build_message_id_filter(message_id: str) -> Dict[str, Any]:
    return {"$or": [{field: message_id} for field in _candidate_message_id_fields()]}


def _candidate_role_fields() -> List[str]:
    configured = settings.SUMMARY_MESSAGES_ROLE_FIELD or "role"

    def to_camel_case(value: str) -> str:
        parts = value.split("_")
        if len(parts) == 1:
            return value
        return parts[0] + "".join(part.capitalize() for part in parts[1:])

    def to_snake_case(value: str) -> str:
        result: List[str] = []
        for char in value:
            if char.isupper():
                result.append("_")
                result.append(char.lower())
            else:
                result.append(char)
        return "".join(result).lstrip("_")

    candidates = [
        configured,
        to_camel_case(configured),
        to_snake_case(configured),
        "sender",
        "author",
        "role",
    ]
    unique: List[str] = []
    for item in candidates:
        if item and item not in unique:
            unique.append(item)
    return unique


def _map_role_value(raw_role: Optional[str]) -> str:
    if not raw_role:
        return "user"
    value = str(raw_role).strip().lower()
    mapping = {
        "user": "user",
        "customer": "user",
        "client": "user",
        "assistant": "assistant",
        "model": "assistant",
        "bot": "assistant",
        "system": "system",
        "tool": "tool",
        "function": "tool",
    }
    return mapping.get(value, value or "user")


def _candidate_content_fields() -> List[str]:
    configured = settings.SUMMARY_MESSAGES_CONTENT_FIELD or "content"
    candidates = [
        configured,
        "text",
        "content",
        "message",
        "body",
        "raw_content",
    ]
    unique: List[str] = []
    for item in candidates:
        if item and item not in unique:
            unique.append(item)
    return unique


def _candidate_created_fields() -> List[str]:
    configured = settings.SUMMARY_MESSAGES_CREATED_AT_FIELD or "created_at"
    candidates = [
        configured,
        "createdAt",
        "created_at",
        "created",
        "timestamp",
    ]
    unique: List[str] = []
    for item in candidates:
        if item and item not in unique:
            unique.append(item)
    return unique


def _normalize_timestamp(value: Any) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:  # noqa: BLE001
            return str(value)
    if isinstance(value, (int, float)):
        try:
            return datetime.utcfromtimestamp(value).isoformat(timespec="seconds") + "Z"
        except Exception:  # noqa: BLE001
            return str(value)
    return str(value)


async def _get_messages_collection() -> AsyncIOMotorCollection:
    db = await get_mongo_database()
    return db[settings.MONGO_MESSAGES_COLLECTION]


async def _get_summaries_collection() -> AsyncIOMotorCollection:
    db = await get_mongo_database()
    return db[settings.MONGO_SUMMARIES_COLLECTION]


def _extract_message_content(doc: Dict[str, Any]) -> Optional[str]:
    # try simple fields first
    for field in _candidate_content_fields():
        val = doc.get(field)
        if isinstance(val, str) and val.strip():
            return val.strip()

    # LibreChat stores blocks in content (array)
    blocks = doc.get("content")
    if isinstance(blocks, list):
        fragments: List[str] = []
        for block in blocks:
            if not isinstance(block, dict):
                continue
            block_type = str(block.get("type") or "").lower()
            if block_type not in ("text", "message"):
                continue
            text = block.get("text")
            if isinstance(text, str) and text.strip():
                fragments.append(text.strip())
        if fragments:
            return "\n".join(fragments)

    return None


def _serialize_message_document(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Укладываем документ Mongo в унифицированную структуру для суммаризации."""
    message_id_field = settings.SUMMARY_MESSAGES_ID_FIELD

    message_id = doc.get(message_id_field) or doc.get("_id")

    created_at_iso = None
    for field in _candidate_created_fields():
        if field in doc:
            created_at_iso = _normalize_timestamp(doc.get(field))
            if created_at_iso:
                break

    role_value = None
    for field in _candidate_role_fields():
        if field in doc:
            role_value = doc.get(field)
            if role_value is not None:
                break

    content_value = _extract_message_content(doc)

    if content_value is None:
        logger.warning(
            "[MongoRepo] Пропущен текст сообщения (message_id=%s, fields=%s)",
            message_id,
            _candidate_content_fields(),
        )

    return {
        "message_id": str(message_id) if message_id is not None else None,
        "role": _map_role_value(role_value),
        "content": content_value or "",
        "created_at": created_at_iso,
        "user_id": doc.get("user_id") or doc.get("userId"),
    }


async def fetch_messages_window_by_message_id(
    conversation_id: str,
    message_id: str,
    limit: int,
) -> List[Dict[str, Any]]:
    """
    Возвращает окно последних N сообщений до/включая anchor message_id.
    Основано на created_at якоре (если найден), иначе fallback на последние N.
    """
    if limit <= 0:
        return []

    collection = await _get_messages_collection()
    convo_filter = _build_conversation_filter(conversation_id)
    anchor_filter = {**convo_filter, **_build_message_id_filter(message_id)}

    projection = {
        settings.SUMMARY_MESSAGES_ID_FIELD: 1,
        settings.SUMMARY_MESSAGES_ROLE_FIELD: 1,
        settings.SUMMARY_MESSAGES_CONTENT_FIELD: 1,
        settings.SUMMARY_MESSAGES_CREATED_AT_FIELD: 1,
        "content": 1,
        "text": 1,
        "sender": 1,
        "createdAt": 1,
        "message": 1,
        "user_id": 1,
        "userId": 1,
    }

    anchor_doc = await collection.find_one(anchor_filter, projection)
    if not anchor_doc:
        logger.warning(
            "[MongoRepo] Anchor message not found (conv=%s, message_id=%s), fallback to latest N",
            conversation_id,
            message_id,
        )
        return await fetch_messages(conversation_id, limit=limit, order="desc")

    anchor_created = None
    for field in _candidate_created_fields():
        if field in anchor_doc:
            anchor_created = anchor_doc.get(field)
            if anchor_created is not None:
                break

    if anchor_created is None:
        logger.warning(
            "[MongoRepo] Anchor message missing created_at (conv=%s, message_id=%s), fallback to latest N",
            conversation_id,
            message_id,
        )
        return await fetch_messages(conversation_id, limit=limit, order="desc")

    created_field = settings.SUMMARY_MESSAGES_CREATED_AT_FIELD
    window_filter = {
        **convo_filter,
        created_field: {"$lte": anchor_created},
    }

    cursor = (
        collection.find(window_filter, projection)
        .sort(created_field, DESCENDING)
        .limit(limit)
    )
    documents = [_serialize_message_document(doc) async for doc in cursor]
    documents.reverse()
    logger.info(
        "[MongoRepo] Загружено %d сообщений по anchor (conv=%s, message_id=%s)",
        len(documents),
        conversation_id,
        message_id,
    )
    return documents


async def fetch_messages(
    conversation_id: str,
    limit: int,
    order: str = "asc",
    roles: Optional[Sequence[str]] = None,
) -> List[Dict[str, Any]]:
    """Загружает последние *limit* сообщений беседы."""
    if limit <= 0:
        return []

    collection = await _get_messages_collection()
    sort_order = ASCENDING if order.lower() == "asc" else DESCENDING

    filter_doc: Dict[str, Any] = _build_conversation_filter(conversation_id)
    if roles:
        filter_doc[settings.SUMMARY_MESSAGES_ROLE_FIELD] = {"$in": list(roles)}

    projection = {
        settings.SUMMARY_MESSAGES_ID_FIELD: 1,
        settings.SUMMARY_MESSAGES_ROLE_FIELD: 1,
        settings.SUMMARY_MESSAGES_CONTENT_FIELD: 1,
        settings.SUMMARY_MESSAGES_CREATED_AT_FIELD: 1,
        "content": 1,
        "text": 1,
        "sender": 1,
        "createdAt": 1,
        "message": 1,
    }

    cursor = (
        collection.find(filter_doc, projection)
        .sort(settings.SUMMARY_MESSAGES_CREATED_AT_FIELD, sort_order)
        .limit(limit)
    )

    documents = [_serialize_message_document(doc) async for doc in cursor]

    if order.lower() == "desc":
        documents.reverse()

    logger.info(
        "[MongoRepo] Загружено %d сообщений для беседы %s (roles=%s, order=%s)",
        len(documents),
        conversation_id,
        roles,
        order,
    )

    return documents


async def save_conversation_summary(
    conversation_id: str,
    user_id: str,
    summary_level: str,
    summary_text: str,
    messages_range: Dict[str, Any],
    summary_model: Optional[str],
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    collection = await _get_summaries_collection()
    now = datetime.utcnow()

    doc = {
        "conversation_id": conversation_id,
        "user_id": user_id,
        "summary_level": summary_level,
        "summary_text": summary_text,
        "messages_range": messages_range,
        "source_model": summary_model,
        "extra": extra,
        "updated_at": now,
    }

    logger.info(
        "[MongoRepo] Сохраняем summary (conv=%s, level=%s, model=%s)",
        conversation_id,
        summary_level,
        summary_model,
    )

    await collection.update_one(
        {"conversation_id": conversation_id, "summary_level": summary_level},
        {"$set": doc, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )




async def fetch_latest_summary(
    conversation_id: str,
    summary_level: str = "batch",
) -> Optional[Dict[str, Any]]:
    """Совместимость: обёртка над fetch_conversation_summary."""
    return await fetch_conversation_summary(conversation_id, summary_level)

async def fetch_conversation_summary(
    conversation_id: str,
    summary_level: str,
) -> Optional[Dict[str, Any]]:
    collection = await _get_summaries_collection()
    doc = await collection.find_one(
        {"conversation_id": conversation_id, "summary_level": summary_level}
    )
    if doc:
        doc["_id"] = str(doc["_id"])
    logger.info(
        "[MongoRepo] Загружена summary (conv=%s, level=%s, exists=%s)",
        conversation_id,
        summary_level,
        bool(doc),
    )
    return doc


async def delete_conversation_summaries(conversation_id: str) -> int:
    collection = await _get_summaries_collection()
    result = await collection.delete_many({"conversation_id": conversation_id})
    logger.info(
        "[MongoRepo] Удалены summary (conv=%s, count=%d)",
        conversation_id,
        result.deleted_count,
    )
    return result.deleted_count
