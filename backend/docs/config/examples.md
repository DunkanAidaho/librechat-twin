# Примеры конфигурации

## Минимальный .env (пример)

```
PG_CONN=postgresql+psycopg2://user:pass@postgres:5432/db
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=pass
MONGO_URI=mongodb://mongo:27017
OPENROUTER_API_KEY=sk-...
TEMPORAL_HOST=temporal
TEMPORAL_PORT=7233
TOOLS_GATEWAY_SERVICE_TOKEN=change-me
TOOLS_GATEWAY_TOOL_RATE_LIMIT_PER_MINUTE=60
TOOLS_GATEWAY_ENV=dev
TOOLS_GATEWAY_AUTH_BYPASS_IN_DEV=false
ENABLE_CYPHER_DEBUG=false
ENABLE_DEBUG_PAYLOAD_LOGGING=false
```

### Пример отладочной конфигурации (dev с отключенной авторизацией)

```
PG_CONN=postgresql+psycopg2://user:pass@postgres:5432/db
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=pass
MONGO_URI=mongodb://mongo:27017
OPENROUTER_API_KEY=sk-...
TEMPORAL_HOST=temporal
TEMPORAL_PORT=7233
TOOLS_GATEWAY_SERVICE_TOKEN=change-me
TOOLS_GATEWAY_TOOL_RATE_LIMIT_PER_MINUTE=60
TOOLS_GATEWAY_ENV=dev
TOOLS_GATEWAY_AUTH_BYPASS_IN_DEV=true
ENABLE_CYPHER_DEBUG=true
ENABLE_DEBUG_PAYLOAD_LOGGING=true
```

См. полный перечень в [`backend/tools-gateway/core/config.py`](backend/tools-gateway/core/config.py:10).
