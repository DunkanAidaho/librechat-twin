# Операции и наблюдаемость

## Логирование

Инициализация через `configure_logging`.

Файл: [`backend/tools-gateway/core/logging.py`](backend/tools-gateway/core/logging.py:1).

## Метрики

Prometheus метрики включают:
- `graph_workflow_enqueue_total`, `summary_workflow_enqueue_total`, `memory_workflow_enqueue_total`,
- `conversation_context_total`, `conversation_context_overflow_total`,
- `temporal_dispatcher_status`,
- `tools_policy_denied_total` (policy вызова tools).

Файл: [`backend/tools-gateway/services/metrics.py`](backend/tools-gateway/services/metrics.py:1).

## Status events

`status_store` держит последние события summary. NATS dispatcher публикует статусы в JetStream.

Файлы:
- [`backend/tools-gateway/services/status_store.py`](backend/tools-gateway/services/status_store.py:1)
- [`backend/tools-gateway/services/nats_dispatcher.py`](backend/tools-gateway/services/nats_dispatcher.py:52)

## Graceful shutdown

Остановка клиентов (HTTP, Neo4j, Temporal, SQLAlchemy) реализована в shutdown hook.

Файл: [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:210).
