'use strict';

const { register, Counter, Gauge } = require('prom-client');

function reuseMetric(name, factory) {
  const existing = register.getSingleMetric(name);
  if (existing) {
    return existing;
  }
  const metric = factory();
  register.registerMetric(metric);
  return metric;
}

const segmentCounter = reuseMetric(
  'rag_tokens_total',
  () =>
    new Counter({
      name: 'rag_tokens_total',
      help: 'Количество токенов по сегментам RAG (system/graph/vector/fallback).',
      labelNames: ['segment', 'endpoint', 'model'],
    }),
);

const cacheCounter = reuseMetric(
  'rag_cache_hits_total',
  () =>
    new Counter({
      name: 'rag_cache_hits_total',
      help: 'Количество обращений к RAG-кэшу по статусам hit/miss.',
      labelNames: ['status'],
    }),
);

const costCounter = reuseMetric(
  'rag_request_cost_total',
  () =>
    new Counter({
      name: 'rag_request_cost_total',
      help: 'Совокупная стоимость запросов (USD).',
      labelNames: ['endpoint', 'model'],
    }),
);

const ragContextGauge = reuseMetric(
  'rag_context_length_chars',
  () =>
    new Gauge({
      name: 'rag_context_length_chars',
      help: 'Длина вставленного контекста RAG в символах.',
      labelNames: ['segment', 'endpoint', 'model'],
    }),
);

const historyPassthroughGauge = reuseMetric(
  'rag_history_passthrough_total',
  () =>
    new Gauge({
      name: 'rag_history_passthrough_total',
      help: 'Количество «тяжёлых» сообщений, пропущенных без shrink.',
      labelNames: ['role', 'reason'],
    }),
);

function observeSegmentTokens({ segment, tokens, endpoint = 'unknown', model = 'unknown' }) {
  if (!segment || tokens == null) {
    return;
  }
  segmentCounter.labels(segment, endpoint, model).inc(tokens);
}

function observeCache(status) {
  if (!status || typeof status !== 'string') {
    return;
  }
  cacheCounter.labels(status).inc(1);
}

function observeCost({ endpoint = 'unknown', model = 'unknown' }, cost = 0) {
  if (cost == null) {
    return;
  }
  costCounter.labels(endpoint, model).inc(cost);
}

function setContextLength({ segment, length, endpoint = 'unknown', model = 'unknown' }) {
  if (!segment || length == null) {
    return;
  }
  ragContextGauge.labels(segment, endpoint, model).set(length);
}

function observeHistoryPassthrough({ role = 'unknown', reason = 'unspecified' } = {}) {
  historyPassthroughGauge.labels(role, reason).inc(1);
}

module.exports = {
  register,
  segmentCounter,
  cacheCounter,
  costCounter,
  ragContextGauge,
  historyPassthroughGauge,
  observeSegmentTokens,
  observeCache,
  observeCost,
  setContextLength,
  observeHistoryPassthrough,
};
