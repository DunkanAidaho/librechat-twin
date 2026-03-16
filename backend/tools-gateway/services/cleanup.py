from __future__ import annotations

import asyncio
import logging
from typing import Optional

from sqlalchemy import text

from core.clients import get_engine
from core.config import settings
from services.context_manager import context_manager
from services.neo4j import delete_conversation as delete_conversation_graph

try:
    from pymongo import MongoClient
except Exception:
    MongoClient = None  # type: ignore

logger = logging.getLogger("tools-gateway.cleanup")


def _delete_chunks_pg(conversation_id: str) -> None:
    engine = get_engine()
    sql = text(
        """
        DELETE FROM chunks
        WHERE doc_id = :doc OR doc_id = :summary
        """
    )
    params = {
        "doc": conversation_id,
        "summary": f"summary_{conversation_id}",
    }
    with engine.connect() as conn:
        conn.execute(sql, params)
        conn.commit()
    logger.info("[Cleanup] Удалены записи из Postgres (conversation=%s).", conversation_id)


def _delete_mongo(conversation_id: str) -> None:
    if not MongoClient or not settings.MONGO_URI or not settings.MONGO_DB:
        return
    client = MongoClient(settings.MONGO_URI)
    try:
        db = client[settings.MONGO_DB]
        for collection_name in ("conversations", "messages"):
            if collection_name in db.list_collection_names():
                result = db[collection_name].delete_many({"conversationId": conversation_id})
                logger.info(
                    "[Cleanup] MongoDB: удалено %d документов из %s (conversation=%s).",
                    result.deleted_count,
                    collection_name,
                    conversation_id,
                )
    finally:
        client.close()


async def _forget_context(conversation_id: str) -> None:
    if hasattr(context_manager, "forget_conversation"):
        await context_manager.forget_conversation(conversation_id)
        logger.info("[Cleanup] Контекст удалён (forget_conversation).")
    elif hasattr(context_manager, "delete_conversation"):
        await context_manager.delete_conversation(conversation_id)  # type: ignore[attr-defined]
        logger.info("[Cleanup] Контекст удалён (delete_conversation).")
    else:
        logger.warning("[Cleanup] У context_manager нет методов для удаления контекста.")


async def delete_conversation_everywhere(conversation_id: str, user_id: Optional[str] = None) -> None:
    logger.info("[Cleanup] Старт удаления conversation=%s (user=%s)", conversation_id, user_id or "n/a")
    loop = asyncio.get_running_loop()

    tasks = [
        loop.run_in_executor(None, _delete_chunks_pg, conversation_id),
        delete_conversation_graph(conversation_id),
        loop.run_in_executor(None, _delete_mongo, conversation_id),
    ]

    results = await asyncio.gather(*tasks, return_exceptions=True)

    for result in results:
        if isinstance(result, Exception):
            logger.error("[Cleanup] Ошибка при удалении conversation=%s: %s", conversation_id, result)

    await _forget_context(conversation_id)
    logger.info("[Cleanup] Завершено удаление conversation=%s", conversation_id)
