# Postgres (chunks)

Требуется таблица `chunks` с колонками:
- `content`, `content_tsvector`,
- `embedding_mxbai`, `embedding_e5`,
- `metadata` (jsonb).

## Миграции

- DDL/индексы фиксируются в миграциях.
- Версии миграций обязательны для production.

Используется в RAG pipeline.

Файл: [`backend/tools-gateway/services/rag.py`](backend/tools-gateway/services/rag.py:121).
