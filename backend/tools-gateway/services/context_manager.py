"""Context manager service orchestrating Temporal workflows."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, Union

from fastapi import HTTPException
from pydantic import ValidationError
from temporalio.client import RPCError
from temporalio.exceptions import TemporalError, WorkflowAlreadyStartedError

from core.config import settings, is_production
from models.pydantic_models import (
    IngestMessageRequest,
    IngestSummaryRequest,
    MessageForSummary,
    TemporalGraphRequest,
    TemporalSummaryRequest,
    TemporalMemoryRequest,
)
from services.metrics import (
    inc_graph_enqueue_failure,
    inc_graph_enqueue_total,
    inc_memory_enqueue_failure,
    inc_memory_enqueue_total,
    inc_summary_enqueue_failure,
    inc_summary_enqueue_total,
    observe_graph_enqueue,
    observe_memory_enqueue,
    observe_summary_enqueue,
    set_temporal_status,
)
from services.temporal_client import temporal_settings
from services.nats_dispatcher import publish_status_event
from services.workflow_launcher import start_graph_workflow, start_summary_workflow, start_memory_workflow
from services.text_utils import extract_content_dates

logger = logging.getLogger("tools-gateway.context")
MAX_CONTEXT_MESSAGES = 20
MAX_CONTEXT_TOKENS = 200000
CLEANUP_INTERVAL_SECONDS = 3600
STATS_CONTEXT_CUTOFF = MAX_CONTEXT_MESSAGES * 2
_SENSITIVE_SUBSTRINGS = (
    "token",
    "secret",
    "password",
    "api_key",
    "authorization",
    "credential",
)
_MASK_REPLACEMENT = "***redacted***"


class SummaryPayloadTooLarge(Exception):
    """Raised when summary payload cannot be reduced under configured budgets."""


def mask_sensitive_data(payload: Any) -> Any:
    """Recursively masks values that contain sensitive substrings."""
    if isinstance(payload, dict):
        masked: Dict[str, Any] = {}
        for key, value in payload.items():
            lowered = key.lower()
            if any(sub in lowered for sub in _SENSITIVE_SUBSTRINGS):
                masked[key] = _MASK_REPLACEMENT
            else:
                masked[key] = mask_sensitive_data(value)
        return masked
    if isinstance(payload, list):
        return [mask_sensitive_data(item) for item in payload]
    if isinstance(payload, tuple):
        return tuple(mask_sensitive_data(item) for item in payload)
    return payload


def _json_size(value: Any) -> int:
    if value is None:
        return 0
    try:
        return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
    except Exception:
        return 0


def _truncate_text_value(text: Optional[str], limit: int) -> str:
    if not text:
        return ""
    if limit <= 0 or len(text) <= limit:
        return text
    ellipsis = "…"
    slice_len = max(limit - (1 if limit > 1 else 0), 0)
    if slice_len <= 0:
        return ellipsis if limit else ""
    trimmed = text[:slice_len].rstrip()
    return f"{trimmed}{ellipsis}" if trimmed else ellipsis


def _truncate_message_copy(
    message: MessageForSummary,
    limit: int,
    stats: Optional[Dict[str, int]] = None,
) -> MessageForSummary:
    new_content = _truncate_text_value(message.content, limit)
    if new_content == (message.content or ""):
        return message
    if stats is not None:
        stats["content_truncations"] = stats.get("content_truncations", 0) + 1
    return MessageForSummary(
        role=message.role,
        content=new_content,
        message_id=message.message_id,
        created_at=message.created_at,
    )


def _estimate_messages_bytes(messages: List[MessageForSummary]) -> int:
    if not messages:
        return 0
    try:
        payload = [msg.model_dump(mode="json") for msg in messages]
        return _json_size(payload)
    except Exception:
        return sum(len((msg.content or "")) + 128 for msg in messages)


def _shrink_summary_messages(
    messages: List[MessageForSummary],
) -> Tuple[List[MessageForSummary], Dict[str, int]]:
    """Reduces the payload size for Temporal by trimming message count and content length."""
    stats: Dict[str, int] = {
        "dropped_messages": 0,
        "content_truncations": 0,
    }
    if not messages:
        return [], stats

    max_messages = max(0, getattr(settings, "SUMMARY_TEMPORAL_MAX_MESSAGES", 0) or 0)
    max_chars = max(0, getattr(settings, "SUMMARY_TEMPORAL_MAX_MESSAGE_CHARS", 0) or 0)

    if max_messages and len(messages) > max_messages:
        selected = messages[-max_messages:]
        stats["dropped_messages"] += len(messages) - len(selected)
    else:
        selected = messages

    ellipsis = "…"

    def _truncate_message(msg: MessageForSummary, limit: int) -> MessageForSummary:
        truncated = _truncate_text_value(msg.content, limit)
        if truncated == (msg.content or ""):
            return msg
        stats["content_truncations"] = stats.get("content_truncations", 0) + 1
        return MessageForSummary(
            role=msg.role,
            content=truncated,
            message_id=msg.message_id,
            created_at=msg.created_at,
        )

    slimmed: List[MessageForSummary] = [
        _truncate_message(msg, max_chars) if max_chars else msg
        for msg in selected
    ]

    max_messages_bytes = max(0, getattr(settings, "SUMMARY_TEMPORAL_MAX_MESSAGES_BYTES", 0) or 0)
    if max_messages_bytes:
        bytes_estimate = _estimate_messages_bytes(slimmed)
        stats["messages_bytes_before"] = bytes_estimate
        while len(slimmed) > 1 and bytes_estimate > max_messages_bytes:
            slimmed = slimmed[1:]
            stats["dropped_messages"] += 1
            bytes_estimate = _estimate_messages_bytes(slimmed)

        if bytes_estimate > max_messages_bytes and slimmed:
            dynamic_limits = []
            if max_chars:
                dynamic_limits.extend(
                    limit for limit in (int(max_chars * 0.7), max_chars // 2, max_chars // 3)
                    if limit > 0
                )
            dynamic_limits.extend([512, 256, 128, 64])
            applied = False
            for limit_chars in dynamic_limits:
                slimmed = [_truncate_message_copy(msg, limit_chars, stats) for msg in slimmed]
                bytes_estimate = _estimate_messages_bytes(slimmed)
                applied = True
                if bytes_estimate <= max_messages_bytes or len(slimmed) == 1:
                    break
            if bytes_estimate > max_messages_bytes and len(slimmed) > 1:
                dropped = len(slimmed) - 1
                stats["dropped_messages"] += dropped
                slimmed = [
                    _truncate_message_copy(slimmed[-1], 64, stats)
                ]
                bytes_estimate = _estimate_messages_bytes(slimmed)
            if applied:
                stats["content_truncations"] = stats.get("content_truncations", 0)
        stats["messages_bytes_after"] = _estimate_messages_bytes(slimmed)

    if stats["dropped_messages"] or stats.get("content_truncations"):
        logger.info(
            "[ContextManager][Summary] Payload shrunk before Temporal dispatch "
            "(trimmed=%d, truncated_contents=%d, kept=%d)",
            stats["dropped_messages"],
            stats.get("content_truncations", 0),
            len(slimmed),
        )

    return slimmed, stats


def _shrink_summary_metadata(
    metadata: Optional[Dict[str, Any]],
) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
    limit = max(0, getattr(settings, "SUMMARY_TEMPORAL_MAX_METADATA_BYTES", 0) or 0)
    if not metadata:
        return None, {"metadata_bytes_before": 0, "metadata_bytes_after": 0, "dropped_keys": []}

    size_before = _json_size(metadata)
    info: Dict[str, Any] = {
        "metadata_bytes_before": size_before,
        "metadata_bytes_after": size_before,
        "dropped_keys": [],
    }
    if not limit or size_before <= limit:
        return metadata, info

    # Drop the largest keys first based on their serialized footprint
    key_sizes = []
    for key, value in metadata.items():
        key_sizes.append((key, _json_size({key: value})))
    key_sizes.sort(key=lambda item: item[1], reverse=True)

    trimmed = dict(metadata)
    for key, _ in key_sizes:
        trimmed.pop(key, None)
        info["dropped_keys"].append(key)
        current_size = _json_size(trimmed)
        info["metadata_bytes_after"] = current_size
        if current_size <= limit:
            trimmed["_truncated_keys"] = info["dropped_keys"]
            return trimmed, info

    trimmed = {"_truncated": True}
    info["metadata_bytes_after"] = _json_size(trimmed)
    return trimmed, info


def _estimate_summary_payload_bytes(payload: TemporalSummaryRequest) -> int:
    return _json_size(payload.model_dump(mode="json"))


def _enforce_total_summary_payload_limit(
    payload: TemporalSummaryRequest,
    *,
    limit_bytes: int,
) -> Tuple[TemporalSummaryRequest, Dict[str, Any]]:
    info: Dict[str, Any] = {
        "payload_bytes_before": _estimate_summary_payload_bytes(payload),
        "payload_bytes_after": None,
        "actions": [],
    }
    if not limit_bytes:
        info["payload_bytes_after"] = info["payload_bytes_before"]
        return payload, info

    working = payload
    size = info["payload_bytes_before"]
    if size <= limit_bytes:
        info["payload_bytes_after"] = size
        return working, info

    if working.metadata:
        info["actions"].append("metadata_dropped")
        working = working.model_copy(update={"metadata": None})
        size = _estimate_summary_payload_bytes(working)
        if size <= limit_bytes:
            info["payload_bytes_after"] = size
            return working, info

    messages = list(working.messages)
    dropped = 0
    while len(messages) > 1 and size > limit_bytes:
        messages.pop(0)
        dropped += 1
        working = working.model_copy(update={"messages": messages})
        size = _estimate_summary_payload_bytes(working)
    if dropped:
        info["actions"].append(f"dropped_messages={dropped}")
        if size <= limit_bytes:
            info["payload_bytes_after"] = size
            return working, info

    for char_limit in (512, 256, 128, 64, 32):
        truncated_messages = [
            _truncate_message_copy(msg, char_limit) for msg in working.messages
        ]
        working = working.model_copy(update={"messages": truncated_messages})
        size = _estimate_summary_payload_bytes(working)
        info["actions"].append(f"content_truncated_to_{char_limit}")
        if size <= limit_bytes:
            info["payload_bytes_after"] = size
            return working, info

    raise SummaryPayloadTooLarge(
        f"Summary payload is {size} bytes after aggressive shrinking (limit={limit_bytes})."
    )


@dataclass
class ConversationContext:
    """Stores message history and cached entities for a conversation."""

    messages: List[Dict[str, str]] = field(default_factory=list)
    known_entities: Dict[str, str] = field(default_factory=dict)



class ModelRoutingState(str, Enum):
    """Состояние маршрутизации моделей OpenRouter."""

    PRIMARY = "primary"
    FALLBACK = "fallback"
    PREMIUM = "premium"

class ContextManager:
    """Coordinates ingestion of messages and summary jobs for workflows."""

    def __init__(self) -> None:
        self._contexts: Dict[str, ConversationContext] = {}
        self._lock = asyncio.Lock()
        self._model_state_lock = asyncio.Lock()
        self._model_states: Dict[str, ModelRoutingState] = {
            "graph": ModelRoutingState.PRIMARY,
            "summary": ModelRoutingState.PRIMARY,
        }

    async def get_or_create(self, conversation_id: str, system_prompt: str) -> ConversationContext:
        """Fetches existing context or initializes it with a system prompt."""
        async with self._lock:
            if conversation_id not in self._contexts:
                logger.debug("[Context] Создаём новый контекст для %s", conversation_id)
                self._contexts[conversation_id] = ConversationContext(
                    messages=[{"role": "system", "content": system_prompt}]
                )
            return self._contexts[conversation_id]

    async def update_messages(self, conversation_id: str, messages: List[Dict[str, str]]) -> None:
        """Replaces message history for an existing conversation."""
        async with self._lock:
            if conversation_id in self._contexts:
                logger.debug(
                    "[Context] Обновление истории сообщений для %s (%d сообщений)",
                    conversation_id,
                    len(messages),
                )
                self._contexts[conversation_id].messages = messages

    def _prune_context_locked(self, conversation_id: str) -> None:
        """Ensures stored history stays within MAX_CONTEXT_MESSAGES."""
        context = self._contexts.get(conversation_id)
        if not context:
            return
        if len(context.messages) > MAX_CONTEXT_MESSAGES:
            head = context.messages[:1]
            tail = context.messages[-(MAX_CONTEXT_MESSAGES - 1) :]
            context.messages = head + tail
            logger.info("[Context] Контекст %s усечён до %d сообщений", conversation_id, len(context.messages))

    async def prune_context(self, conversation_id: str) -> None:
        """Public wrapper over `_prune_context_locked` with locking."""
        async with self._lock:
            self._prune_context_locked(conversation_id)

    async def cleanup_periodically(self) -> None:
        """Периодически очищает контексты, которые превысили лимит сообщений."""
        while True:
            await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
            logger.debug("[Context] Запуск периодической очистки контекстов.")
            async with self._lock:
                to_remove = [
                    conv_id
                    for conv_id, ctx in list(self._contexts.items())
                    if len(ctx.messages) > STATS_CONTEXT_CUTOFF
                ]
                for conv_id in to_remove:
                    self._contexts.pop(conv_id, None)
                    logger.info(
                        "[Context] Контекст беседы %s очищен за превышение лимита сообщений.",
                        conv_id,
                    )
            logger.debug("[Context] Периодическая очистка контекстов завершена.")

    async def drop_context(self, conversation_id: str) -> None:
        """Removes context data for a conversation."""
        async with self._lock:
            if self._contexts.pop(conversation_id, None):
                logger.info("[Context] Контекст беседы %s удалён вручную", conversation_id)

    async def list_contexts(self) -> Dict[str, Any]:
        """Returns counts for total contexts and those exceeding size limit."""
        async with self._lock:
            return {
                "total": len(self._contexts),
                "with_overflow": sum(1 for ctx in self._contexts.values() if len(ctx.messages) > STATS_CONTEXT_CUTOFF),
            }

    async def get_recent_messages(self, conversation_id: str, limit: int = 5) -> List[Dict[str, Any]]:
        """Returns up to `limit` most recent messages for a conversation."""
        if limit <= 0:
            return []
        async with self._lock:
            context = self._contexts.get(conversation_id)
            if not context or not context.messages:
                return []
            selected = context.messages[-limit:]
            return [dict(message) for message in selected]

    async def get_known_entities(self, conversation_id: str) -> Dict[str, str]:
        """Returns cached entities for conversation, if any."""
        async with self._lock:
            context = self._contexts.get(conversation_id)
            return context.known_entities if context else {}

    async def set_known_entities(self, conversation_id: str, known: Dict[str, str]) -> None:
        """Overwrites cached entities for a conversation."""
        async with self._lock:
            if conversation_id in self._contexts:
                self._contexts[conversation_id].known_entities = known


    async def get_model_state(self, channel: str = "graph") -> ModelRoutingState:
        """Возвращает состояние маршрутизации модели для указанного канала."""
        key = (channel or "graph").lower()
        async with self._model_state_lock:
            state = self._model_states.get(key)
            if state is None:
                logger.warning(
                    "[Context] Запрошено неизвестное состояние модели (channel=%s). Используем primary по умолчанию.",
                    key,
                )
                state = ModelRoutingState.PRIMARY
                self._model_states[key] = state
            return state

    async def set_model_state(self, state: ModelRoutingState, channel: str = "graph") -> None:
        """Устанавливает состояние маршрутизации модели для канала."""
        key = (channel or "graph").lower()
        async with self._model_state_lock:
            current = self._model_states.get(key, ModelRoutingState.PRIMARY)
            if current != state:
                logger.info(
                    "[Context] Переключение состояния модели (channel=%s): %s -> %s",
                    key,
                    current.value,
                    state.value,
                )
                self._model_states[key] = state

    async def reset_model_state(self, channel: str = "graph") -> None:
        """Сбрасывает состояние маршрутизации модели на primary для канала."""
        await self.set_model_state(ModelRoutingState.PRIMARY, channel=channel)


    async def ingest_message(
        self,
        payload: Union[IngestMessageRequest, Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Validates payload, updates context and dispatches the Graph workflow."""
        try:
            request = payload if isinstance(payload, IngestMessageRequest) else IngestMessageRequest(**payload)
        except ValidationError as exc:
            logger.warning("[ContextManager][Graph] Некорректный payload ingest_message: %s", exc)
            raise HTTPException(status_code=422, detail=exc.errors()) from exc

        masked_payload = mask_sensitive_data(request.model_dump(mode="json"))
        log_event = {
            "conversation_id": request.conversation_id,
            "message_id": request.message_id,
        }
        logger.info(
            "[ContextManager][Graph] Принят запрос",
            extra={"event": log_event},
        )
        if settings.ENABLE_DEBUG_PAYLOAD_LOGGING and not is_production():
            logger.debug("[ContextManager][Graph] Payload=%s", json.dumps(masked_payload, ensure_ascii=False))

        async with self._lock:
            context = self._contexts.get(request.conversation_id)
            entry = {
                "role": request.role,
                "content": request.content,
                "message_id": request.message_id,
                "created_at": request.created_at,
            }
            if not context:
                context = ConversationContext(messages=[entry])
                self._contexts[request.conversation_id] = context
            else:
                context.messages.append(entry)
            self._prune_context_locked(request.conversation_id)
            context_info = {"messages_count": len(context.messages)}

        metadata_payload: Dict[str, Any] = dict(request.metadata or {})

        # TEMP: content_dates diagnostics (remove after investigation)
        if settings.ENABLE_DEBUG_PAYLOAD_LOGGING and not is_production():
            logger.info(
                "[DEBUG ingest] content_dates received: %s, message_id: %s",
                request.content_dates,
                request.message_id,
            )
            logger.info(
                "[DEBUG ingest] metadata_payload before content_dates merge: %s",
                json.dumps(metadata_payload, ensure_ascii=False),
            )

        def _set_metadata_if_missing(key: str, value: Any) -> None:
            if value is None:
                return
            if key not in metadata_payload:
                metadata_payload[key] = value

        def _should_override_content_dates(value: Any) -> bool:
            if value is None:
                return True
            if isinstance(value, list):
                return len(value) == 0
            return False

        derived_content_dates = extract_content_dates(request.content)
        if request.content_dates:
            derived_content_dates.extend(request.content_dates)
        if derived_content_dates:
            derived_content_dates = sorted(set(derived_content_dates))

        _set_metadata_if_missing("summary", request.summary)
        if _should_override_content_dates(metadata_payload.get("content_dates")):
            if derived_content_dates:
                metadata_payload["content_dates"] = derived_content_dates
        else:
            _set_metadata_if_missing("content_dates", derived_content_dates)
        _set_metadata_if_missing("importance_score", request.importance_score)
        _set_metadata_if_missing("message_index", request.message_index)
        _set_metadata_if_missing("conversation_id", request.conversation_id)
        _set_metadata_if_missing("created_at", request.created_at)
        _set_metadata_if_missing("role", request.role)
        _set_metadata_if_missing("user_id", request.user_id)
        _set_metadata_if_missing("message_id", request.message_id)

        if settings.ENABLE_DEBUG_PAYLOAD_LOGGING and not is_production():
            logger.info(
                "[DEBUG ingest] metadata_payload after content_dates merge: %s",
                json.dumps(metadata_payload, ensure_ascii=False),
            )

        graph_status: Dict[str, Any] = {"status": "skipped", "reason": "Graph workflow disabled"}
        status_label = "pending"
        dispatch_event = {
            **log_event,
            "nats_graph": settings.NATS_ENABLE_GRAPH,
            "graph_queue": temporal_settings.graph_queue,
        }
        logger.info(
            "[ContextManager][Graph] Dispatching workflow",
            extra={"event": dispatch_event, "status_label": "pending"},
        )

        if not settings.NATS_ENABLE_GRAPH or not temporal_settings.graph_queue:
            status_label = "skipped"
            set_temporal_status("idle")
            skipped_event = {**dispatch_event, "status": status_label}
            logger.info(
                "[ContextManager][Graph] Workflow skipped",
                extra={"event": skipped_event, "status_label": status_label},
            )
        else:
            graph_request = TemporalGraphRequest(
                user_id=request.user_id,
                conversation_id=request.conversation_id,
                message_id=request.message_id,
                content=request.content,
                created_at=request.created_at or datetime.utcnow().isoformat(),
                reasoning_text=request.reasoning_text,
                context_flags=request.context_flags or [],
                metadata=metadata_payload or None,
            )
            start_time = time.perf_counter()
            workflow_id: Optional[str] = None
            run_id: Optional[str] = None
            try:
                graph_status = await start_graph_workflow(graph_request)
                status_label = graph_status.get("status", "unknown")
                workflow_id = graph_status.get("workflow_id")
                run_id = graph_status.get("run_id")
            except WorkflowAlreadyStartedError as exc:
                workflow_id = getattr(exc, "workflow_id", None)
                run_id = getattr(exc, "run_id", None)
                graph_status = {
                    "status": "already_running",
                    "workflow_id": workflow_id,
                    "run_id": run_id,
                }
                status_label = "already_running"
                logger.info(
                    "[ContextManager][Graph] Workflow уже запущен",
                    extra={
                        "event": {
                            **log_event,
                            "workflow_id": workflow_id,
                            "run_id": run_id,
                        },
                        "status_label": status_label,
                    },
                )
            except (TemporalError, RPCError) as exc:
                graph_status = {"status": "temporal_error", "error": str(exc)}
                status_label = "temporal_error"
                logger.error(
                    "[ContextManager][Graph] Temporal error",
                    exc_info=True,
                    extra={
                        "event": log_event,
                        "status_label": status_label,
                    },
                )
            except Exception as exc:  # noqa: BLE001
                graph_status = {"status": "failure", "error": str(exc)}
                status_label = "failure"
                logger.error(
                    "[ContextManager][Graph] Неожиданная ошибка",
                    exc_info=True,
                    extra={
                        "event": log_event,
                        "status_label": status_label,
                    },
                )
            finally:
                duration = time.perf_counter() - start_time
                observe_graph_enqueue(duration)
                inc_graph_enqueue_total(status=status_label)
                if status_label not in {"started", "already_running"}:
                    inc_graph_enqueue_failure()
                set_temporal_status(status_label)

                result_event = {
                    **log_event,
                    "workflow_id": workflow_id,
                    "run_id": run_id,
                    "status": status_label,
                    "duration_ms": int(duration * 1000),
                }
                logger.info(
                    "[ContextManager][Graph] Workflow result",
                    extra={"event": result_event, "status_label": status_label},
                )

        response = {
            "status": graph_status.get("status"),
            "context": context_info,
            "graph": graph_status,
        }
        return response

    async def ingest_summary(
        self,
        payload: Union[IngestSummaryRequest, Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Handles summary ingest requests and dispatches the Summary workflow."""
        try:
            request = payload if isinstance(payload, IngestSummaryRequest) else IngestSummaryRequest(**payload)
        except ValidationError as exc:
            logger.warning("[ContextManager][Summary] Некорректный payload ingest_summary: %s", exc)
            raise HTTPException(status_code=422, detail=exc.errors()) from exc

        missing_ids = [
            idx for idx, msg in enumerate(request.messages) if not (msg.message_id or "").strip()
        ]
        if missing_ids:
            detail = [
                {"loc": ["body", "messages", idx, "message_id"], "msg": "message_id is required", "type": "value_error.missing"}
                for idx in missing_ids
            ]
            logger.warning(
                "[ContextManager][Summary] Отсутствует message_id в сообщениях: %s (conv_id=%s)",
                missing_ids,
                request.conversation_id,
            )
            raise HTTPException(status_code=422, detail=detail)

        if not settings.SUMMARY_WORKFLOWS_ENABLED:
            logger.info(
                "[ContextManager][Summary] Summary workflows disabled, пропускаем dispatch (conv_id=%s)",
                request.conversation_id,
            )
            set_temporal_status("idle")
            return {
                "status": "disabled",
                "summary": {"status": "skip", "reason": "summary_disabled"},
            }

        masked_payload = mask_sensitive_data(request.model_dump(mode="json"))
        log_event = {
            "conversation_id": request.conversation_id,
            "start_message_id": request.start_message_id,
            "end_message_id": request.end_message_id,
            "summary_level": request.summary_level,
        }
        logger.info(
            "[ContextManager][Summary] Принят запрос",
            extra={"event": log_event},
        )
        if settings.ENABLE_DEBUG_PAYLOAD_LOGGING and not is_production():
            logger.debug("[ContextManager][Summary] Payload=%s", json.dumps(masked_payload, ensure_ascii=False))

        temporal_messages, message_stats = _shrink_summary_messages(request.messages)
        metadata, metadata_stats = _shrink_summary_metadata(request.metadata)

        try:
            temporal_request = TemporalSummaryRequest(
                user_id=request.user_id,
                conversation_id=request.conversation_id,
                messages=temporal_messages,
                start_message_id=request.start_message_id,
                end_message_id=request.end_message_id,
                summary_level=request.summary_level,
                summary_model=request.summary_model,
                summary_range={
                    "start_message_id": request.start_message_id,
                    "end_message_id": request.end_message_id,
                },
                metadata=metadata,
            )
        except ValidationError as exc:
            logger.error("[ContextManager][Summary] Не удалось собрать TemporalSummaryRequest: %s", exc)
            return {
                "status": "failure",
                "summary": {"status": "failure", "reason": "serialization_error"},
            }

        payload_limit = max(0, getattr(settings, "SUMMARY_TEMPORAL_MAX_PAYLOAD_BYTES", 0) or 0)
        try:
            temporal_request, payload_stats = _enforce_total_summary_payload_limit(
                temporal_request,
                limit_bytes=payload_limit,
            )
        except SummaryPayloadTooLarge as exc:
            logger.error(
                "[ContextManager][Summary] Payload exceeded limit even after truncation (conv=%s): %s",
                request.conversation_id,
                exc,
            )
            return {
                "status": "skip",
                "summary": {
                    "status": "skip",
                    "reason": "payload_too_large",
                },
            }

        payload_bytes = payload_stats.get("payload_bytes_after") or _estimate_summary_payload_bytes(temporal_request)
        status_label = "pending"
        dispatch_event = {
            **log_event,
            "summary_queue": temporal_settings.summary_queue,
            "payload_bytes": payload_bytes,
            "messages_before": len(request.messages),
            "messages_after": len(temporal_request.messages),
        }
        logger.info(
            "[ContextManager][Summary] Dispatching workflow",
            extra={"event": dispatch_event, "status_label": "pending"},
        )

        await publish_status_event(
            {
                "service": "tools-gateway",
                "workflow": "summary",
                "status": "queued",
                "stage": "enqueue",
                "conversation_id": request.conversation_id,
                "user_id": request.user_id,
                "payload_bytes": payload_bytes,
                "trace": request.metadata,
            }
        )

        if not temporal_settings.summary_queue:
            status_label = "skipped"
            set_temporal_status("idle")
            skipped_event = {**dispatch_event, "status": status_label}
            logger.info(
                "[ContextManager][Summary] Workflow skipped",
                extra={"event": skipped_event, "status_label": status_label},
            )
            return {
                "status": status_label,
                "summary": {"status": status_label, "reason": "Summary queue not configured"},
            }

        start_time = time.perf_counter()
        try:
            summary_status = await start_summary_workflow(temporal_request)
            status_label = summary_status.get("status", "unknown")
        except WorkflowAlreadyStartedError as exc:
            summary_status = {
                "status": "already_running",
                "workflow_id": getattr(exc, "workflow_id", None),
                "run_id": getattr(exc, "run_id", None),
            }
            status_label = "already_running"
            logger.info(
                "[ContextManager][Summary] Workflow уже запущен",
                extra={"event": log_event, "status_label": status_label},
            )
        except (TemporalError, RPCError) as exc:
            summary_status = {"status": "temporal_error", "error": str(exc)}
            status_label = "temporal_error"
            logger.error(
                "[ContextManager][Summary] Temporal error",
                exc_info=True,
                extra={"event": log_event, "status_label": status_label},
            )
        except Exception as exc:  # noqa: BLE001
            summary_status = {"status": "failure", "error": str(exc)}
            status_label = "failure"
            logger.error(
                "[ContextManager][Summary] Неожиданная ошибка",
                exc_info=True,
                extra={"event": log_event, "status_label": status_label},
            )
        finally:
            duration = time.perf_counter() - start_time
            observe_summary_enqueue(duration)
            inc_summary_enqueue_total(status=status_label)
            if status_label not in {"started", "already_running"}:
                inc_summary_enqueue_failure()
            set_temporal_status(status_label)

            result_event = {
                **log_event,
                "status": status_label,
                "duration_ms": int(duration * 1000),
                "payload_bytes": payload_bytes,
                "messages_after": len(temporal_request.messages),
            }
            logger.info(
                "[ContextManager][Summary] Workflow result",
                extra={"event": result_event, "status_label": status_label},
            )

            await publish_status_event(
                {
                    "service": "tools-gateway",
                    "workflow": "summary",
                    "status": status_label,
                    "stage": "enqueue",
                    "conversation_id": request.conversation_id,
                    "user_id": request.user_id,
                    "payload_bytes": payload_bytes,
                    "duration_ms": int(duration * 1000),
                    "error": summary_status.get("error") if isinstance(summary_status, dict) else None,
                    "trace": request.metadata,
                }
            )

        return {"status": summary_status.get("status"), "summary": summary_status}


    async def ingest_memory(
        self,
        payload: Union[TemporalMemoryRequest, Dict[str, Any]],
        *,
        workflow_base_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Handles memory ingest requests and dispatches the Memory workflow."""
        try:
            request = payload if isinstance(payload, TemporalMemoryRequest) else TemporalMemoryRequest(**payload)
        except ValidationError as exc:
            logger.warning("[ContextManager][Memory] Некорректный payload ingest_memory: %s", exc)
            raise HTTPException(status_code=422, detail=exc.errors()) from exc

        masked_payload = mask_sensitive_data(request.model_dump(mode="json"))
        log_event = {
            "conversation_id": request.conversation_id,
            "message_id": request.message_id,
            "role": request.role,
        }
        logger.info("[ContextManager][Memory] Принят запрос", extra={"event": log_event})
        if settings.ENABLE_DEBUG_PAYLOAD_LOGGING and not is_production():
            logger.debug("[ContextManager][Memory] Payload=%s", json.dumps(masked_payload, ensure_ascii=False))

        status_label = "pending"
        dispatch_event = {
            **log_event,
            "memory_queue": temporal_settings.memory_queue,
        }
        logger.info(
            "[ContextManager][Memory] Dispatching workflow",
            extra={"event": dispatch_event, "status_label": status_label},
        )

        if not temporal_settings.memory_queue:
            status_label = "skipped"
            set_temporal_status("idle")
            skipped_event = {**dispatch_event, "status": status_label}
            logger.info(
                "[ContextManager][Memory] Workflow skipped",
                extra={"event": skipped_event, "status_label": status_label},
            )
            return {
                "status": status_label,
                "memory": {"status": status_label, "reason": "Memory queue not configured"},
            }

        start_time = time.perf_counter()
        try:
            memory_status = await start_memory_workflow(request, base_workflow_id=workflow_base_id)
            status_label = memory_status.get("status", "unknown")
        except (TemporalError, RPCError) as exc:
            memory_status = {"status": "temporal_error", "error": str(exc)}
            status_label = "temporal_error"
            logger.error(
                "[ContextManager][Memory] Temporal error",
                exc_info=True,
                extra={"event": log_event, "status_label": status_label},
            )
        except Exception as exc:  # noqa: BLE001
            memory_status = {"status": "failure", "error": str(exc)}
            status_label = "failure"
            logger.error(
                "[ContextManager][Memory] Неожиданная ошибка",
                exc_info=True,
                extra={"event": log_event, "status_label": status_label},
            )
        finally:
            duration = time.perf_counter() - start_time
            observe_memory_enqueue(duration)
            inc_memory_enqueue_total(status=status_label)
            if status_label not in {"started", "already_running"}:
                inc_memory_enqueue_failure()
            set_temporal_status(status_label)

            result_event = {
                **log_event,
                "status": status_label,
                "duration_ms": int(duration * 1000),
            }
            logger.info(
                "[ContextManager][Memory] Workflow result",
                extra={"event": result_event, "status_label": status_label},
            )

        return {"status": memory_status.get("status"), "memory": memory_status}

    async def shutdown(self) -> None:
        """Корректно завершает работу ContextManager, очищая все хранимые контексты."""
        async with self._lock:
            self._contexts.clear()
            logger.info("[ContextManager] Все контексты очищены при завершении работы.")


context_manager = ContextManager()
