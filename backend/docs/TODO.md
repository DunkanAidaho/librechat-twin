# TODO (best practices)

1. Добавить авторизацию/аутентификацию для фасадных эндпоинтов (`/tool/search_context`, `/tool/submit_ingest`).
   - См. [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:298)
2. Убрать in-memory контекст: вынести контекст в внешний стор (Redis/DB) и перейти на ingest profiles.
   - [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:329)
3. Формализовать миграции Postgres (DDL для `chunks`, индексы `content_tsvector`/`embedding_*`).
   - [`backend/tools-gateway/services/rag.py`](backend/tools-gateway/services/rag.py:121)
4. Формализовать миграции Neo4j/Mongo (индексы, constraints, версии коллекций).
   - [`backend/tools-gateway/services/neo4j.py`](backend/tools-gateway/services/neo4j.py:20)
5. Добавить rate limit/quotas на фасадные HTTP endpoints поверх существующих лимитеров LLM.
   - [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:52)
6. Реализовать `rag_recent` или удалить маршрут.
   - [`backend/tools-gateway/routes/rag_recent.py`](backend/tools-gateway/routes/rag_recent.py:26)
7. Добавить health-check для внешних зависимостей (PG/Neo4j/Mongo/Temporal).
   - [`backend/tools-gateway/core/clients.py`](backend/tools-gateway/core/clients.py:66)
