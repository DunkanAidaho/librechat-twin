#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import asyncio
from pathlib import Path

# --- Системная инструкция ---
# Весь вывод, включая комментарии, должен быть строго на русском языке.

def apply_patch():
    """
    Применяет патч к файлу app.py для добавления логики переключения
    между основной и резервной моделями OpenRouter.
    """
    app_path = Path("app.py")
    if not app_path.exists():
        print(f"Ошибка: Файл {app_path} не найден.", file=sys.stderr)
        sys.exit(1)

    content = app_path.read_text(encoding="utf-8")

    # --- Проверка, не был ли патч применен ранее ---
    if "OPENROUTER_MODEL_PRIMARY" in content:
        print("Патч уже был применен. Изменения не требуются.", file=sys.stderr)
        sys.exit(0)

    # --- Патч 1: Добавление новых переменных конфигурации и глобального состояния ---
    print("Применение патча #1: Добавление конфигурации для резервной модели...")
    anchor_1 = 'OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api")'
    addition_1 = """
OPENROUTER_MODEL_PRIMARY = os.getenv("OPENROUTER_MODEL_PRIMARY", "mistralai/mistral-nemo:free")
OPENROUTER_MODEL_FALLBACK = os.getenv("OPENROUTER_MODEL_FALLBACK", "openai/gpt-4o-mini")

# --- Глобальное состояние для переключения моделей ---
model_fallback_active = asyncio.Event()
"""
    content = content.replace(anchor_1, anchor_1 + addition_1, 1)
    print("Патч #1 успешно применен.")

    # --- Патч 2: Добавление фоновых задач для проверки статуса основной модели ---
    print("Применение патча #2: Добавление фоновых задач...")
    anchor_2 = """
@app.post("/neo4j/cypher", response_model=CypherResponse)
async def run_cypher(req: CypherRequest) -> CypherResponse:
"""
    addition_2 = """
# -----------------------------------------------------------------------------
# Логика переключения моделей OpenRouter
# -----------------------------------------------------------------------------

async def check_primary_model_status() -> bool:
    \"\"\"Делает тестовый запрос к основной модели, чтобы проверить ее доступность.\"\"\"
    if not USE_OPENROUTER:
        return True # Если OpenRouter не используется, считаем, что все в порядке.

    logger.info("[Model Fallback] Проверка статуса основной модели: %s", OPENROUTER_MODEL_PRIMARY)
    try:
        headers = {
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "HTTP-Referer": "https://twin.mentat.su",
            "X-Title": "TwinChat",
        }
        payload = {
            "model": OPENROUTER_MODEL_PRIMARY,
            "messages": [{"role": "user", "content": "test"}],
            "max_tokens": 1,
        }
        response = await global_http_client.post(
            f"{OPENROUTER_BASE_URL}/chat/completions",
            json=payload,
            headers=headers,
            timeout=20.0
        )
        if response.status_code == 429:
            logger.warning("[Model Fallback] Основная модель недоступна (429 Rate Limit).")
            return False
        response.raise_for_status()
        logger.info("[Model Fallback] Основная модель доступна.")
        return True
    except Exception as exc:
        logger.error("[Model Fallback] Ошибка при проверке основной модели: %s", exc)
        return False

async def periodically_check_primary_model():
    \"\"\"Периодически проверяет, не восстановились ли лимиты у основной модели.\"\"\"
    # Первоначальная проверка при старте
    is_primary_available = await check_primary_model_status()
    if not is_primary_available:
        model_fallback_active.set()
        logger.warning("[Startup] Основная модель недоступна, активирован РЕЗЕРВНЫЙ режим.")
    else:
        model_fallback_active.clear()
        logger.info("[Startup] Основная модель доступна, работа в штатном режиме.")

    while True:
        await asyncio.sleep(3600) # Проверка раз в час
        if model_fallback_active.is_set():
            logger.info("[Model Fallback] Плановая проверка восстановления основной модели...")
            is_primary_available = await check_primary_model_status()
            if is_primary_available:
                model_fallback_active.clear()
                logger.info("[Model Fallback] Основная модель восстановлена! Переключение на штатный режим.")

"""
    content = content.replace(anchor_2, addition_2 + anchor_2, 1)
    print("Патч #2 успешно применен.")

    # --- Патч 3: Запуск фоновой задачи в startup_event ---
    print("Применение патча #3: Запуск фоновой задачи при старте...")
    anchor_3 = 'asyncio.create_task(cleanup_contexts_periodically())'
    addition_3 = '    asyncio.create_task(periodically_check_primary_model())\n'
    content = content.replace(anchor_3, addition_3 + '    ' + anchor_3, 1)
    print("Патч #3 успешно применен.")

    # --- Патч 4: Обновление логики в call_llm для переключения моделей ---
    print("Применение патча #4: Обновление логики вызова LLM...")
    old_call_llm_block = """            elif USE_OPENROUTER:
                await openrouter_limiter.acquire()
                payload = {"model": OPENROUTER_MODEL, "messages": current_messages, "temperature": 0.1, "max_tokens": 4096}
                headers = {
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "HTTP-Referer": "https://twin.mentat.su",
                    "X-Title": "TwinChat",
                }
                response = await global_http_client.post(f"{OPENROUTER_BASE_URL}/chat/completions", json=payload, headers=headers)
                response.raise_for_status()
                last_raw_output = response.json()["choices"][0]["message"]["content"]"""

    new_call_llm_block = """            elif USE_OPENROUTER:
                await openrouter_limiter.acquire()

                current_model = OPENROUTER_MODEL_FALLBACK if model_fallback_active.is_set() else OPENROUTER_MODEL_PRIMARY
                logger.debug("[LLM] Используется модель: %s", current_model)

                payload = {"model": current_model, "messages": current_messages, "temperature": 0.1, "max_tokens": 4096}
                headers = {
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "HTTP-Referer": "https://twin.mentat.su",
                    "X-Title": "TwinChat",
                }

                try:
                    response = await global_http_client.post(f"{OPENROUTER_BASE_URL}/chat/completions", json=payload, headers=headers)
                    response.raise_for_status()
                    last_raw_output = response.json()["choices"][0]["message"]["content"]
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code == 429 and not model_fallback_active.is_set():
                        logger.warning("[Model Fallback] Лимит основной модели исчерпан. Временно переключаемся на резервную.")
                        model_fallback_active.set()
                        
                        logger.info("[Model Fallback] Повторный запрос с использованием резервной модели: %s", OPENROUTER_MODEL_FALLBACK)
                        payload["model"] = OPENROUTER_MODEL_FALLBACK
                        response = await global_http_client.post(f"{OPENROUTER_BASE_URL}/chat/completions", json=payload, headers=headers)
                        response.raise_for_status()
                        last_raw_output = response.json()["choices"][0]["message"]["content"]
                    else:
                        raise # Перебрасываем все остальные ошибки выше"""

    content = content.replace(old_call_llm_block, new_call_llm_block, 1)

    # --- Патч 5: Замена статической переменной модели на новую основную ---
    print("Применение патча #5: Замена статической переменной модели...")
    content = content.replace(
        'OPENROUTER_MODEL = os.getenv("OPENROUTER_ENTITY_EXTRACTION_MODEL", "mistralai/mistral-nemo:free")',
        '# OPENROUTER_MODEL больше не используется напрямую, см. OPENROUTER_MODEL_PRIMARY',
        1
    )
    print("Патч #5 успешно применен.")

    # --- Запись изменений в файл ---
    app_path.write_text(content, encoding="utf-8")
    print(f"\\nВсе патчи успешно применены к файлу {app_path}.")
    print("Не забудьте добавить переменные OPENROUTER_MODEL_PRIMARY и OPENROUTER_MODEL_FALLBACK в ваше окружение.")

if __name__ == "__main__":
    apply_patch()
