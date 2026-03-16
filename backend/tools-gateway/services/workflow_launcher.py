from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError as TemporalRPCError

from core.config import settings
from models.pydantic_models import (
    TemporalGraphRequest,
    TemporalMemoryRequest,
    TemporalSummaryRequest,
)
from services.payload_defender import PayloadTooLargeError, plan_memory_payloads
from services.temporal_client import get_temporal_client, temporal_settings
from services.metrics import (
    inc_graph_enqueue_total, observe_graph_enqueue,
    inc_memory_enqueue_total, observe_memory_enqueue,
    inc_summary_enqueue_total, observe_summary_enqueue,
)

logger = logging.getLogger("tools-gateway.temporal-dispatch")


def _payload_size_bytes(payload: Dict[str, Any]) -> int:
    try:
        return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    except Exception:
        return -1


async def _launch_memory_chunk(
    client,
    payload: Dict[str, Any],
    workflow_id: str,
    payload_size: int,
) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "workflow_id": workflow_id,
        "run_id": None,
        "status": "error",
        "reason": None,
        "payload_bytes": payload_size,
    }

    try:
        handle = await client.start_workflow(
            "MemoryWorkflow",
            payload,
            id=workflow_id,
            task_queue=temporal_settings.memory_queue,
        )
        result["run_id"] = handle.run_id
        result["status"] = "started"
        logger.info(
            "[Temporal][MemoryWorkflow] Started chunk (workflow_id=%s, run_id=%s, conv_id=%s, message_id=%s, bytes=%s)",
            workflow_id,
            handle.run_id,
            payload.get("conversation_id"),
            payload.get("message_id"),
            payload_size,
        )
    except WorkflowAlreadyStartedError as exc:
        result["run_id"] = getattr(exc, "run_id", None)
        result["status"] = "already_running"
        logger.info(
            "[Temporal][MemoryWorkflow] Chunk already running (workflow_id=%s, run_id=%s, conv_id=%s, message_id=%s)",
            workflow_id,
            result["run_id"],
            payload.get("conversation_id"),
            payload.get("message_id"),
        )
    except Exception as exc:
        result["reason"] = str(exc)
        logger.error(
            "[Temporal][MemoryWorkflow] Failed to start chunk (workflow_id=%s, conv_id=%s, message_id=%s, bytes=%s): %s",
            workflow_id,
            payload.get("conversation_id"),
            payload.get("message_id"),
            payload_size,
            exc,
            exc_info=True,
        )

    return result


def _summarize_chunk_statuses(chunks: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not chunks:
        return {
            "workflow_id": None,
            "run_id": None,
            "status": "error",
            "reason": "no_chunks_started",
            "payload_bytes": 0,
            "chunks": [],
            "chunk_count": 0,
        }

    first = chunks[0]
    statuses = [chunk.get("status") for chunk in chunks]
    failures = [chunk for chunk in chunks if chunk.get("status") not in {"started", "already_running"}]

    if not failures:
        overall_status = statuses[0] if len(set(statuses)) == 1 else "started"
        reason = None
    else:
        overall_status = failures[0].get("status")
        if 0 < len(failures) < len(chunks):
            overall_status = "partial_failure"
        reason = failures[0].get("reason")

    return {
        "workflow_id": first.get("workflow_id"),
        "run_id": first.get("run_id"),
        "status": overall_status,
        "reason": reason,
        "payload_bytes": sum(chunk.get("payload_bytes", 0) for chunk in chunks),
        "chunks": chunks,
        "chunk_count": len(chunks),
    }


async def start_memory_workflow(
    req: TemporalMemoryRequest,
    *,
    base_workflow_id: Optional[str] = None,
) -> Dict[str, Any]:
    payload = req.dict()
    if not payload.get("created_at"):
        payload["created_at"] = datetime.utcnow().isoformat()

    limit_bytes = getattr(settings, "MEMORY_TEMPORAL_MAX_PAYLOAD_BYTES", 0) or 0

    try:
        plan = plan_memory_payloads(payload, limit_bytes)
    except PayloadTooLargeError as exc:
        payload_bytes = _payload_size_bytes(payload)
        logger.error(
            "[Temporal][MemoryWorkflow] Payload rejected (conv_id=%s, message_id=%s, bytes=%s): %s",
            req.conversation_id,
            req.message_id,
            payload_bytes,
            exc,
        )
        return {
            "workflow_id": None,
            "run_id": None,
            "status": "skip",
            "reason": "payload_too_large",
            "payload_bytes": payload_bytes,
        }

    if plan.is_chunked:
        logger.warning(
            "[Temporal][MemoryWorkflow] Payload exceeds limit; splitting (conv_id=%s, message_id=%s, chunks=%d, original_bytes=%d, limit=%s)",
            req.conversation_id,
            req.message_id,
            plan.chunk_count,
            plan.original_size,
            plan.limit_bytes or "∞",
        )

    client = await get_temporal_client()
    chunk_results: List[Dict[str, Any]] = []

    for chunk in plan.chunks:
        chunk_payload = chunk.payload
        if base_workflow_id:
            if plan.is_chunked:
                chunk_workflow_id = f"{base_workflow_id}:chunk:{chunk.chunk_index}"
            else:
                chunk_workflow_id = base_workflow_id
        else:
            chunk_workflow_id = f"memory-{chunk_payload.get('conversation_id')}-{chunk_payload.get('message_id')}"
        chunk_result = await _launch_memory_chunk(
            client=client,
            payload=chunk_payload,
            workflow_id=chunk_workflow_id,
            payload_size=chunk.size_bytes,
        )
        chunk_result["chunk_index"] = chunk.chunk_index
        chunk_result["chunk_total"] = chunk.chunk_total
        chunk_results.append(chunk_result)

    if not plan.is_chunked:
        return chunk_results[0]

    aggregate = _summarize_chunk_statuses(chunk_results)
    aggregate["payload_bytes"] = plan.original_size
    aggregate.setdefault("chunks", chunk_results)
    aggregate.setdefault("chunk_count", len(chunk_results))
    return aggregate


async def start_summary_workflow(
    req: TemporalSummaryRequest,
    *,
    base_workflow_id: Optional[str] = None,
) -> Dict[str, Any]:
    workflow_id = base_workflow_id or (
        f"summary-{req.conversation_id}-{req.start_message_id}-{req.end_message_id}"
    )
    message_count = len(req.messages or [])
    if not settings.SUMMARY_WORKFLOWS_ENABLED:
        logger.info(
            "[Temporal][SummaryWorkflow] SUMMARY_WORKFLOWS_ENABLED=false, пропускаем запуск (workflow_id=%s)",
            workflow_id,
        )
        return {
            "workflow_id": workflow_id,
            "run_id": None,
            "status": "skip",
            "reason": "summary_disabled",
            "payload_bytes": 0,
            "message_count": message_count,
        }

    payload = req.dict()
    payload_size = _payload_size_bytes(payload)

    client = await get_temporal_client()

    result: Dict[str, Any] = {
        "workflow_id": workflow_id,
        "run_id": None,
        "status": "error",
        "reason": None,
        "payload_bytes": payload_size,
        "message_count": message_count,
    }

    max_payload_bytes = getattr(settings, "SUMMARY_TEMPORAL_MAX_PAYLOAD_BYTES", 0) or 0
    if max_payload_bytes and payload_size > max_payload_bytes:
        result["status"] = "skip"
        result["reason"] = "payload_too_large_precheck"
        logger.warning(
            "[Temporal][SummaryWorkflow] Payload превышает лимит до запуска (workflow_id=%s, conv_id=%s, bytes=%s, limit=%s, messages=%d)",
            workflow_id,
            req.conversation_id,
            payload_size,
            max_payload_bytes,
            message_count,
        )
        return result

    try:
        handle = await client.start_workflow(
            "SummaryWorkflow",
            payload,
            id=workflow_id,
            task_queue=temporal_settings.summary_queue,
        )
        result["run_id"] = handle.run_id
        result["status"] = "started"
        logger.info(
            "[Temporal][SummaryWorkflow] Запущен успешно (workflow_id=%s, run_id=%s, conv_id=%s, payload_bytes=%s, messages=%d)",
            workflow_id,
            handle.run_id,
            req.conversation_id,
            payload_size,
            message_count,
        )
    except WorkflowAlreadyStartedError as exc:
        result["run_id"] = getattr(exc, "run_id", None)
        result["status"] = "already_running"
        logger.info(
            "[Temporal][SummaryWorkflow] Уже запущен (workflow_id=%s, run_id=%s, conv_id=%s)",
            workflow_id,
            result["run_id"],
            req.conversation_id,
        )
    except TemporalRPCError as exc:
        message = getattr(exc, "message", str(exc))
        if message and (
            "Blob data size exceeds limit" in message
            or "ResourceExhausted" in message
            or "message larger than max" in message
        ):
            result["status"] = "skip"
            result["reason"] = "payload_too_large"
            logger.error(
                "[Temporal][SummaryWorkflow] Пропуск из-за превышения payload-limit (workflow_id=%s, conv_id=%s, payload_bytes=%s, messages=%d): %s",
                workflow_id,
                req.conversation_id,
                payload_size,
                message_count,
                message,
            )
        else:
            result["reason"] = message
            logger.error(
                "[Temporal][SummaryWorkflow] RPC ошибка при запуске (workflow_id=%s, conv_id=%s, payload_bytes=%s, messages=%d): %s",
                workflow_id,
                req.conversation_id,
                payload_size,
                message_count,
                message,
                exc_info=True,
            )
    except Exception as exc:
        result["reason"] = str(exc)
        logger.error(
            "[Temporal][SummaryWorkflow] Ошибка при запуске (workflow_id=%s, conv_id=%s, payload_bytes=%s, messages=%d): %s",
            workflow_id,
            req.conversation_id,
            payload_size,
            message_count,
            exc,
            exc_info=True,
        )

    return result


async def start_graph_workflow(
    req: TemporalGraphRequest,
    *,
    base_workflow_id: Optional[str] = None,
) -> Dict[str, Any]:
    payload = req.dict()
    if not payload.get("created_at"):
        payload["created_at"] = datetime.utcnow().isoformat()

    payload_size = _payload_size_bytes(payload)

    client = await get_temporal_client()
    workflow_id = base_workflow_id or f"graph-{req.conversation_id}-{req.message_id}"

    result: Dict[str, Any] = {
        "workflow_id": workflow_id,
        "run_id": None,
        "status": "error",
        "reason": None,
        "payload_bytes": payload_size,
    }

    try:
        handle = await client.start_workflow(
            "GraphWorkflow",
            payload,
            id=workflow_id,
            task_queue=temporal_settings.graph_queue,
        )
        result["run_id"] = handle.run_id
        result["status"] = "started"
        logger.info(
            "[Temporal][GraphWorkflow] Запущен успешно (workflow_id=%s, run_id=%s, conv_id=%s, payload_bytes=%s)",
            workflow_id,
            handle.run_id,
            req.conversation_id,
            payload_size,
        )
    except WorkflowAlreadyStartedError as exc:
        result["run_id"] = getattr(exc, "run_id", None)
        result["status"] = "already_running"
        logger.info(
            "[Temporal][GraphWorkflow] Уже запущен (workflow_id=%s, run_id=%s, conv_id=%s)",
            workflow_id,
            result["run_id"],
            req.conversation_id,
        )
    except Exception as exc:
        result["reason"] = str(exc)
        logger.error(
            "[Temporal][GraphWorkflow] Ошибка при запуске (workflow_id=%s, conv_id=%s, payload_bytes=%s): %s",
            workflow_id,
            req.conversation_id,
            payload_size,
            exc,
            exc_info=True,
        )

    return result
