# Пайплайны обработки

## 1. Search Context (facade)

1) Запрос приходит на `/tool/search_context`.
2) Валидация payload и нормализация параметров (filters, include_graph, policy).
3) Вычисление эмбеддингов через TEI (primary/fallback).
4) Два запроса в Postgres: векторный и keyword (`content_tsvector`).
5) Объединение результатов через RRF + подсчёт match_type.
6) Опционально подтягивается графовый контекст из Neo4j.
7) Ответ возвращается в унифицированном формате `SearchContextResponse`.

Код:
- [`backend/tools-gateway/services/rag.py`](backend/tools-gateway/services/rag.py:192)
- [`backend/tools-gateway/services/embeddings.py`](backend/tools-gateway/services/embeddings.py:304)

## 2. Ingest (facade) -> профили

1) `/tool/submit_ingest` принимает payload и `profile`.
2) Профиль валидирует схему (message/summary/graph/memory).
3) Формируется канонический payload (trace_id, conversation_id, user_id).
4) Выбор стратегии: синхронно (graph direct) или асинхронно (Temporal/NATS).
5) Обогащение метаданными (content_dates, role, source).
6) Диспетчеризация в Graph/Summary/Memory workflow.

Код:
- [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:374)
- [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:468)
- [`backend/tools-gateway/services/workflow_launcher.py`](backend/tools-gateway/services/workflow_launcher.py:305)

## 3. Ingest summary -> SummaryWorkflow

1) `/tool/submit_ingest` (profile=summary) принимает батч сообщений.
2) Payload ограничивается по количеству и размеру.
3) Запускается `SummaryWorkflow` в Temporal.
4) Воркфлоу пишет summary в MongoDB.
5) Опционально публикуются status events через NATS.

Код:
- [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:389)
- [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:665)
- [`backend/tools-gateway/services/workflow_launcher.py`](backend/tools-gateway/services/workflow_launcher.py:189)
- [`backend/tools-gateway/services/mongo_repository.py`](backend/tools-gateway/services/mongo_repository.py:310)

## 4. MemoryWorkflow

Отдельный пайплайн для задач памяти. Payload может быть разрезан на части, если превышает лимит.

Код:
- [`backend/tools-gateway/services/workflow_launcher.py`](backend/tools-gateway/services/workflow_launcher.py:127)
- [`backend/tools-gateway/services/payload_defender.py`](backend/tools-gateway/services/payload_defender.py:158)

## 5. Прямой графовый ingest

`/tool/submit_ingest` (profile=graph, mode=direct) позволяет писать сущности напрямую в Neo4j без Temporal.

Код:
- [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:413)
- [`backend/tools-gateway/services/neo4j.py`](backend/tools-gateway/services/neo4j.py:509)
