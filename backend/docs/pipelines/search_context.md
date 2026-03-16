# Search Context pipeline

`/tool/search_context` — фасадный endpoint для RAG + graph context.
`short_context` собирается из `recent_messages` (role: content) и не участвует в retrieval.

## Детальный pipeline

1. **Валидация** — проверка идентификаторов чата/источника, `query`, `filters`, `include_graph`, `model_limit` (alias для `model_token_limit`).
2. **Нормализация** — сбор `ToolSearchContextRequest` (trace_id, policy, limits).
3. **Embeddings policy** — выбор primary модели, fallback при ошибке/latency.
4. **Hybrid search** — векторный + keyword поиск по `chunks`.
5. **RRF** — объединение результатов и расчёт match_type.
6. **Graph context** — при `include_graph=true` запрос в Neo4j.
7. **Response shaping** — сортировка, ограничение топ-N, добавление `graph_context` и `short_context`.

## Текущая реализация MVP

1. `search_documents` выполняет поиск по чанкам.
2. При наличии `conversation_id` запрашивается `fetch_graph_context`.
3. `GraphContextResponse` добавляется в ответ.

Код:
- [`backend/tools-gateway/services/rag.py`](backend/tools-gateway/services/rag.py:226)
- [`backend/tools-gateway/services/neo4j.py`](backend/tools-gateway/services/neo4j.py:155)
