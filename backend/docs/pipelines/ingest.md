# Ingest пайплайны (сообщения, summary, граф)

## Facade ingest (profiles)

`/tool/submit_ingest` поддерживает профили:
- `graph_only` → GraphWorkflow
- `summary_only` → SummaryWorkflow
- `memory_only` → MemoryWorkflow
- `full` → все три

`job_id` для `full` = workflow_id графа (`{base}:graph`).

### /tool/ingest_status/{job_id}

Статус асинхронного ingest job.

- Primary status: основан на `job_id` (graph workflow).
- Дочерние статусы: `summary`, `memory` — по связанным workflow_id.
- Статусы MVP: `queued`, `running`, `completed`, `failed`, `partial`, `not_found`.

## Facade ingest: graph_only

`/tool/submit_ingest` (profile=graph_only):
- валидирует входной payload и профиль,
- нормализует metadata (content_dates, role, user_id, source),
- формирует `TemporalGraphRequest` и запускает GraphWorkflow,
- не требует in-memory контекста как обязательной зависимости (опирается на payload/Mongo/workflow).

Файлы:
- [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:374)
- [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:468)

## Facade ingest: summary_only

`/tool/submit_ingest` (profile=summary_only):
- валидирует входные сообщения,
- урезает payload по лимитам,
- запускает SummaryWorkflow,
- публикует статус через NATS (если включён).

Файлы:
- [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:389)
- [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:665)
- [`backend/tools-gateway/services/nats_dispatcher.py`](backend/tools-gateway/services/nats_dispatcher.py:52)

## Ingest graph (profile=graph_only)

`/tool/submit_ingest` (profile=graph_only, mode=workflow) пишет сущности через Temporal GraphWorkflow.

## Facade ingest: memory_only

`/tool/submit_ingest` (profile=memory_only):
- валидирует payload,
- применяет лимиты размера,
- запускает MemoryWorkflow.

Файлы:
- [`backend/tools-gateway/services/workflow_launcher.py`](backend/tools-gateway/services/workflow_launcher.py:127)
- [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:873)
