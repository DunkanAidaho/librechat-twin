'use strict';

const client = require('prom-client');
const { logger } = require('@librechat/data-schemas');

const register = client.register;

if (!register.getSingleMetric('process_resident_memory_bytes')) {
  client.collectDefaultMetrics({ register });
}

const ingestDedupeHits = new client.Counter({
  name: 'ingest_dedupe_hits_total',
  help: 'Количество попаданий дедупликации инжеста по режимам',
  labelNames: ['mode'],
  registers: [register],
});

const ingestDedupeMisses = new client.Counter({
  name: 'ingest_dedupe_misses_total',
  help: 'Количество промахов дедупликации инжеста по режимам',
  labelNames: ['mode'],
  registers: [register],
});

const sendMessageDuration = new client.Histogram({
  name: 'sendMessage_duration_ms',
  help: 'Длительность вызова client.sendMessage в миллисекундах',
  labelNames: ['endpoint', 'model'],
  buckets: [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 40000],
  registers: [register],
});

const sendMessageFailures = new client.Counter({
  name: 'sendMessage_failures_total',
  help: 'Число неудачных вызовов client.sendMessage',
  labelNames: ['endpoint', 'model', 'reason'],
  registers: [register],
});

const memoryQueueLatency = new client.Histogram({
  name: 'memoryQueue_latency_ms',
  help: 'Задержка постановки задач в очередь памяти',
  labelNames: ['reason', 'status'],
  buckets: [20, 50, 100, 250, 500, 1000, 2000, 5000, 10000],
  registers: [register],
});

const memoryQueueFailures = new client.Counter({
  name: 'memoryQueue_failures_total',
  help: 'Число ошибок постановки задач в память',
  labelNames: ['reason'],
  registers: [register],
});

const memoryQueueSkipped = new client.Counter({
  name: 'memoryQueue_skipped_total',
  help: 'Количество пропущенных задач памяти',
  labelNames: ['reason'],
  registers: [register],
});

const memoryQueueToolsGatewayFailures = new client.Counter({
  name: 'memoryQueue_tools_gateway_failures_total',
  help: 'Ошибки обращения к tools-gateway при очистке',
  labelNames: ['reason'],
  registers: [register],
});

const summaryEnqueueTotal = new client.Counter({
  name: 'summary_enqueue_total',
  help: 'Количество попыток постановки задач суммаризации',
  labelNames: ['status'],
  registers: [register],
});

const graphEnqueueTotal = new client.Counter({
  name: 'graph_enqueue_total',
  help: 'Количество попыток постановки задач графового анализа',
  labelNames: ['status'],
  registers: [register],
});

const summaryEnqueue = new client.Histogram({
  name: 'summary_enqueue_ms',
  help: 'Задержка постановки задач суммаризации',
  labelNames: ['status'],
  buckets: [20, 50, 100, 250, 500, 1000, 2000, 5000],
  registers: [register],
});

const summaryEnqueueFailures = new client.Counter({
  name: 'summary_enqueue_failures_total',
  help: 'Ошибки постановки задач суммаризации',
  labelNames: ['reason'],
  registers: [register],
});

const graphEnqueue = new client.Histogram({
  name: 'graph_enqueue_ms',
  help: 'Задержка постановки задач графа',
  labelNames: ['status'],
  buckets: [20, 50, 100, 250, 500, 1000, 2000, 5000],
  registers: [register],
});

const graphEnqueueFailures = new client.Counter({
  name: 'graph_enqueue_failures_total',
  help: 'Ошибки постановки задач графа',
  labelNames: ['reason'],
  registers: [register],
});

const temporalStatus = new client.Gauge({
  name: 'temporal_status',
  help: 'Доступность компонентов Temporal (1 — OK, 0 — отключено)',
  labelNames: ['reason'],
  registers: [register],
});

const longTextTasks = new client.Counter({
  name: 'long_text_tasks_total',
  help: 'Состояния обработки больших текстов',
  labelNames: ['status'],
  registers: [register],
});

const longTextGraphChunks = new client.Counter({
  name: 'long_text_graph_chunks_total',
  help: 'Статусы обработки chunkов длинных текстов (vector/graph)',
  labelNames: ['status'],
  registers: [register],
});

function safeLabels(labels = {}) {
  return Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [
      key,
      typeof value === 'string' && value.length ? value : 'unknown',
    ]),
  );
}

function observeMs(histogram, labels = {}) {
  return (durationMs) => {
    if (typeof durationMs !== 'number' || Number.isNaN(durationMs)) {
      return;
    }
    histogram.observe(safeLabels(labels), durationMs);
  };
}

async function renderMetrics() {
  return register.metrics();
}

function recordIngestDedupeHit(mode) {
  ingestDedupeHits.inc(safeLabels({ mode }));
}

function recordIngestDedupeMiss(mode) {
  ingestDedupeMisses.inc(safeLabels({ mode }));
}

function observeSendMessage(labels, durationMs) {
  observeMs(sendMessageDuration, labels)(durationMs);
}

function incSendMessageFailure(labels) {
  sendMessageFailures.inc(safeLabels(labels));
}

function observeMemoryQueueLatency(labels, durationMs) {
  observeMs(memoryQueueLatency, labels)(durationMs);
}

function incMemoryQueueFailure(reason) {
  memoryQueueFailures.inc(safeLabels({ reason }));
}

function incMemoryQueueSkipped(reason) {
  memoryQueueSkipped.inc(safeLabels({ reason }));
}

function incMemoryQueueToolsGatewayFailure(reason) {
  memoryQueueToolsGatewayFailures.inc(safeLabels({ reason }));
}

function observeSummaryEnqueue(labels, durationMs) {
  observeMs(summaryEnqueue, labels)(durationMs);
}

function incSummaryEnqueueFailure(reason) {
  summaryEnqueueFailures.inc(safeLabels({ reason }));
}

function incSummaryEnqueueTotal(status) {
  summaryEnqueueTotal.inc(safeLabels({ status }));
}

function incGraphEnqueueTotal(status) {
  graphEnqueueTotal.inc(safeLabels({ status }));
}

function observeGraphEnqueue(labels, durationMs) {
  observeMs(graphEnqueue, labels)(durationMs);
}

function incGraphEnqueueFailure(reason) {
  graphEnqueueFailures.inc(safeLabels({ reason }));
}

function setTemporalStatus(reason, isAvailable) {
  const labels = safeLabels({ reason });
  temporalStatus.set(labels, isAvailable ? 1 : 0);
  if (!isAvailable) {
    logger.warn(`[metrics] Temporal компонент ${labels.reason} недоступен`);
  }
}

function incLongTextTask(status) {
  longTextTasks.inc(safeLabels({ status }));
}

function incLongTextGraphChunk(status) {
  longTextGraphChunks.inc(safeLabels({ status }));
}

module.exports = {
  register,
  renderMetrics,
  recordIngestDedupeHit,
  recordIngestDedupeMiss,
  observeSendMessage,
  incSendMessageFailure,
  observeMemoryQueueLatency,
  incMemoryQueueFailure,
  incMemoryQueueSkipped,
  incMemoryQueueToolsGatewayFailure,
  observeSummaryEnqueue,
  incSummaryEnqueueFailure,
  incSummaryEnqueueTotal,
  observeGraphEnqueue,
  incGraphEnqueueFailure,
  incGraphEnqueueTotal,
  setTemporalStatus,
  incLongTextTask,
  incLongTextGraphChunk,
};
