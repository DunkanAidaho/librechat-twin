# LLM провайдеры

## OpenRouter

Основной провайдер для extraction и summary. Поддерживает fallback на premium.

Файл: [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:574).

## Ollama

Локальный fallback для extraction и summary.

Файл: [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:684).

## Vertex AI

Используется при отсутствии OpenRouter/Ollama.

Файл: [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:707).
