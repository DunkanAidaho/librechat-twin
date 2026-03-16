# Поиск, контекст и граф

## RAG поиск

`/tool/search_context` выполняет гибридный поиск:
- эмбеддинг запроса (TEI, модели MXBAI/E5),
- векторный поиск по `chunks.embedding_*`,
- keyword поиск по `content_tsvector`,
- Reciprocal Rank Fusion для объединения результатов.

Ключевые элементы:
- `RAGQueryBuilder` формирует безопасные SQL с фильтрами по роли, дате, типу контента.
- `include_graph` включает обогащение контекстом из Neo4j.

Файлы:
- [`backend/tools-gateway/services/rag.py`](backend/tools-gateway/services/rag.py:36)
- [`backend/tools-gateway/services/embeddings.py`](backend/tools-gateway/services/embeddings.py:304)

## Graph context

`/neo4j/graph_context` достаёт последние связи беседы и формирует краткий контекст:
- форматирование `lines` и `query_hint`,
- ограничение по `GRAPH_CONTEXT_LINE_LIMIT`.

Файл: [`backend/tools-gateway/services/neo4j.py`](backend/tools-gateway/services/neo4j.py:155).

## Context flags

Флаги контекста используются для маршрутизации LLM и фильтрации:
- извлекаются в `detect_context_flags`,
- применяются в `ContextManager` при ingest.

Файл: [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:268).
