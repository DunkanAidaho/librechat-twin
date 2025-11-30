"""Chat history storage with JSON backend and structured logging."""
from __future__ import annotations

import json
import os
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from uuid import uuid4

from filelock import FileLock, Timeout

from app_core.utils.structured_logging import extra_with_context, get_logger, log_exception

__all__ = [
    "CHAT_HISTORY_SCHEMA_VERSION",
    "ChatMessage",
    "ChatRecord",
    "ChatHistoryStore",
]

_CHAT_LOGGER = get_logger(__name__)
CHAT_HISTORY_SCHEMA_VERSION = 1
_DEFAULT_MAX_CONVERSATIONS = 200


@dataclass(frozen=True)
class ChatMessage:
    """Serializable chat message stored in JSON history."""

    role: str
    content: str
    created_at: str
    meta: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ChatRecord:
    """Conversation entry with aggregated metadata and messages."""

    conversation_id: str
    agent_id: Optional[str]
    title: str
    messages: List[ChatMessage]
    created_at: str
    updated_at: str
    schema_version: int = CHAT_HISTORY_SCHEMA_VERSION


class ChatHistoryStore:
    """Persists conversation history into a JSON file with locking."""

    def __init__(self, path: Path, *, lock_timeout: float = 5.0, max_conversations: int = _DEFAULT_MAX_CONVERSATIONS) -> None:
        self._path = path
        self._lock = FileLock(f"{self._path}.lock")
        self._lock_timeout = lock_timeout
        self._max_conversations = max(max_conversations, 1)
        self._ensure_storage()

    # ------------------------------------------------------------------ public API

    def list_conversations(self, *, limit: Optional[int] = None, trace_id: Optional[str] = None) -> List[ChatRecord]:
        """Returns conversations ordered by updated_at desc."""
        with self._transaction(trace_id=trace_id) as data:
            records = [self._hydrate(record) for record in data.get("conversations", [])]
            records.sort(key=lambda item: item.updated_at, reverse=True)
            if limit:
                return records[:limit]
            return records

    def get_conversation(self, conversation_id: str, *, trace_id: Optional[str] = None) -> Optional[ChatRecord]:
        """Finds conversation by identifier."""
        with self._transaction(trace_id=trace_id) as data:
            for item in data.get("conversations", []):
                if item.get("conversation_id") == conversation_id:
                    return self._hydrate(item)
        return None

    def create_conversation(
        self,
        *,
        agent_id: Optional[str],
        title: Optional[str] = None,
        initial_messages: Optional[Iterable[Dict[str, Any]]] = None,
        trace_id: Optional[str] = None,
    ) -> ChatRecord:
        """Creates conversation stub and trims excessive records."""
        now = self._utc_now()
        record = ChatRecord(
            conversation_id=uuid4().hex,
            agent_id=agent_id,
            title=title or "Новая беседа",
            messages=[self._hydrate_message(message) for message in initial_messages or []],
            created_at=now,
            updated_at=now,
        )
        with self._transaction(write=True, trace_id=trace_id) as data:
            conversations = data.setdefault("conversations", [])
            conversations.insert(0, self._dump_record(record))
            self._prune_conversations(conversations, trace_id=trace_id)
            data["schema_version"] = CHAT_HISTORY_SCHEMA_VERSION
        _CHAT_LOGGER.info(
            "Создана новая беседа",
            extra=extra_with_context(operation="create_conversation", status="success", conversation_id=record.conversation_id, trace_id=trace_id),
        )
        return record

    def append_message(
        self,
        conversation_id: str,
        message: Dict[str, Any],
        *,
        trace_id: Optional[str] = None,
    ) -> ChatRecord:
        """Appends a message and updates timestamp."""
        with self._transaction(write=True, trace_id=trace_id) as data:
            conversations = data.get("conversations", [])
            for raw in conversations:
                if raw.get("conversation_id") == conversation_id:
                    hydrated = self._hydrate(raw)
                    new_message = self._hydrate_message(message)
                    hydrated.messages.append(new_message)
                    hydrated = self._update_record(hydrated)
                    raw.update(self._dump_record(hydrated))
                    _CHAT_LOGGER.info(
                        "Добавлено сообщение к беседе",
                        extra=extra_with_context(operation="append_message", status="success", conversation_id=conversation_id, trace_id=trace_id),
                    )
                    return hydrated
        raise KeyError(conversation_id)

    def update_conversation(
        self,
        conversation_id: str,
        *,
        title: Optional[str] = None,
        agent_id: Optional[str] = None,
        messages: Optional[Iterable[Dict[str, Any]]] = None,
        trace_id: Optional[str] = None,
    ) -> ChatRecord:
        """Updates conversation metadata and optionally replaces messages."""
        with self._transaction(write=True, trace_id=trace_id) as data:
            conversations = data.get("conversations", [])
            for raw in conversations:
                if raw.get("conversation_id") == conversation_id:
                    hydrated = self._hydrate(raw)
                    if title is not None:
                        hydrated = ChatRecord(
                            conversation_id=hydrated.conversation_id,
                            agent_id=hydrated.agent_id,
                            title=title,
                            messages=hydrated.messages,
                            created_at=hydrated.created_at,
                            updated_at=hydrated.updated_at,
                            schema_version=hydrated.schema_version,
                        )
                    if agent_id is not None:
                        hydrated = ChatRecord(
                            conversation_id=hydrated.conversation_id,
                            agent_id=agent_id,
                            title=hydrated.title,
                            messages=hydrated.messages,
                            created_at=hydrated.created_at,
                            updated_at=hydrated.updated_at,
                            schema_version=hydrated.schema_version,
                        )
                    if messages is not None:
                        hydrated = ChatRecord(
                            conversation_id=hydrated.conversation_id,
                            agent_id=hydrated.agent_id,
                            title=hydrated.title,
                            messages=[self._hydrate_message(msg) for msg in messages],
                            created_at=hydrated.created_at,
                            updated_at=hydrated.updated_at,
                            schema_version=hydrated.schema_version,
                        )
                    hydrated = self._update_record(hydrated)
                    raw.update(self._dump_record(hydrated))
                    _CHAT_LOGGER.info(
                        "Беседа обновлена",
                        extra=extra_with_context(operation="update_conversation", status="success", conversation_id=conversation_id, trace_id=trace_id),
                    )
                    return hydrated
        raise KeyError(conversation_id)

    def delete_conversation(self, conversation_id: str, *, trace_id: Optional[str] = None) -> None:
        """Deletes conversation by identifier."""
        with self._transaction(write=True, trace_id=trace_id) as data:
            conversations = data.get("conversations", [])
            original_len = len(conversations)
            conversations[:] = [item for item in conversations if item.get("conversation_id") != conversation_id]
            if len(conversations) != original_len:
                _CHAT_LOGGER.info(
                    "Беседа удалена",
                    extra=extra_with_context(operation="delete_conversation", status="success", conversation_id=conversation_id, trace_id=trace_id),
                )
            else:
                raise KeyError(conversation_id)

    # ------------------------------------------------------------------ internal helpers

    @contextmanager
    def _transaction(self, *, write: bool = False, trace_id: Optional[str] = None):
        """Provides read/write access guarded by a file lock."""
        acquired = False
        try:
            self._lock.acquire(timeout=self._lock_timeout)
            acquired = True
        except Timeout as exc:
            log_exception(
                _CHAT_LOGGER,
                "Не удалось получить блокировку для истории чата",
                exc,
                operation="chat_history_lock",
                status="timeout",
                trace_id=trace_id,
            )
            raise
        try:
            data = self._load_data()
            yield data
            if write:
                self._write_data(data)
        finally:
            if acquired and self._lock.is_locked:
                self._lock.release()

    def _load_data(self) -> Dict[str, Any]:
        try:
            raw = self._path.read_text(encoding="utf-8")
            payload = json.loads(raw)
            if isinstance(payload, dict):
                return payload
        except FileNotFoundError:
            self._ensure_storage()
        except json.JSONDecodeError as exc:
            log_exception(
                _CHAT_LOGGER,
                "Некорректный JSON истории, содержимое сброшено",
                exc,
                operation="load_chat_history",
                status="invalid_json",
            )
        return {"schema_version": CHAT_HISTORY_SCHEMA_VERSION, "conversations": []}

    def _write_data(self, data: Dict[str, Any]) -> None:
        tmp_path = self._path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp_path, self._path)

    def _ensure_storage(self) -> None:
        data_dir = self._path.parent
        data_dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(data_dir, 0o700)
        except PermissionError as exc:
            _CHAT_LOGGER.warning(
                "Не удалось применить права для каталога истории",
                extra=extra_with_context(operation="ensure_storage", status="permission_warning", path=str(data_dir), error=str(exc)),
            )
        if not self._path.exists():
            initial = {"schema_version": CHAT_HISTORY_SCHEMA_VERSION, "conversations": []}
            self._path.write_text(json.dumps(initial, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                os.chmod(self._path, 0o600)
            except PermissionError as exc:
                _CHAT_LOGGER.warning(
                    "Не удалось применить права для файла истории",
                    extra=extra_with_context(operation="ensure_storage", status="permission_warning", path=str(self._path), error=str(exc)),
                )

    def _hydrate(self, raw: Dict[str, Any]) -> ChatRecord:
        messages = [self._hydrate_message(item) for item in raw.get("messages", [])]
        return ChatRecord(
            conversation_id=str(raw.get("conversation_id")),
            agent_id=raw.get("agent_id"),
            title=str(raw.get("title") or "Без названия"),
            messages=messages,
            created_at=str(raw.get("created_at") or self._utc_now()),
            updated_at=str(raw.get("updated_at") or self._utc_now()),
            schema_version=int(raw.get("schema_version") or CHAT_HISTORY_SCHEMA_VERSION),
        )

    def _hydrate_message(self, raw: Dict[str, Any]) -> ChatMessage:
        return ChatMessage(
            role=str(raw.get("role") or "user"),
            content=str(raw.get("content") or ""),
            created_at=str(raw.get("created_at") or self._utc_now()),
            meta=dict(raw.get("meta") or {}),
        )

    def _dump_record(self, record: ChatRecord) -> Dict[str, Any]:
        return {
            "conversation_id": record.conversation_id,
            "agent_id": record.agent_id,
            "title": record.title,
            "messages": [asdict(message) for message in record.messages],
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "schema_version": record.schema_version,
        }

    def _update_record(self, record: ChatRecord) -> ChatRecord:
        return ChatRecord(
            conversation_id=record.conversation_id,
            agent_id=record.agent_id,
            title=record.title,
            messages=record.messages,
            created_at=record.created_at,
            updated_at=self._utc_now(),
            schema_version=record.schema_version,
        )

    def _prune_conversations(self, conversations: List[Dict[str, Any]], *, trace_id: Optional[str]) -> None:
        if len(conversations) <= self._max_conversations:
            return
        removed = conversations[self._max_conversations :]
        del conversations[self._max_conversations :]
        _CHAT_LOGGER.warning(
            "Выполнена ротация истории чатов",
            extra=extra_with_context(
                operation="prune_conversations",
                status="rotated",
                removed_count=len(removed),
                trace_id=trace_id,
            ),
        )

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(timezone.utc).isoformat()
