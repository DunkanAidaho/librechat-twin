from __future__ import annotations

import asyncio
import logging
from typing import Optional

import httpx

from core.config import settings
from services.context_manager import ModelRoutingState, context_manager
from services.llm import get_http_client

logger = logging.getLogger("tools-gateway.watchdog")

USE_OPENROUTER = settings.USE_OPENROUTER_FOR_ENTITY_EXTRACTION
OPENROUTER_API_KEY = settings.OPENROUTER_API_KEY
OPENROUTER_BASE_URL = settings.OPENROUTER_BASE_URL
OPENROUTER_MODEL_PRIMARY = settings.OPENROUTER_MODEL_PRIMARY
OPENROUTER_MODEL_FALLBACK = settings.OPENROUTER_MODEL_FALLBACK
OPENROUTER_MODEL_PREMIUM = settings.OPENROUTER_MODEL_PREMIUM
SUMMARY_OPENROUTER_MODEL_PRIMARY = getattr(
    settings,
    "SUMMARY_OPENROUTER_MODEL_PRIMARY",
    getattr(settings, "SUMMARY_OPENROUTER_MODEL", settings.OPENROUTER_MODEL_PRIMARY),
)
SUMMARY_OPENROUTER_MODEL_FALLBACK = getattr(
    settings,
    "SUMMARY_OPENROUTER_MODEL_FALLBACK",
    getattr(settings, "SUMMARY_OPENROUTER_MODEL", settings.OPENROUTER_MODEL_FALLBACK),
)
SUMMARY_OPENROUTER_MODEL_PREMIUM = getattr(
    settings,
    "SUMMARY_OPENROUTER_MODEL_PREMIUM",
    getattr(settings, "SUMMARY_OPENROUTER_MODEL", settings.OPENROUTER_MODEL_PREMIUM),
)
FORCE_ALL_TO_PREMIUM = bool(getattr(settings, "FORCE_ALL_TO_PREMIUM", False))

CHANNEL_MODEL_CONFIG = {
    "graph": {
        ModelRoutingState.PRIMARY: OPENROUTER_MODEL_PRIMARY,
        ModelRoutingState.FALLBACK: OPENROUTER_MODEL_FALLBACK,
        ModelRoutingState.PREMIUM: OPENROUTER_MODEL_PREMIUM,
    },
    "summary": {
        ModelRoutingState.PRIMARY: SUMMARY_OPENROUTER_MODEL_PRIMARY,
        ModelRoutingState.FALLBACK: SUMMARY_OPENROUTER_MODEL_FALLBACK,
        ModelRoutingState.PREMIUM: SUMMARY_OPENROUTER_MODEL_PREMIUM,
    },
}
ROUTING_ORDER = (
    ModelRoutingState.PRIMARY,
    ModelRoutingState.FALLBACK,
    ModelRoutingState.PREMIUM,
)



async def _check_model_status(model_name: Optional[str]) -> bool:
    """Проверяет доступность конкретной модели OpenRouter."""
    if not USE_OPENROUTER:
        return True
    if not model_name:
        return False

    logger.debug("[Model Watchdog] Проверка доступности модели %s", model_name)

    client: Optional[httpx.AsyncClient]
    created_client = False
    try:
        client = get_http_client()
    except RuntimeError:
        client = httpx.AsyncClient(timeout=60.0)
        created_client = True

    try:
        headers = {
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "HTTP-Referer": "https://twin.mentat.su",
            "X-Title": "TwinChat",
        }
        payload = {
            "model": model_name,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
        }
        response = await client.post(
            f"{OPENROUTER_BASE_URL}/chat/completions",
            json=payload,
            headers=headers,
            timeout=60.0,
        )
        if response.status_code == 429:
            logger.warning("[Model Watchdog] Модель %s ответила 429 (rate limit).", model_name)
            return False
        response.raise_for_status()
        logger.debug("[Model Watchdog] Модель %s доступна.", model_name)
        return True
    except Exception as exc:
        logger.error(
            "[Model Watchdog] Ошибка при проверке модели %s: %s",
            model_name,
            exc,
            exc_info=True,
        )
        return False
    finally:
        if created_client:
            await client.aclose()


async def check_primary_model_status() -> bool:
    """Совместимость с предыдущим API: проверяет основную модель graph-канала."""
    return await _check_model_status(OPENROUTER_MODEL_PRIMARY)


async def _set_state_for_channel(channel: str, state: ModelRoutingState) -> None:
    await context_manager.set_model_state(state, channel=channel)
    logger.info("[Model Watchdog] Канал %s переведён в состояние %s", channel, state.value)


async def _evaluate_channel(channel: str) -> None:
    mapping = CHANNEL_MODEL_CONFIG.get(channel, {})
    current_state = await context_manager.get_model_state(channel=channel)

    for state in ROUTING_ORDER:
        model_name = mapping.get(state)
        if await _check_model_status(model_name):
            if current_state != state:
                if state == ModelRoutingState.PRIMARY:
                    logger.info("[Model Watchdog] Канал %s: основная модель восстановлена.", channel)
                elif state == ModelRoutingState.FALLBACK:
                    logger.warning("[Model Watchdog] Канал %s: переходим на fallback.", channel)
                else:
                    logger.error("[Model Watchdog] Канал %s: переходим на премиальную модель.", channel)
                await _set_state_for_channel(channel, state)
            return

    logger.error("[Model Watchdog] Канал %s: ни одна из моделей не отвечает.", channel)


async def periodically_check_primary_model() -> None:
    """Периодически проверяет доступность моделей для обоих каналов."""
    while True:
        if FORCE_ALL_TO_PREMIUM:
            for channel in CHANNEL_MODEL_CONFIG:
                await _set_state_for_channel(channel, ModelRoutingState.PREMIUM)
            logger.warning("[Model Watchdog] FORCE_ALL_TO_PREMIUM активен — каналы закреплены в премиум-режиме.")
            await asyncio.sleep(3600)
            continue

        for channel in CHANNEL_MODEL_CONFIG:
            await _evaluate_channel(channel)

        await asyncio.sleep(6000)
