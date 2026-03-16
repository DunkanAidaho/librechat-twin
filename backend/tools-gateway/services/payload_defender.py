from __future__ import annotations

import copy
import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

logger = logging.getLogger("tools-gateway.payload-defender")

SENTENCE_BOUNDARY_REGEX = re.compile(r"(?<=[.!?…])\s+")
BASE_SEPARATOR = " "


class PayloadTooLargeError(Exception):
    """Raised when payload cannot be reduced under the configured limit."""


@dataclass
class MemoryPayloadChunk:
    payload: Dict[str, Any]
    size_bytes: int
    chunk_index: int
    chunk_total: int


@dataclass
class MemoryPayloadPlan:
    original_size: int
    limit_bytes: int
    chunks: List[MemoryPayloadChunk]

    @property
    def chunk_count(self) -> int:
        return len(self.chunks)

    @property
    def is_chunked(self) -> bool:
        return self.chunk_count > 1


def _json_size(payload: Dict[str, Any]) -> int:
    return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def _clone_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    return copy.deepcopy(payload)


def _split_sentences(text: str) -> List[str]:
    cleaned = (text or "").strip()
    if not cleaned:
        return []
    segments = [segment.strip() for segment in SENTENCE_BOUNDARY_REGEX.split(cleaned) if segment.strip()]
    return segments or [cleaned]


def _payload_size_with_content(payload_template: Dict[str, Any], content: str) -> int:
    candidate = _clone_payload(payload_template)
    candidate["content"] = content
    return _json_size(candidate)


def _shrink_text_to_limit(
    text: str,
    payload_template: Dict[str, Any],
    limit_bytes: int,
) -> Tuple[str, int]:
    trimmed = text.strip()
    if not trimmed:
        return "", 0
    if limit_bytes <= 0:
        return trimmed, len(text)

    low = 1
    high = len(trimmed)
    best_chunk = ""
    best_consumed = 0

    while low <= high:
        mid = (low + high) // 2
        candidate_raw = trimmed[:mid]
        candidate = candidate_raw.rstrip()
        if not candidate:
            low = mid + 1
            continue
        size = _payload_size_with_content(payload_template, candidate)
        if size <= limit_bytes:
            best_chunk = candidate
            best_consumed = len(candidate_raw)
            low = mid + 1
        else:
            high = mid - 1

    return best_chunk, best_consumed


def _force_split_text(
    text: str,
    payload_template: Dict[str, Any],
    limit_bytes: int,
) -> List[str]:
    remaining = text.strip()
    parts: List[str] = []

    while remaining:
        chunk, consumed = _shrink_text_to_limit(remaining, payload_template, limit_bytes)
        if not chunk or consumed <= 0:
            raise PayloadTooLargeError(
                "Unable to reduce chunk size below configured limit while splitting memory payload."
            )
        parts.append(chunk)
        remaining = remaining[consumed:].lstrip()

    return parts


def _build_sentence_chunks(
    sentences: List[str],
    payload_template: Dict[str, Any],
    limit_bytes: int,
) -> List[str]:
    chunks: List[str] = []
    current: List[str] = []

    def flush_current() -> None:
        if current:
            combined = BASE_SEPARATOR.join(current).strip()
            if combined:
                chunks.append(combined)
            current.clear()

    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue

        candidate = BASE_SEPARATOR.join(current + [sentence]).strip()
        if candidate and _payload_size_with_content(payload_template, candidate) <= limit_bytes:
            current.append(sentence)
            continue

        if current:
            flush_current()
            # try to place sentence solo in a new chunk
            if _payload_size_with_content(payload_template, sentence) <= limit_bytes:
                current.append(sentence)
                continue

        forced_parts = _force_split_text(sentence, payload_template, limit_bytes)
        chunks.extend(forced_parts)

    flush_current()
    return chunks


def plan_memory_payloads(
    payload: Dict[str, Any],
    limit_bytes: int,
) -> MemoryPayloadPlan:
    payload_copy = _clone_payload(payload)
    original_size = _json_size(payload_copy)

    if limit_bytes <= 0 or original_size <= limit_bytes:
        chunk = MemoryPayloadChunk(
            payload=payload_copy,
            size_bytes=original_size,
            chunk_index=1,
            chunk_total=1,
        )
        return MemoryPayloadPlan(
            original_size=original_size,
            limit_bytes=limit_bytes,
            chunks=[chunk],
        )

    content = str(payload_copy.get("content") or "")
    if not content.strip():
        raise PayloadTooLargeError("Memory payload exceeds limit but contains empty content.")

    sentences = _split_sentences(content)
    chunk_texts = _build_sentence_chunks(sentences, payload_copy, limit_bytes)

    if not chunk_texts:
        raise PayloadTooLargeError("Failed to split memory payload into safe chunks.")

    chunk_payloads: List[MemoryPayloadChunk] = []
    chunk_total = len(chunk_texts)
    base_message_id = str(payload_copy.get("message_id") or "")

    for index, chunk_text in enumerate(chunk_texts, start=1):
        chunk_payload = _clone_payload(payload_copy)
        chunk_payload["content"] = chunk_text
        if chunk_total > 1 and base_message_id:
            chunk_payload["message_id"] = f"{base_message_id}#part{index}"
        size_bytes = _json_size(chunk_payload)
        if size_bytes > limit_bytes > 0:
            raise PayloadTooLargeError(
                f"Chunk #{index} size {size_bytes} bytes still exceeds limit {limit_bytes} bytes."
            )
        chunk_payloads.append(
            MemoryPayloadChunk(
                payload=chunk_payload,
                size_bytes=size_bytes,
                chunk_index=index,
                chunk_total=chunk_total,
            )
        )

    logger.info(
        "[PayloadDefender] Memory payload split into %d chunks (limit=%s bytes, original=%d bytes).",
        chunk_total,
        limit_bytes or "∞",
        original_size,
    )

    return MemoryPayloadPlan(
        original_size=original_size,
        limit_bytes=limit_bytes,
        chunks=chunk_payloads,
    )
