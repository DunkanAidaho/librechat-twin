# ТЗ: Temporal Summary интеграция + протокол статусов (NATS default, HTTP fallback)

## Контекст и цель
Нужно разделить «локальный» RAG‑ingest summary (используется для индекса/поиска) и «Temporal SummaryWorkflow» (оркестрация на втором сервере). Сейчас Temporal summary не влияет на сборку prompt в [`BaseClient`](../api/app/clients/BaseClient.js:1486). Требуется:
1) Уметь **полностью отключать** Temporal summary со стороны Node‑сервера (`api/`).
2) Добавить **протокол статусов и трассировки** между серверами: NATS как default транспорт, HTTP fallback.
3) Спроектировать **интеграцию результата Temporal summary в `Message.summary`** (будущая реализация), с защитой от 4MB лимита и безопасным payload‑guard.

## СКОП (наша сторона — `api/`)
### 1. Логика и проверка summary использования
- В Node‑сервере summary используется в prompt **только** если `Message.summary` заполнен.
- Поэтому без интеграции Temporal summary это поле не заполняется.

### 2. Документация (tech debt)
- Зафиксировать задачу по интеграции Temporal summary → `Message.summary` в [`docs/TODO.md`](../docs/TODO.md:25).

## СКОП (backend — `backend/tools-gateway`, `backend/temporal`)
### A. Протокол статусов/трассировки (NATS default, HTTP fallback)
#### A1. NATS события (default)
- Topic/subject: `status.summary` (дополнительно `status.memory`, `status.graph`).
- Payload (JSON):
  - `service`: `tools-gateway` | `temporal-worker`
  - `workflow`: `summary` | `memory` | `graph`
  - `status`: `queued` | `started` | `running` | `success` | `error` | `skipped`
  - `conversation_id`, `user_id`
  - `workflow_id`, `run_id`
  - `stage`: `enqueue` | `generate` | `ingest` | `persist` | `sync_neo4j`
  - `duration_ms`, `payload_bytes`
  - `error`: `{message, code, stack?}`
  - `trace_id`/`request_id` (сквозная трассировка)
- Логи в [`backend/tools-gateway/services/context_manager.py`](../backend/tools-gateway/services/context_manager.py:627) и [`backend/temporal/worker_app/workflows_summary.py`](../backend/temporal/worker_app/workflows_summary.py:24).

#### A2. HTTP fallback
- Endpoint в tools‑gateway: `/status/summary`.
- Ответ: последние N статусов + агрегаты (counts, last_error).
- Node‑сервер дергает HTTP при недоступности NATS.

### B. Payload‑guard (4MB gRPC лимит) + корректная обработка таймаутов
- Уже есть `_enforce_total_summary_payload_limit` в [`context_manager`](../backend/tools-gateway/services/context_manager.py:702). Нужно:
  - Явный лимит ENV: `SUMMARY_TEMPORAL_MAX_PAYLOAD_BYTES` (например, 3.5MB для запасов).
  - Логирование `payload_bytes_before/after` и действия по обрезке.
  - Статус `payload_too_large` с метаданными.
  - Согласовать таймауты `SummaryWorkflow` и `activities_summary` с реальным временем генерации/ingest (из логов таймауты случаются даже при успешной генерации).
  - При превышении таймаута — не терять результат: писать статус `generated_but_timeout` и сохранять summary в storage, если текст уже получен.

### B1. Поведение при `grpc ResourceExhausted` (message too large)
- Ошибка: `Status { code: ResourceExhausted, message: "grpc: received message larger than max (X vs 4194304)" }`.
- Реакция:
  1) Немедленно классифицировать как `payload_too_large` и **не ретраить** без сокращения payload.
  2) В `tools-gateway` повторить сбор payload с агрессивным shrink:
     - убрать `metadata`,
     - сократить `messages` (уменьшить count),
     - ограничить `content` до `N` символов.
  3) Зафиксировать `payload_bytes_before/after`, `actions` и `summary_range` в статусе.
  4) Если после shrink всё ещё > лимита — вернуть `status=skip` с `reason=payload_too_large`.
- NATS/HTTP статус должен включать `error.code=ResourceExhausted` и `payload_bytes`.

### C. Интеграция Temporal summary → Message.summary (будущая фича)
- Источник summary хранится в `conversation_summaries` в Mongo (tools‑gateway: [`mongo_repository`](../backend/tools-gateway/services/mongo_repository.py:310)).
- Требуемый флоу:
  1) После успешного `ingest_summary_activity`, tools‑gateway вызывает API Node‑сервера (HTTP or NATS) для **записи `Message.summary`** на диапазон сообщений.
  2) Node‑сервер сохраняет summary в `Message.summary` и `summaryTokenCount`.
  3) `BaseClient` начинает использовать `previous_summary` при сборке prompt.
- Guardrails:
  - не превышать лимит payload на обратном канале;
  - идемпотентность по `summary_range` и `summary_level`;
  - повторяемость при сетевых сбоях.

## Протокол интеграции и сквозной трассировки (черновик)
### NATS (default)
- Subject: `summary.result`.
- Payload:
  - `conversation_id`, `user_id`
  - `summary_level`, `summary_text`, `summary_range`
  - `summary_model`, `updated_at`
  - `messages_range`: `{start_message_id, end_message_id, start_index?, end_index?}`
  - `trace_id`, `request_id`

### HTTP fallback
- tools‑gateway → Node:
  - `POST /api/summary/ingest`
  - Payload тот же, что в NATS.

## QA/Критерии
1) При включенном summary — статусные события идут через NATS, HTTP fallback работает.
2) Payload‑guard блокирует слишком большие summary‑задачи и пишет `payload_too_large`.
3) Таймауты SummaryWorkflow/activities не теряют уже сгенерированные summary (статус `generated_but_timeout`).
4) После интеграции summary в `Message.summary` — `BaseClient` пишет `clients.base.previous_summary`.

## Риски
- Лимит gRPC 4MB при больших payload → решается `SUMMARY_TEMPORAL_MAX_PAYLOAD_BYTES` + shrink.
- Дублирование summary (Temporal vs ingest) → нужно разделять контексты и явно помечать типы.

## Ссылки на код
- `tools‑gateway` endpoints: [`app.py`](../backend/tools-gateway/app.py:205)
- Summary dispatch: [`context_manager.py`](../backend/tools-gateway/services/context_manager.py:627)
- Summary store: [`mongo_repository.py`](../backend/tools-gateway/services/mongo_repository.py:310)
- Temporal workflow: [`workflows_summary.py`](../backend/temporal/worker_app/workflows_summary.py:24)
