from __future__ import annotations
from prometheus_client import Counter, Gauge, Histogram, generate_latest
from typing import Any, Dict, Optional
graph_enqueue_total = Counter('graph_workflow_enqueue_total',
    'Total number of Graph Workflow enqueue attempts.', ['status'])
graph_enqueue_duration_seconds = Histogram(
    'graph_workflow_enqueue_duration_seconds',
    'Duration of Graph Workflow enqueue operations in seconds.')
summary_enqueue_total = Counter('summary_workflow_enqueue_total',
    'Total number of Summary Workflow enqueue attempts.', ['status'])
summary_enqueue_duration_seconds = Histogram(
    'summary_workflow_enqueue_duration_seconds',
    'Duration of Summary Workflow enqueue operations in seconds.')
memory_enqueue_total = Counter('memory_workflow_enqueue_total',
    'Total number of Memory Workflow enqueue attempts.', ['status'])
memory_enqueue_duration_seconds = Histogram(
    'memory_workflow_enqueue_duration_seconds',
    'Duration of Memory Workflow enqueue operations in seconds.')
context_total_gauge = Gauge('conversation_context_total',
    'Total number of conversation contexts held in memory.')
context_overflow_gauge = Gauge('conversation_context_overflow_total',
    'Number of conversation contexts above STATS_CONTEXT_CUTOFF.')
graph_enqueue_failure_total = Counter('graph_workflow_enqueue_failure_total',
    'Total number of failed Graph Workflow enqueue attempts.')
summary_enqueue_failure_total = Counter(
    'summary_workflow_enqueue_failure_total',
    'Total number of failed Summary Workflow enqueue attempts.')
memory_enqueue_failure_total = Counter(
    'memory_workflow_enqueue_failure_total',
    'Total number of failed Memory Workflow enqueue attempts.')
_TEMPORAL_STATUS_LABELS = ('idle', 'started', 'already_running',
    'temporal_error', 'transport_error', 'failure')
temporal_status_gauge = Gauge('temporal_dispatcher_status',
    'Current Temporal workflow dispatcher status.', ['status'])
tool_search_context_requests_total = Counter(
    'tool_search_context_requests_total',
    'Total number of /tool/search_context requests.')
tool_search_context_failures_total = Counter(
    'tool_search_context_failures_total',
    'Total number of failed /tool/search_context requests.')
tool_submit_ingest_requests_total = Counter(
    'tool_submit_ingest_requests_total',
    'Total number of /tool/submit_ingest requests.')
tool_submit_ingest_failures_total = Counter(
    'tool_submit_ingest_failures_total',
    'Total number of failed /tool/submit_ingest requests.')
tool_ingest_status_requests_total = Counter(
    'tool_ingest_status_requests_total',
    'Total number of /tool/ingest_status requests.')
tool_ingest_status_not_found_total = Counter(
    'tool_ingest_status_not_found_total',
    'Total number of /tool/ingest_status not_found responses.')
tool_submit_ingest_profile_total = Counter(
    'tool_submit_ingest_profile_total',
    'Total number of /tool/submit_ingest by profile.', ['profile'])
tool_submit_ingest_status_total = Counter(
    'tool_submit_ingest_status_total',
    'Total number of /tool/submit_ingest by status.', ['status'])


def inc_graph_enqueue_total(status: str='success'):
    graph_enqueue_total.labels(status=status).inc()


def observe_graph_enqueue(duration: float):
    graph_enqueue_duration_seconds.observe(duration)


def inc_summary_enqueue_total(status: str='success'):
    summary_enqueue_total.labels(status=status).inc()


def observe_summary_enqueue(duration: float):
    summary_enqueue_duration_seconds.observe(duration)


def inc_memory_enqueue_total(status: str='success'):
    memory_enqueue_total.labels(status=status).inc()


def observe_memory_enqueue(duration: float):
    memory_enqueue_duration_seconds.observe(duration)


def render_prometheus_metrics(context_stats: Optional[Dict[str, Any]]=None
    ) ->str:
    """
    Готовит текст в формате Prometheus.
    Обновляет метрики ContextManager на основе переданной статистики.
    """
    if context_stats:
        context_total_gauge.set(context_stats.get('total', 0))
        context_overflow_gauge.set(context_stats.get('with_overflow', 0))
    return generate_latest().decode('utf-8')


def inc_graph_enqueue_failure():
    graph_enqueue_failure_total.inc()


def inc_summary_enqueue_failure():
    summary_enqueue_failure_total.inc()


def inc_memory_enqueue_failure():
    memory_enqueue_failure_total.inc()


def set_temporal_status(status: str) ->None:
    observed = False
    for label in _TEMPORAL_STATUS_LABELS:
        value = 1.0 if label == status else 0.0
        temporal_status_gauge.labels(status=label).set(value)
        if label == status:
            observed = True
    if not observed:
        temporal_status_gauge.labels(status=status).set(1.0)


def inc_tool_search_context_requests() -> None:
    tool_search_context_requests_total.inc()


def inc_tool_search_context_failures() -> None:
    tool_search_context_failures_total.inc()


def inc_tool_submit_ingest_requests() -> None:
    tool_submit_ingest_requests_total.inc()


def inc_tool_submit_ingest_failures() -> None:
    tool_submit_ingest_failures_total.inc()


def inc_tool_ingest_status_requests() -> None:
    tool_ingest_status_requests_total.inc()


def inc_tool_ingest_status_not_found() -> None:
    tool_ingest_status_not_found_total.inc()


def inc_tool_submit_ingest_profile(profile: str) -> None:
    tool_submit_ingest_profile_total.labels(profile=profile).inc()


def inc_tool_submit_ingest_status(status: str) -> None:
    tool_submit_ingest_status_total.labels(status=status).inc()
