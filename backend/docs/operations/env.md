# Переменные окружения (быстрый список)

См. полный перечень в [`backend/tools-gateway/core/config.py`](backend/tools-gateway/core/config.py:10).

Минимальный набор для запуска:
- `PG_CONN`
- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`
- `MONGO_URI` (если включены summary)
- `OPENROUTER_API_KEY` (если включены entity extraction/summary)
- `TEMPORAL_HOST`, `TEMPORAL_PORT`

Security / perimeter:
- `TOOLS_GATEWAY_SERVICE_TOKEN` — единый bearer-токен для `/tool/*` и `/temporal/*` endpoints
- `TOOLS_GATEWAY_TOOL_RATE_LIMIT_PER_MINUTE` — rate limit для `/tool/*` endpoints (per-token/per-IP)
- `TOOLS_GATEWAY_ENV` — окружение (`dev`/`prod`), по умолчанию `dev`
- `TOOLS_GATEWAY_AUTH_BYPASS_IN_DEV` — отключает проверку токена при `TOOLS_GATEWAY_ENV=dev` и `TOOLS_GATEWAY_AUTH_BYPASS_IN_DEV=true`
- `ENABLE_CYPHER_DEBUG` — разрешает использование `/cypher` endpoint в production при `ENABLE_CYPHER_DEBUG=true`
- `ENABLE_DEBUG_PAYLOAD_LOGGING` — включает debug логирование payload, отключено по умолчанию

> ⚠️ **Примечание о rate limit**: При включенном auth bypass в dev окружении rate limit применяется к специальному ключу "debug" вместо токена, что позволяет обходить ограничения по токенам, но сохраняет ограничения по IP.
