# LLM и суммаризация

## Извлечение сущностей (LLM)

Пайплайн:
1) Детект флагов контекста и сбор промпта.
2) Вызов OpenRouter/Ollama/Vertex.
3) Парсинг JSON ответа.
4) Нормализация сущностей и связей.
5) Возврат списка `ExtractedEntity`.

Код:
- [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:875)
- Нормализация типов: [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:398)

## Суммаризация

`services/summary.py` генерирует summary на основе сообщений из MongoDB:
- строит prompt с предыдущим summary,
- поддерживает fallback модели,
- логирует попытки и ошибки.

Код:
- [`backend/tools-gateway/services/summary.py`](backend/tools-gateway/services/summary.py:138)
- Репозиторий Mongo: [`backend/tools-gateway/services/mongo_repository.py`](backend/tools-gateway/services/mongo_repository.py:259)

## Model routing

Состояние моделей хранится в `ContextManager` и используется для failover.

Файл: [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:322).
