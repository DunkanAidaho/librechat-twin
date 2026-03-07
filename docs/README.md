# Документация LibreChat Twin

Единый индекс документации и точка входа по разделам.

## Основные индексы

- [`docs/TODO.md`](docs/TODO.md) — полный бэклог и статус работ.
- [`docs/TODO_simple.md`](docs/TODO_simple.md) — краткие эпики/инициативы.
- [`docs/project_map`](docs/project_map) — карта файлов и ссылок.
- [`docs/coder_checklist.md`](docs/coder_checklist.md) — чеклист ревью.

## Тематические разделы

- Логирование: [`docs/logging/transparent_logging.md`](docs/logging/transparent_logging.md)
- События (SSE): [`docs/event_service/event_service_api.md`](docs/event_service/event_service_api.md), [`docs/event_service/event_service_refactoring.md`](docs/event_service/event_service_refactoring.md)
- Рефакторинг: [`docs/refactoring/client_refactoring.md`](docs/refactoring/client_refactoring.md)
- Архитектура: [`docs/architecture/base_infrastructure.md`](docs/architecture/base_infrastructure.md)

## Переменные окружения

```bash
# Лимиты истории/промпта
HISTORY_TOKEN_BUDGET=12000
CONTEXT_HEADROOM_TOKENS=8000
TARGET_PROMPT_TOKENS=20000
AGENT_MAX_CONTEXT_TOKENS=40000

# Throttling / backoff
RAG_LAST_PROCESSED_MIN_PUT_MS=3000
RAG_LAST_PROCESSED_MIN_DELTA_MS=2000
RAG_LAST_PROCESSED_BACKOFF_MAX_MS=5000
MEMORY_QUEUE_BATCH_MIN=5
MEMORY_QUEUE_BATCH_MAX=25
MEMORY_QUEUE_BACKOFF_MAX_MS=5000

# RAG
RAG_CONTEXT_TOPK=15

# NATS KV для last_processed (инкрементальная индексация)
RAG_LAST_PROCESSED_BUCKET=rag_last_processed
RAG_LAST_PROCESSED_TTL_DAYS=30
RAG_LAST_PROCESSED_MAX_VALUE_SIZE=256
```

> Примечание: `TARGET_PROMPT_TOKENS` ограничивает общий prompt‑budget, а `AGENT_MAX_CONTEXT_TOKENS` жёстко капает окно модели на уровне агента.

> Примечание: NATS KV bucket `rag_last_processed` создаётся автоматически через `getOrCreateKV` при старте, вручную создавать его не требуется.

> Примечание: ключи NATS KV должны быть совместимы с NATS subject (без `:`). Сейчас используется формат `dialog.<conversationId>` и `ing.<conversationId>.<messageId|hash>`.

## Примечания по структуре

Документация группируется по тематическим подпапкам в `docs/`. При переносах обновляются ссылки в этом индексе, `docs/TODO.md` и `docs/project_map`.
