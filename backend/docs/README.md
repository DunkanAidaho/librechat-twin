# Backend документация (tools-gateway)

Код backend находится в [`backend/tools-gateway`](backend/tools-gateway). Документация описывает реальные компоненты и потоки данных сервиса, не затрагивая frontend.

## Что это за сервис

`tools-gateway` — основной backend для tools-интеграций и RAG. FastAPI сервис для:
- RAG/поиска по чанкам (PostgreSQL + pgvector),
- извлечения сущностей и связей через LLM,
- работы с графом (Neo4j),
- суммаризации переписок,
- запуска Temporal воркфлоу,
- интеграции с NATS/JetStream.

Точка входа: [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:1).

## Product packaging roadmap (этапы 0–8)

0. **Bootstrap** — минимальный `tools-gateway` с `/healthz`, базовой конфигурацией и логированием.
1. **Search Context MVP** — фасадный endpoint `/tool/search_context`, Postgres+pgvector, гибридный поиск, базовая схема `chunks`.
2. **Ingest MVP** — фасадный endpoint `/tool/submit_ingest`, канонизация payload, первичная разметка типов ingest.
3. **Graph enrichment** — Neo4j контекст по беседе, нормализация сущностей, ограничение размера контекста.
4. **Summary pipeline** — Temporal workflow + MongoDB, контроль лимитов payload.
5. **Embeddings hardening** — политика выбора эмбеддингов (primary/fallback), метрики качества и rate limits.
6. **Storage migrations** — формальные миграции (DDL/индексы/версии) для Postgres/Neo4j/Mongo.
7. **Security & policy** — authn/authz, ограничения tools-вызовов, аудит и защита PII.
8. **MCP adapter** — слой адаптации MCP tooling и единые политики вызовов tools.

## Состав документации

- Roadmap продукта: [`backend/docs/roadmap.md`](backend/docs/roadmap.md)
- Архитектура: [`backend/docs/architecture/overview.md`](backend/docs/architecture/overview.md)
- Эндпоинты: [`backend/docs/endpoints/http.md`](backend/docs/endpoints/http.md)
- Пайплайны: [`backend/docs/pipelines/overview.md`](backend/docs/pipelines/overview.md)
- Сервисы: [`backend/docs/services/overview.md`](backend/docs/services/overview.md)
- Поиск и графовый контекст: [`backend/docs/services/rag.md`](backend/docs/services/rag.md)
- Ингест и граф: [`backend/docs/pipelines/ingest.md`](backend/docs/pipelines/ingest.md)
- LLM/суммаризация: [`backend/docs/services/llm_and_summary.md`](backend/docs/services/llm_and_summary.md)
- Конфигурация: [`backend/docs/config/settings.md`](backend/docs/config/settings.md)
- Зависимости: [`backend/docs/dependencies/external.md`](backend/docs/dependencies/external.md)
- Операции/наблюдаемость: [`backend/docs/operations/observability.md`](backend/docs/operations/observability.md)
- Качество и риски: [`backend/docs/quality/strengths_weaknesses.md`](backend/docs/quality/strengths_weaknesses.md)
- Best practices TODO: [`backend/docs/TODO.md`](backend/docs/TODO.md)
- Best practices FIX: [`backend/docs/FIX.md`](backend/docs/FIX.md)
