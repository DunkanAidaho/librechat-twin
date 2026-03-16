# Безопасность и ограничения

- `/cypher` запрещает опасные команды regex-фильтром, но не гарантирует read-only режим.
  - В prod отключён без флага `ENABLE_CYPHER_DEBUG=true`.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:323)
- `/tool/*` и `/temporal/*` защищены единым bearer-токеном `Authorization: Bearer <SERVICE_TOKEN>`.
  - Токен задаётся через `TOOLS_GATEWAY_SERVICE_TOKEN`.
  - Проверка может быть отключена в dev режиме при `TOOLS_GATEWAY_ENV=dev` и `TOOLS_GATEWAY_AUTH_BYPASS_IN_DEV=true`.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:149)
- Базовый rate limit для `/tool/*` (per-token/per-IP) включён по умолчанию.
  - `TOOLS_GATEWAY_TOOL_RATE_LIMIT_PER_MINUTE`.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:149)
- Debug логирование payload выключается через `ENABLE_DEBUG_PAYLOAD_LOGGING=false` (по умолчанию disabled).
  - Всегда отключено в production окружении.
  - [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:485)

## Policy вызова tools

- Единая policy применяется на фасадных endpoint `/tool/search_context` и `/tool/submit_ingest`.
- Ограничения: allowlist tools, лимиты payload, rate limits, аудит запросов.
- Политика включает проверку user_id, trace_id (tenant_id — опционален, если включён в workspace/tenant model).

## MCP adapter

MCP adapter применяет policy и преобразует MCP вызовы в канонический формат tools-gateway.
