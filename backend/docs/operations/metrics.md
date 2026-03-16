# Метрики

Prometheus метрики и их источники:

- `graph_workflow_enqueue_total`, `graph_workflow_enqueue_failure_total`
  - [`backend/tools-gateway/services/metrics.py`](backend/tools-gateway/services/metrics.py:4)
- `summary_workflow_enqueue_total`, `summary_workflow_enqueue_failure_total`
  - [`backend/tools-gateway/services/metrics.py`](backend/tools-gateway/services/metrics.py:9)
- `memory_workflow_enqueue_total`
  - [`backend/tools-gateway/services/metrics.py`](backend/tools-gateway/services/metrics.py:14)
- `conversation_context_total`, `conversation_context_overflow_total`
  - [`backend/tools-gateway/services/metrics.py`](backend/tools-gateway/services/metrics.py:19)
- `temporal_dispatcher_status`
  - [`backend/tools-gateway/services/metrics.py`](backend/tools-gateway/services/metrics.py:30)

## Tool facade metrics

- `tool_search_context_requests_total`
- `tool_search_context_failures_total`
- `tool_submit_ingest_requests_total`
- `tool_submit_ingest_failures_total`
- `tool_submit_ingest_profile_total{profile=...}`
- `tool_submit_ingest_status_total{status=...}`
- `tool_ingest_status_requests_total`
- `tool_ingest_status_not_found_total`

Источник: [`backend/tools-gateway/services/metrics.py`](backend/tools-gateway/services/metrics.py:34)
