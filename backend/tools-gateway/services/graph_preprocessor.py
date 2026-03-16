from __future__ import annotations

import logging
import re
from typing import List, Optional, Sequence

from services.llm import (
    GRAPH_PREMIUM_THRESHOLD_CHARS,
    ModelRoutingState,
    OPENROUTER_API_KEY,
    OPENROUTER_MODEL_FALLBACK,
    OPENROUTER_MODEL_PREMIUM,
    OPENROUTER_MODEL_PRIMARY,
    USE_OPENROUTER,
    _is_force_premium_enabled,
    context_manager,
    get_http_client,
)
from services.llm import _call_openrouter_completion
from services.text_utils import split_text_semantically

logger = logging.getLogger("tools-gateway.graph_preprocessor")

SANITIZER_SYSTEM_PROMPT = (
    "Ты редактируешь текст перед извлечением сущностей и отношений. "
    "Удали приветствия, метки USER/ASSISTANT/SYSTEM, размышления моделей и другие служебные части. "
    "Сохрани только фактические утверждения о людях, организациях, событиях, действиях и их связях. "
    "Не добавляй комментариев, не придумывай новых деталей — верни только очищенный текст."
)

SANITIZER_USER_PROMPT = (
    "Очисти текст по правилам:\n"
    "1. Удали приветствия, обращения к ассистенту, системные подсказки и размышления модели.\n"
    "2. Сохрани лишь информативные предложения про участников, их действия и отношения.\n"
    "3. Если встречаются логи или несколько разговоров, оставь только факты без служебных пометок.\n"
    "4. Не используй JSON, не добавляй пояснений — верни только очищенный текст.\n"
    "\n"
    "Контекстные флаги: {flags}\n"
    "\n"
    "Исходный текст:\n"
    "{content}\n"
)

SENTENCE_BOUNDARY_REGEX = re.compile(r"(?<=[.!?…])\s+")
DEFAULT_MAX_CHUNK_TOKENS = 3000


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, len(text) // 4)


def _resolve_start_state(forced: Optional[ModelRoutingState]) -> ModelRoutingState:
    if forced:
        return forced
    mapping = {
        ModelRoutingState.PRIMARY: OPENROUTER_MODEL_PRIMARY,
        ModelRoutingState.FALLBACK: OPENROUTER_MODEL_FALLBACK,
        ModelRoutingState.PREMIUM: OPENROUTER_MODEL_PREMIUM,
    }
    for state in (ModelRoutingState.PRIMARY, ModelRoutingState.FALLBACK, ModelRoutingState.PREMIUM):
        if mapping.get(state):
            return state
    raise RuntimeError("No OpenRouter models configured for graph sanitizer.")


async def sanitize_graph_text(
    text: str,
    conversation_id: str,
    message_id: str,
    context_flags: Sequence[str],
) -> str:
    cleaned = (text or "").strip()
    if not cleaned or not USE_OPENROUTER or not OPENROUTER_API_KEY:
        return cleaned

    forced_state: Optional[ModelRoutingState] = None
    allow_fallback = True
    if _is_force_premium_enabled():
        forced_state = ModelRoutingState.PREMIUM
        allow_fallback = False
    elif GRAPH_PREMIUM_THRESHOLD_CHARS and len(cleaned) > GRAPH_PREMIUM_THRESHOLD_CHARS:
        forced_state = ModelRoutingState.PREMIUM
        allow_fallback = False

    state_to_use = _resolve_start_state(forced_state)
    client = get_http_client()
    user_prompt = SANITIZER_USER_PROMPT.format(
        flags=", ".join(context_flags) if context_flags else "none",
        content=cleaned,
    )

    try:
        response_text, used_state, _ = await _call_openrouter_completion(
            client=client,
            messages=[
                {"role": "system", "content": SANITIZER_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            message_id=f"{message_id}#sanitize",
            attempt=1,
            channel="graph",
            forced_state=state_to_use if forced_state else None,
            allow_fallback_chain=allow_fallback,
        )
        sanitized = response_text.strip()
        if forced_state is None and used_state != ModelRoutingState.PRIMARY:
            await context_manager.reset_model_state(channel="graph")
        logger.info(
            "[GraphSanitizer] conv=%s message=%s len_before=%d len_after=%d",
            conversation_id,
            message_id,
            len(cleaned),
            len(sanitized),
        )
        return sanitized or cleaned
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[GraphSanitizer] Sanitizer failed (conv=%s, message=%s): %s",
            conversation_id,
            message_id,
            exc,
        )
        return cleaned


def chunk_text_by_sentence(text: str, max_tokens: int = DEFAULT_MAX_CHUNK_TOKENS) -> List[str]:
    cleaned = (text or "").strip()
    if not cleaned:
        return []

    sentences = [segment.strip() for segment in SENTENCE_BOUNDARY_REGEX.split(cleaned) if segment.strip()]
    if not sentences:
        sentences = [cleaned]

    chunks: List[str] = []
    current: List[str] = []
    current_tokens = 0

    def flush() -> None:
        nonlocal current, current_tokens
        if current:
            chunks.append(" ".join(current).strip())
            current = []
            current_tokens = 0

    for sentence in sentences:
        sentence_tokens = _estimate_tokens(sentence)
        if sentence_tokens > max_tokens:
            semantic_parts = split_text_semantically(sentence, max_chars=max_tokens * 4) or [sentence]
            for part in semantic_parts:
                part = part.strip()
                if not part:
                    continue
                part_tokens = _estimate_tokens(part)
                if part_tokens > max_tokens:
                    flush()
                    chunks.append(part)
                    continue
                if current_tokens + part_tokens > max_tokens:
                    flush()
                current.append(part)
                current_tokens += part_tokens
            continue

        if current_tokens + sentence_tokens > max_tokens:
            flush()
        current.append(sentence)
        current_tokens += sentence_tokens

    flush()
    return chunks or [cleaned]
