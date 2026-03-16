# Архитектура tools-gateway

## Общая схема

`tools-gateway` — основной backend для tools-интеграций. FastAPI сервис, который принимает HTTP запросы от основного backend LibreChat, оркестрирует пайплайны обработки (RAG, граф, суммаризация) и взаимодействует с внешними хранилищами и LLM-провайдерами.

Точка входа: [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:1).

### Основные блоки

- **HTTP API** — маршруты FastAPI с валидацией через Pydantic модели.
  - См. эндпоинты в [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:241) и модели в [`backend/tools-gateway/models/pydantic_models.py`](backend/tools-gateway/models/pydantic_models.py:8).
- **Facade endpoints** — основной вход для LibreChat backend:
  - `/tool/search_context` (Search Context),
  - `/tool/submit_ingest` (Ingest событий и сообщений).
- **Ingest Profiles** — формализованный набор профилей ingest (message/summary/graph/memory).
- **RAG поиск** — PostgreSQL + pgvector, гибридный поиск (vector + keyword) и RRF.
- **RAG поиск** — PostgreSQL + pgvector, гибридный поиск (vector + keyword) и RRF.
  - [`backend/tools-gateway/services/rag.py`](backend/tools-gateway/services/rag.py:36)
- **Граф (Neo4j)** — хранение сущностей/связей и выдача графового контекста.
  - [`backend/tools-gateway/services/neo4j.py`](backend/tools-gateway/services/neo4j.py:20)
- **LLM пайплайн** — извлечение сущностей, нормализация, ретраи, модели OpenRouter/Ollama/Vertex.
  - [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:25)
- **Temporal** — запуск воркфлоу Graph/Memory/Summary.
  - [`backend/tools-gateway/services/workflow_launcher.py`](backend/tools-gateway/services/workflow_launcher.py:127)
- **NATS/JetStream** — опциональный асинхронный диспетчер задач.
  - [`backend/tools-gateway/services/nats_dispatcher.py`](backend/tools-gateway/services/nats_dispatcher.py:59)
- **MongoDB repository** — выборка сообщений и хранение summaries.
  - [`backend/tools-gateway/services/mongo_repository.py`](backend/tools-gateway/services/mongo_repository.py:259)
- **MCP adapter** — слой адаптации вызовов MCP tools и применения политики вызовов.

## Потоки данных

1. **Search Context (facade)**: клиент -> `/tool/search_context` -> валидация -> embeddings -> Postgres -> RRF -> опционально Neo4j контекст.
2. **Ingest (facade)**: клиент -> `/tool/submit_ingest` -> валидация -> выбор ingest profile -> Temporal/NATS/DB.
3. **Graph ingest**: `/tool/submit_ingest` (profile=graph) -> LLM/Neo4j.
4. **Summary ingest**: `/tool/submit_ingest` (profile=summary) -> Temporal SummaryWorkflow -> MongoDB.
5. **Прямые операции графа**: `/neo4j/graph_context`, `/neo4j/set_summary`, `/cypher`, `/ingest/graph`.

## Границы и предположения

- Сервис требует формализованных миграций БД (Postgres/Neo4j/Mongo) и версии схем.
- Контекст сообщений не хранится in-memory и должен быть вынесен в устойчивое хранилище.
- Часть пайплайнов может быть отключена через конфигурацию (Summary, NATS).

## Решения

- **tools-gateway** — основной backend для tools-интеграций и RAG.
- **Facade endpoints**: `/tool/search_context` и `/tool/submit_ingest` — единая точка входа.
- **Без in-memory ContextManager** — контекст хранится в внешнем сторе, ingestion опирается на профили.
- **Ingest profiles** — канонические профили для message/summary/graph/memory.
- **Embeddings policy** — primary/fallback модели + метрики деградации.
- **Схемы БД и миграции** — обязательные DDL и версии.
- **Security** — authn/authz, rate limits, аудит, политика PII.
- **MCP adapter** — адаптация MCP tools с policy вызова.

См. детали пайплайнов в [`backend/docs/pipelines/overview.md`](backend/docs/pipelines/overview.md) и конфигурацию в [`backend/docs/config/settings.md`](backend/docs/config/settings.md).
