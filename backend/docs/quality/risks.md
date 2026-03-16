# Риски и ограничения

1. **Единый процесс держит контекст** — при рестарте теряется память контекстов.
   - [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:329)
2. **LLM провайдеры** — нестабильность/лимиты ведут к деградации (fallback помогает, но не решает).
   - [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:528)
3. **Postgres/Neo4j/Mongo** — отсутствие миграций повышает риск рассогласования схем.
   - [`backend/tools-gateway/services/rag.py`](backend/tools-gateway/services/rag.py:121)
4. **Security** — открытые эндпоинты в доверенной сети (нужен gatekeeper).
   - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:252)
