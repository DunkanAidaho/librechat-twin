from __future__ import annotations

import asyncio
import logging
from typing import Dict, List, Optional, Sequence, Tuple

import httpx

from core.config import settings
from services.context_manager import ModelRoutingState, context_manager
from services.llm import (
    OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL,
    OLLAMA_MODEL,
    OLLAMA_URL,
    USE_OLLAMA,
    USE_OPENROUTER,
    get_http_client,
    get_vertex_model,
    openrouter_limiter,
    vertex_limiter,
)
from services.mongo_repository import fetch_latest_summary, fetch_messages

logger = logging.getLogger("tools-gateway.summary")

SUMMARY_SYSTEM_PROMPT = (
    "Ты — внимательный аналитик диалогов. Сформулируй краткое, но информативное резюме "
    "переписки, выделяя ключевые факты, договорённости и нерешённые вопросы. "
    "Не делай выводов, которых нет в тексте."
)

PROMPT_TEMPLATE = """Ты составляешь сжатую, но полноценную выжимку переписки.

Если есть предыдущая суммаризация (Previous summary), сначала учти её, затем добавь новую информацию.
Не повторяй дословно то, что уже отражено, выделяй только изменения и новые факты.
Используй структуру:
1) Ключевые факты
2) Договорённости/следующие шаги
3) Вопросы/риски

Previous summary (может отсутствовать):
{previous_summary}

Messages:
{messages_block}
"""

MAX_PROMPT_CHARS = 16_000

SUMMARY_OPENROUTER_MODEL_PRIMARY = getattr(
    settings,
    "SUMMARY_OPENROUTER_MODEL_PRIMARY",
    getattr(settings, "SUMMARY_OPENROUTER_MODEL", None),
)
SUMMARY_OPENROUTER_MODEL_FALLBACK = getattr(
    settings,
    "SUMMARY_OPENROUTER_MODEL_FALLBACK",
    getattr(settings, "SUMMARY_OPENROUTER_MODEL", None),
)
SUMMARY_OPENROUTER_MODEL_PREMIUM = getattr(
    settings,
    "SUMMARY_OPENROUTER_MODEL_PREMIUM",
    getattr(settings, "SUMMARY_OPENROUTER_MODEL", None),
)
SUMMARY_PREMIUM_THRESHOLD_CHARS = getattr(settings, "SUMMARY_PREMIUM_THRESHOLD_CHARS", 80_000)
FORCE_ALL_TO_PREMIUM = bool(getattr(settings, "FORCE_ALL_TO_PREMIUM", False))

SUMMARY_MODEL_ROUTE_ORDER: Tuple[ModelRoutingState, ...] = (
    ModelRoutingState.PRIMARY,
    ModelRoutingState.FALLBACK,
    ModelRoutingState.PREMIUM,
)


def _summary_get_model_name_for_state(state: ModelRoutingState) -> Optional[str]:
    mapping = {
        ModelRoutingState.PRIMARY: SUMMARY_OPENROUTER_MODEL_PRIMARY,
        ModelRoutingState.FALLBACK: SUMMARY_OPENROUTER_MODEL_FALLBACK,
        ModelRoutingState.PREMIUM: SUMMARY_OPENROUTER_MODEL_PREMIUM,
    }
    value = mapping.get(state)
    if value:
        value = value.strip()
    return value or None


def _summary_first_available_state() -> Optional[ModelRoutingState]:
    for candidate in SUMMARY_MODEL_ROUTE_ORDER:
        if _summary_get_model_name_for_state(candidate):
            return candidate
    return None


def _summary_next_available_state(current_state: ModelRoutingState) -> Optional[ModelRoutingState]:
    try:
        index = SUMMARY_MODEL_ROUTE_ORDER.index(current_state)
    except ValueError:
        index = -1
    for candidate in SUMMARY_MODEL_ROUTE_ORDER[index + 1 :]:
        if _summary_get_model_name_for_state(candidate):
            return candidate
    return None



def _truncate_text(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def _format_messages_for_prompt(messages: Sequence[Dict[str, object]]) -> str:
    lines: List[str] = []
    for item in messages:
        role = (item.get("role") or "user").upper()
        content = (item.get("content") or "").strip()
        created_at = item.get("created_at")
        created_str: Optional[str] = None
        if hasattr(created_at, "isoformat"):
            created_str = created_at.isoformat()  # type: ignore[attr-defined]
        elif created_at:
            created_str = str(created_at)
        prefix = f"{created_str} " if created_str else ""
        if content:
            sanitized = content.replace("\n", " ").strip()
            lines.append(f"{prefix}{role}: {sanitized}")
    return "\n".join(lines)


def build_prompt(messages: Sequence[Dict[str, object]], previous_summary: Optional[str]) -> str:
    previous = previous_summary.strip() if previous_summary else "—"
    block = _format_messages_for_prompt(messages)
    prompt = PROMPT_TEMPLATE.format(previous_summary=previous, messages_block=block)
    return _truncate_text(prompt, MAX_PROMPT_CHARS)


async def generate_summary_text(
    messages: List[Dict[str, object]],
    max_attempts: Optional[int] = None,
    *,
    previous_summary: Optional[str] = None,
    model_override: Optional[str] = None,
    conversation_id: Optional[str] = None,
) -> str:
    """Генерирует суммаризацию для набора сообщений (без записи результата)."""
    if not messages:
        raise ValueError("messages must not be empty")

    attempts = max_attempts or settings.SUMMARY_RETRY_ATTEMPTS
    prompt = build_prompt(messages, previous_summary)
    client = get_http_client()
    last_error: Optional[str] = None
    channel = "summary"
    force_premium = FORCE_ALL_TO_PREMIUM

    for attempt in range(1, attempts + 1):
        state_for_request: Optional[ModelRoutingState] = None
        forced_state: Optional[ModelRoutingState] = None
        allow_fallback_chain = True
        used_model_state: Optional[ModelRoutingState] = None
        used_model_name: Optional[str] = None

        try:
            explicit_model = model_override or settings.SUMMARY_OPENROUTER_MODEL

            if USE_OPENROUTER and OPENROUTER_API_KEY:
                await openrouter_limiter.acquire()
                if not explicit_model:
                    if force_premium:
                        forced_state = ModelRoutingState.PREMIUM
                        allow_fallback_chain = False
                        logger.info(
                            "[Summary] FORCE_ALL_TO_PREMIUM активен — используем премиальную модель (conv=%s)",
                            conversation_id,
                        )
                    elif SUMMARY_PREMIUM_THRESHOLD_CHARS and len(prompt) > SUMMARY_PREMIUM_THRESHOLD_CHARS:
                        forced_state = ModelRoutingState.PREMIUM
                        allow_fallback_chain = False
                        logger.info(
                            "[Summary] Принудительное использование премиальной модели (conv=%s, size=%d)",
                            conversation_id,
                            len(prompt),
                        )

                    if forced_state is not None:
                        state_for_request = forced_state
                    else:
                        state_for_request = await context_manager.get_model_state(channel=channel)
                        if state_for_request is None:
                            state_for_request = _summary_first_available_state()
                            if state_for_request is None:
                                raise RuntimeError("Summary OpenRouter модели не настроены.")
                            await context_manager.set_model_state(state_for_request, channel=channel)

                    model_name = _summary_get_model_name_for_state(state_for_request)
                    if not model_name:
                        fallback_state = _summary_first_available_state()
                        if fallback_state is None:
                            raise RuntimeError("Summary OpenRouter модели не настроены.")
                        await context_manager.set_model_state(fallback_state, channel=channel)
                        state_for_request = fallback_state
                        model_name = _summary_get_model_name_for_state(state_for_request)
                        if not model_name:
                            raise RuntimeError("Не удалось определить модель Summary OpenRouter.")
                else:
                    model_name = explicit_model

                used_model_state = state_for_request
                payload = {
                    "model": model_name,
                    "messages": [
                        {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.2,
                    "max_tokens": 1024,
                }
                headers = {
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "HTTP-Referer": "https://twin.mentat.su",
                    "X-Title": "TwinChat",
                }
                used_model_name = model_name
                logger.info(
                    "[Summary] Запрос к OpenRouter (conv=%s, attempt=%d, model=%s, state=%s)",
                    conversation_id,
                    attempt,
                    model_name,
                    used_model_state.value if used_model_state else "explicit",
                )
                try:
                    response = await client.post(
                        f"{OPENROUTER_BASE_URL}/chat/completions",
                        json=payload,
                        headers=headers,
                        timeout=settings.SUMMARY_REQUEST_TIMEOUT_SECONDS,
                    )
                    response.raise_for_status()
                    text_response = response.json()["choices"][0]["message"]["content"].strip()
                    if (
                        forced_state is None
                        and used_model_state
                        and used_model_state != ModelRoutingState.PRIMARY
                    ):
                        await context_manager.reset_model_state(channel=channel)
                    return text_response
                except httpx.HTTPStatusError as exc:
                    if (
                        exc.response.status_code == 429
                        and used_model_state
                        and allow_fallback_chain
                    ):
                        next_state = _summary_next_available_state(used_model_state)
                        if next_state:
                            await context_manager.set_model_state(next_state, channel=channel)
                            logger.warning(
                                "[Summary] Получен 429, переключаемся на %s (conv=%s)",
                                next_state.value,
                                conversation_id,
                            )
                            state_for_request = next_state
                            used_model_state = next_state
                            continue
                    raise

            if USE_OLLAMA:
                payload = {
                    "model": model_override or OLLAMA_MODEL,
                    "messages": [
                        {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                        {"role": "user", "content": prompt},
                    ],
                    "stream": False,
                    "options": {"temperature": 0.2},
                }
                used_model_name = payload["model"]
                logger.info("[Summary] Запрос к Ollama (conv=%s, attempt=%d)", conversation_id, attempt)
                response = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
                response.raise_for_status()
                return (response.json().get("message", {}) or {}).get("content", "").strip()

            await vertex_limiter.acquire()
            model = get_vertex_model()
            from vertexai.generative_models import Content, GenerationConfig, Part

            cfg = GenerationConfig(temperature=0.2, max_output_tokens=1024)
            vertex_messages = [
                Content(role="user", parts=[Part.from_text(SUMMARY_SYSTEM_PROMPT)]),
                Content(role="user", parts=[Part.from_text(prompt)]),
            ]
            used_model_name = getattr(model, "model_name", "vertex_ai")
            logger.info("[Summary] Запрос к Vertex AI (conv=%s, attempt=%d)", conversation_id, attempt)
            response = await model.generate_content_async(vertex_messages, generation_config=cfg)
            return response.candidates[0].content.parts[0].text.strip()

        except Exception as exc:
            last_error = str(exc)
            logger.error(
                "[Summary] Ошибка генерации (conv=%s, attempt=%d, model=%s, state=%s): %s",
                conversation_id,
                attempt,
                used_model_name or "unknown",
                used_model_state.value if used_model_state else "n/a",
                exc,
                exc_info=True,
            )
            await asyncio.sleep(attempt)

    raise RuntimeError(last_error or "Не удалось сгенерировать summary.")


async def generate_summary_for_conversation(
    conversation_id: str,
    user_id: str,
    *,
    max_attempts: Optional[int] = None,
    message_limit: Optional[int] = None,
    model_override: Optional[str] = None,
) -> Dict[str, object]:
    """Высокоуровневый интерфейс: загружает сообщения и предыдущее summary, затем генерирует новое."""
    limit = message_limit or settings.SUMMARY_MAX_BUFFER_MESSAGES
    attempts = max_attempts or settings.SUMMARY_RETRY_ATTEMPTS

    messages = await fetch_messages(conversation_id, limit=limit, order="asc")
    previous_record = await fetch_latest_summary(conversation_id)
    previous_summary = (previous_record or {}).get("summary_text")

    if not messages:
        logger.info("[Summary] Нет сообщений для суммаризации (conv=%s)", conversation_id)
        return {
            "summary_text": None,
            "previous_summary": previous_summary,
            "messages": [],
            "model": model_override or settings.SUMMARY_OPENROUTER_MODEL or SUMMARY_OPENROUTER_MODEL_PRIMARY,
        }

    summary_text = await generate_summary_text(
        messages,
        max_attempts=attempts,
        previous_summary=previous_summary,
        model_override=model_override,
        conversation_id=conversation_id,
    )

    logger.info(
        "[Summary] Суммаризация выполнена (conv=%s, user=%s, messages=%d)",
        conversation_id,
        user_id,
        len(messages),
    )
    return {
        "summary_text": summary_text,
        "previous_summary": previous_summary,
        "messages": messages,
        "model": model_override or settings.SUMMARY_OPENROUTER_MODEL or SUMMARY_OPENROUTER_MODEL_PRIMARY,
    }
