# Конфигурация

Настройки определены в [`backend/tools-gateway/core/config.py`](backend/tools-gateway/core/config.py:1). Используются Pydantic `BaseSettings` и переменные окружения.

## Ключевые блоки

### Хранилища
- `PG_CONN` — Postgres (chunks, RAG).
- `MONGO_URI`, `MONGO_DB` — MongoDB (messages, summaries).
- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` — Neo4j (graph).

См. [`backend/tools-gateway/core/config.py`](backend/tools-gateway/core/config.py:33).

### LLM / Summary
- OpenRouter: `OPENROUTER_*`, `SUMMARY_OPENROUTER_MODEL_*`.
- Ollama: `OLLAMA_URL`, `OLLAMA_ENTITY_EXTRACTION_MODEL_NAME`.
- Vertex: `GCP_PROJECT_ID`, `GCP_LOCATION`.

См. [`backend/tools-gateway/core/config.py`](backend/tools-gateway/core/config.py:42).

### TEI / embeddings
- `TEI_URL_MX`, `TEI_URL_E5`, `TEI_MAX_CHARS_PER_CHUNK`.

См. [`backend/tools-gateway/core/config.py`](backend/tools-gateway/core/config.py:27).

### NATS / JetStream
- `NATS_ENABLED`, `NATS_SERVERS`, `NATS_*`.

См. [`backend/tools-gateway/core/config.py`](backend/tools-gateway/core/config.py:96).

### Temporal
- `TEMPORAL_HOST`, `TEMPORAL_PORT`, `TEMPORAL_*_QUEUE`.

См. [`backend/tools-gateway/services/temporal_client.py`](backend/tools-gateway/services/temporal_client.py:15).

### Лимиты
- `SUMMARY_*` лимиты для payload и batching.
- `MEMORY_TEMPORAL_MAX_PAYLOAD_BYTES`.

См. [`backend/tools-gateway/core/config.py`](backend/tools-gateway/core/config.py:49).

### Security / perimeter
- `TOOLS_GATEWAY_SERVICE_TOKEN` — единый bearer-токен для `/tool/*` и `/temporal/*` endpoints
- `TOOLS_GATEWAY_TOOL_RATE_LIMIT_PER_MINUTE` — rate limit для `/tool/*` endpoints (per-token/per-IP), по умолчанию 60
- `ENABLE_CYPHER_DEBUG` — разрешает использование `/cypher` endpoint в production при `ENABLE_CYPHER_DEBUG=true`
- `ENABLE_DEBUG_PAYLOAD_LOGGING` — включает debug логирование payload, отключено по умолчанию
- `TOOLS_GATEWAY_ENV` — окружение (`dev`/`prod`), по умолчанию `dev`
- `TOOLS_GATEWAY_AUTH_BYPASS_IN_DEV` — отключает проверку токена при `TOOLS_GATEWAY_ENV=dev` и `TOOLS_GATEWAY_AUTH_BYPASS_IN_DEV=true`

> ⚠️ **Примечание о rate limit**: При включенном auth bypass в dev окружении rate limit применяется к специальному ключу "debug" вместо токена, что позволяет обходить ограничения по токенам, но сохраняет ограничения по IP.
