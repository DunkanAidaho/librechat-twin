# Хранилища данных

## Postgres

Хранит чанки, эмбеддинги, tsvector. Используется в RAG.

### Схема и миграции

- Обязательные DDL-миграции: таблица `chunks`, индексы для `content_tsvector` и `embedding_*`.
- Версионирование схемы и миграции в отдельном каталоге.

Файл: [`backend/tools-gateway/services/rag.py`](backend/tools-gateway/services/rag.py:121).

## Neo4j

Хранит сущности и связи для графового контекста.

### Схема и миграции

- Индексы/constraints для сущностей, связь conversation_id.
- Миграции для графовых индексов и уникальности сущностей.

Файл: [`backend/tools-gateway/services/neo4j.py`](backend/tools-gateway/services/neo4j.py:20).

## MongoDB

Хранит сообщения и summaries.

### Схема и миграции

- Индексы по `conversation_id`, `created_at`.
- Формальная фиксация версий коллекций (index migrations).

Файл: [`backend/tools-gateway/services/mongo_repository.py`](backend/tools-gateway/services/mongo_repository.py:259).
