"""High-level manager orchestrating chat history operations."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional
from uuid import uuid4

import chainlit as cl

from app_core.services.chat_history_store import ChatHistoryStore, ChatMessage, ChatRecord
from app_core.utils.structured_logging import extra_with_context, get_logger, log_exception

__all__ = ["ChatSummaryDTO", "ChatHistoryManager"]

_LOGGER = get_logger(__name__)
_SESSION_CONVERSATION_ID = "chat.current_conversation_id"


@dataclass(frozen=True)
class ChatSummaryDTO:
    """Serializable conversation summary for UI."""

    conversation_id: str
    title: str
    agent_id: Optional[str]
    created_at: str
    updated_at: str


class ChatHistoryManager:
    """Coordinates ChatHistoryStore with Chainlit session and title generation."""

    def __init__(self, store: ChatHistoryStore) -> None:
        self._store = store

    async def list_conversations(self, *, limit: Optional[int] = None) -> List[ChatSummaryDTO]:
        """Returns conversation summaries ordered by last update."""
        trace_id = self._trace_id()
        records = await asyncio.to_thread(self._store.list_conversations, limit=limit, trace_id=trace_id)
        return [
            ChatSummaryDTO(
                conversation_id=record.conversation_id,
                title=record.title,
                agent_id=record.agent_id,
                created_at=record.created_at,
                updated_at=record.updated_at,
            )
            for record in records
        ]

    async def start_conversation(
        self,
        *,
        agent_id: Optional[str],
        title: Optional[str] = None,
        initial_messages: Optional[Iterable[Dict[str, Any]]] = None,
    ) -> ChatRecord:
        """Creates a new conversation and makes it active in the session."""
        trace_id = self._trace_id()
        record = await asyncio.to_thread(
            self._store.create_conversation,
            agent_id=agent_id,
            title=title,
            initial_messages=initial_messages,
            trace_id=trace_id,
        )
        self._set_active_conversation(record.conversation_id)
        _LOGGER.info(
            "Создана беседа и установлена активной",
            extra=extra_with_context(
                operation="start_conversation",
                status="success",
                conversation_id=record.conversation_id,
                agent_id=agent_id,
                trace_id=trace_id,
            ),
        )
        return record

    async def append_message(
        self,
        *,
        conversation_id: str,
        role: str,
        content: str,
        meta: Optional[Dict[str, Any]] = None,
    ) -> ChatRecord:
        """Appends a message to the specified conversation."""
        trace_id = self._trace_id()
        payload = {
            "role": role,
            "content": content,
            "meta": meta or {},
        }
        try:
            record = await asyncio.to_thread(
                self._store.append_message,
                conversation_id,
                payload,
                trace_id=trace_id,
            )
            _LOGGER.info(
                "Сообщение добавлено в беседу",
                extra=extra_with_context(
                    operation="append_message",
                    status="success",
                    conversation_id=conversation_id,
                    role=role,
                    trace_id=trace_id,
                ),
            )
            return record
        except KeyError as exc:
            log_exception(
                _LOGGER,
                "Беседа для добавления сообщения не найдена",
                exc,
                operation="append_message",
                status="not_found",
                conversation_id=conversation_id,
                trace_id=trace_id,
            )
            raise

    async def ensure_title(
        self,
        conversation_id: str,
        generator: Optional[Callable[[ChatRecord], Awaitable[str]]] = None,
    ) -> ChatRecord:
        """Ensures conversation has a meaningful title using optional generator and fallback."""
        trace_id = self._trace_id()
        record = await asyncio.to_thread(self._store.get_conversation, conversation_id, trace_id=trace_id)
        if record is None:
            raise KeyError(conversation_id)

        if record.title and record.title != "Новая беседа":
            return record

        new_title: Optional[str] = None
        if generator:
            try:
                candidate = await generator(record)
                new_title = candidate.strip() or None
            except Exception as exc:
                log_exception(
                    _LOGGER,
                    "Ошибка генератора заголовков",
                    exc,
                    operation="generate_title",
                    status="failed",
                    conversation_id=conversation_id,
                    trace_id=trace_id,
                )

        if not new_title:
            new_title = self._fallback_title(record)

        updated = await asyncio.to_thread(
            self._store.update_conversation,
            conversation_id,
            title=new_title,
            trace_id=trace_id,
        )
        _LOGGER.info(
            "Заголовок беседы обновлён",
            extra=extra_with_context(
                operation="ensure_title",
                status="success",
                conversation_id=conversation_id,
                title=new_title,
                trace_id=trace_id,
            ),
        )
        return updated

    async def delete_conversation(self, conversation_id: str) -> None:
        """Deletes conversation and clears active id if it matches."""
        trace_id = self._trace_id()
        await asyncio.to_thread(self._store.delete_conversation, conversation_id, trace_id=trace_id)
        if self.get_active_conversation_id() == conversation_id:
            self.clear_active_conversation()
        _LOGGER.info(
            "Беседа удалена через менеджер",
            extra=extra_with_context(
                operation="delete_conversation",
                status="success",
                conversation_id=conversation_id,
                trace_id=trace_id,
            ),
        )

    async def load_conversation(self, conversation_id: str) -> ChatRecord:
        """Loads conversation and marks it active."""
        trace_id = self._trace_id()
        record = await asyncio.to_thread(self._store.get_conversation, conversation_id, trace_id=trace_id)
        if record is None:
            raise KeyError(conversation_id)
        self._set_active_conversation(conversation_id)
        _LOGGER.info(
            "Беседа загружена и активирована",
            extra=extra_with_context(
                operation="load_conversation",
                status="success",
                conversation_id=conversation_id,
                trace_id=trace_id,
            ),
        )
        return record

    def get_active_conversation_id(self) -> Optional[str]:
        """Returns id of the conversation stored in user session."""
        return cl.user_session.get(_SESSION_CONVERSATION_ID)

    def clear_active_conversation(self) -> None:
        """Removes conversation id from user session."""
        try:
            cl.user_session.delete(_SESSION_CONVERSATION_ID)
        except (AttributeError, KeyError):
            cl.user_session.set(_SESSION_CONVERSATION_ID, None)
        _LOGGER.info(
            "Активная беседа очищена",
            extra=extra_with_context(
                operation="clear_active_conversation",
                status="success",
            ),
        )

    def _set_active_conversation(self, conversation_id: str) -> None:
        cl.user_session.set(_SESSION_CONVERSATION_ID, conversation_id)
        _LOGGER.info(
            "Активная беседа установлена",
            extra=extra_with_context(
                operation="set_active_conversation",
                status="success",
                conversation_id=conversation_id,
            ),
        )

    @staticmethod
    def _fallback_title(record: ChatRecord) -> str:
        for message in record.messages:
            if message.role == "user" and message.content:
                snippet = message.content.strip().splitlines()[0][:80]
                return snippet or "Беседа"
        return "Беседа"

    @staticmethod
    def _trace_id() -> str:
        return uuid4().hex
