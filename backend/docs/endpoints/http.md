# HTTP эндпоинты tools-gateway

Основные маршруты объявлены в [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:241).

## Health / Metrics

- `GET /healthz` — проверка доступности.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:241)
- `GET /metrics` — метрики Prometheus + статистика контекстов.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:246)
  - Метрики: [`backend/tools-gateway/services/metrics.py`](backend/tools-gateway/services/metrics.py:1)

## Facade

- `POST /tool/search_context` — основной вход для поиска и контекста.
- `POST /tool/submit_ingest` — основной вход для ingestion (profiles).
- `GET /tool/ingest_status/{job_id}` — статус ingest job.

### POST /tool/search_context

Публичный фасад для получения hybrid context pack. Использует внутренние `/rag/search` и `/neo4j/graph_context`, но возвращает стабильный контракт.

Вход (`ToolSearchContextRequest`):
- `query` (обяз.)
- `chat_id` (обяз.)
- `message_id` (опц.)
- `user_id` (опц.)
- `agent` (опц.)
- `recent_messages` (опц.) — используется для `short_context`
- `model_limit` (опц., alias для `model_token_limit`)
- `filters.date_from/date_to/roles/content_types` (опц.)
- `include_graph` (опц.)

Выход (`ToolSearchContextResponse`):
- `status=ok`
- `context_pack.short_context`
- `context_pack.retrieved_chunks`
- `context_pack.graph_context`
- `context_pack.summaries` (MVP: optional; может быть пустым до включения summary retrieval path)
- `context_pack.sources` (MVP: может быть пустым, поле зарезервировано для unified source attribution)
- `context_pack.budget_hint`

Особенности MVP:
- `filters.content_types` поддерживает только 0/1 значение; >1 → 400.
- `budget_hint` рассчитывается приближенно.

### POST /tool/submit_ingest

Фасад асинхронного ingest. Создаёт детерминированный `job_id` и запускает выбранные workflow.

Вход (`ToolSubmitIngestRequest`):
- `chat_id` (обяз.)
- `content` **или** `message_id` (обяз.)
- `user_id` (опц.)
- `agent` (опц.)
- `ingest_profile` (опц., default=full)
- `metadata` (опц., включая source_* поля)
- `idempotency_key` (опц.)

Выход (`ToolSubmitIngestResponse`):
- `status=queued`
- `job_id` (детерминированный workflow_id)
- `ingest_profile`

Профили MVP:
- `graph_only` → GraphWorkflow
- `summary_only` → SummaryWorkflow
- `memory_only` → MemoryWorkflow
- `full` → все три

### GET /tool/ingest_status/{job_id}

Статус асинхронного ingest job.

Ответ:
- `status`: queued/running/completed/failed/partial/not_found
- `job_id`
- `children`: статусы `graph/summary/memory`
- `events`: последние события status store

## RAG / Search

- `POST /rag/search` — гибридный поиск (vector + keyword) + RRF + optional graph context.
  - Логика поиска: [`backend/tools-gateway/services/rag.py`](backend/tools-gateway/services/rag.py:192)
  - Модели запроса/ответа: [`backend/tools-gateway/models/pydantic_models.py`](backend/tools-gateway/models/pydantic_models.py:97)

## Graph / Neo4j

- `POST /neo4j/graph_context` — достаёт графовый контекст для беседы.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:257)
  - Реализация: [`backend/tools-gateway/services/neo4j.py`](backend/tools-gateway/services/neo4j.py:155)
- `POST /neo4j/set_summary` — вручную записывает summary в Neo4j.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:266)
- `POST /neo4j/delete_conversation` — удаление беседы (graph + pg + mongo).
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:290)

## Cypher

- `POST /cypher` — выполнение безопасного Cypher (read-only) с фильтром опасных команд.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:298)

## Temporal

- `POST /temporal/memory/run` — запуск MemoryWorkflow.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:310)
- `POST /temporal/summary/run` — запуск SummaryWorkflow.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:321)
- `POST /temporal/graph/run` — запуск GraphWorkflow.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:339)

## LLM

- `POST /llm/entities/extract` — синхронное извлечение сущностей (без Temporal).
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:350)
  - Логика: [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:875)

## Ingest

- `POST /ingest/message` — ingest сообщения (обновление контекста + запуск GraphWorkflow).
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:374)
  - Менеджер: [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:468)
- `POST /ingest/summary` — ingest summary (запуск SummaryWorkflow).
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:389)
  - Менеджер: [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:665)
- `POST /ingest/graph` — прямой ingest сущностей в Neo4j.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:413)
  - Реализация: [`backend/tools-gateway/services/neo4j.py`](backend/tools-gateway/services/neo4j.py:509)

## Status

- `GET /status/summary` — последние события очереди summary.
  - Хранилище: [`backend/tools-gateway/services/status_store.py`](backend/tools-gateway/services/status_store.py:14)
