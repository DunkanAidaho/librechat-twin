"""Chainlit entrypoint with structured logging and config integration."""

from __future__ import annotations

import os
from typing import Dict, Optional

import chainlit as cl
import httpx
from chainlit.input_widget import Select
from openai import AsyncOpenAI

import openrouter_models
from app_core.services.config_service import config_service
from app_core.utils.structured_logging import (
    configure_logging,
    extra_with_context,
    get_logger,
    log_exception,
)

# --- ИНИЦИАЛИЗАЦИЯ ЛОГИРОВАНИЯ И КОНФИГА ---

core_cfg = config_service.get_section("core")
configure_logging(level=core_cfg.log_level, service_name="chainlit")
logger = get_logger(__name__)

# --- КОНФИГУРАЦИЯ ---

OPENROUTER_API_KEY = os.environ.get("OPENAI_API_KEY")
OPENROUTER_BASE_URL = os.environ.get("OPENAI_API_BASE")
TEI_URL = os.environ.get("TEI_API_BASE") or config_service.get("rag.gateway.url", "http://tei-mxbai:8081")

client = AsyncOpenAI(api_key=OPENROUTER_API_KEY, base_url=OPENROUTER_BASE_URL)


async def get_embedding(text: str) -> Optional[dict]:
    """Получает эмбеддинг через TEI-сервис с журналированием ошибок."""
    try:
        async with httpx.AsyncClient() as http_client:
            response = await http_client.post(
                f"{TEI_URL}/embeddings",
                json={"inputs": text, "normalize": True},
                timeout=5.0,
            )
            response.raise_for_status()
            return response.json()
    except Exception as exc:  # pragma: no cover - сетевые ошибки
        log_exception(
            logger,
            "Ошибка при получении эмбеддингов",
            exc,
            **extra_with_context(service="tei", url=TEI_URL),
        )
        return None


def _init_model_state(models_map: Dict[str, str]) -> Dict[str, str]:
    """Подготавливает состояние модели по умолчанию для пользовательской сессии."""
    label_to_id = {label: mid for mid, label in models_map.items()}
    default_id = next(
        (mid for mid in models_map if "gemini-pro-1.5" in mid),
        next(iter(models_map)),
    )
    default_label = models_map.get(default_id, next(iter(label_to_id)))
    return {
        "default_id": default_id,
        "default_label": default_label,
        "label_to_id": label_to_id,
    }


@cl.on_chat_start
async def start() -> None:
    """Инициализирует список моделей и отображает выбор пользователю."""
    logger.info("Инициализация сессии Chainlit", extra=extra_with_context(event="chat_start"))
    models_map = await openrouter_models.fetch_and_cache_models()
    state = _init_model_state(models_map)

    ui_options = list(state["label_to_id"].keys())
    await cl.ChatSettings(
        [
            Select(
                id="Model",
                label="Выберите модель (OpenRouter)",
                values=ui_options,
                initial_value=state["default_label"],
                description="Модели сгруппированы по вендорам",
            ),
        ]
    ).send()

    cl.user_session.set("model_id", state["default_id"])
    cl.user_session.set("label_to_id", state["label_to_id"])
    cl.user_session.set("available_models", models_map)

    await cl.Message(
        content=f"**System:** Текущая модель: `{state['default_label']}`"
    ).send()
    logger.info(
        "Модель по умолчанию установлена",
        extra=extra_with_context(model_id=state["default_id"]),
    )


@cl.on_settings_update
async def setup_agent(settings: dict) -> None:
    """Обрабатывает изменение настроек пользователя."""
    selected_label = settings["Model"]
    label_to_id = cl.user_session.get("label_to_id", {})
    new_model_id = label_to_id.get(selected_label)

    if new_model_id:
        cl.user_session.set("model_id", new_model_id)
        await cl.Message(
            content=f"🔄 Модель переключена на: `{selected_label}`\nID: `{new_model_id}`"
        ).send()
        logger.info(
            "Переключена модель",
            extra=extra_with_context(model_id=new_model_id),
        )
    else:
        await cl.Message(
            content=f"⚠️ Ошибка: Не удалось найти ID для модели {selected_label}"
        ).send()
        logger.warning(
            "Не найден ID модели",
            extra=extra_with_context(selected_label=selected_label),
        )


@cl.on_message
async def main(message: cl.Message) -> None:
    """Обрабатывает входящие сообщения и стримит ответ модели."""
    model_id = cl.user_session.get("model_id")
    msg = cl.Message(content="")
    await msg.send()

    logger.info(
        "Отправка запроса в OpenRouter",
        extra=extra_with_context(model_id=model_id),
    )

    try:
        stream = await client.chat.completions.create(
            model=model_id,
            messages=[
                {"role": "system", "content": "Ты полезный ассистент."},
                {"role": "user", "content": message.content},
            ],
            stream=True,
        )
        async for part in stream:
            token = part.choices[0].delta.content
            if token:
                await msg.stream_token(token)
    except Exception as exc:  # pragma: no cover - сетевые ошибки
        log_exception(
            logger,
            "Ошибка во время стрима OpenRouter",
            exc,
            **extra_with_context(model_id=model_id),
        )
        await msg.stream_token(f"\n\n**Error:** {exc}")
    finally:
        await msg.update()
        logger.info(
            "Ответ пользователю отправлен",
            extra=extra_with_context(model_id=model_id),
        )
