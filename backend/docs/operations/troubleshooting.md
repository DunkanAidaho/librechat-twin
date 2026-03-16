# Troubleshooting

## PyTorch warning

При запуске может появляться предупреждение PyTorch (например, связанное с backend/CPU). Его можно игнорировать, если сервисы работают штатно.

## Частые симптомы

- **Пустой ответ /rag/search** — проверить TEI и PG_CONN.
  - [`backend/tools-gateway/services/embeddings.py`](backend/tools-gateway/services/embeddings.py:304)
- **Summary не запускается** — `SUMMARY_WORKFLOWS_ENABLED=false`.
  - [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:691)
- **GraphWorkflow не стартует** — не настроен `TEMPORAL_GRAPH_QUEUE`.
  - [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:569)
- **NATS не запускается** — `NATS_ENABLED=false` или невалидные `NATS_SERVERS`.
  - [`backend/tools-gateway/services/nats_dispatcher.py`](backend/tools-gateway/services/nats_dispatcher.py:68)
