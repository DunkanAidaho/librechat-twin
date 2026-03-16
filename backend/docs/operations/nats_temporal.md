# NATS и Temporal

## Temporal

Очереди:
- Graph: `TEMPORAL_GRAPH_QUEUE`
- Summary: `TEMPORAL_SUMMARY_QUEUE`
- Memory: `TEMPORAL_MEMORY_QUEUE`

Клиент: [`backend/tools-gateway/services/temporal_client.py`](backend/tools-gateway/services/temporal_client.py:15).

## NATS

Диспетчер читает JetStream и запускает воркфлоу.

Файл: [`backend/tools-gateway/services/nats_dispatcher.py`](backend/tools-gateway/services/nats_dispatcher.py:59).
