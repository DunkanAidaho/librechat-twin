const {
  logger
} = require('@librechat/data-schemas');

// /opt/open-webui/api/utils/temporalClient.js
const fetch = require('node-fetch');
const { publish } = require('./natsClient');

function isNatsEnabled() {
  return (process.env.NATS_ENABLED || '').toLowerCase() === 'true';
}

async function publishWithFallback(subjectEnvName, payload, fallbackPath, workflowLabel) {
  const subject = process.env[subjectEnvName];
  if (!subject) {
    throw new Error(`Переменная ${subjectEnvName} не задана.`);
  }

  if (isNatsEnabled()) {
    try {
      await publish(subject, payload);
      return { status: 'queued', via: 'nats' };
    } catch (err) {
      console.error(`[JetStream] Ошибка публикации (${workflowLabel}):`, err);
    }
  }

  const url = `${process.env.TOOLS_GATEWAY_URL}${fallbackPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 15_000,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[HTTP fallback] ${workflowLabel} → ${url} вернул ${res.status}: ${text}`);
  }

  return res.json();
}

async function enqueueMemoryTask(payload) {
  return publishWithFallback(
    'NATS_MEMORY_SUBJECT',
    payload,
    '/temporal/memory/run',
    'MemoryWorkflow',
  );
}

async function enqueueGraphTask(payload) {
  const conversationId = payload?.conversation_id ?? 'unknown';
  const messageId = payload?.message_id ?? 'unknown';
  const fallbackPath = '/temporal/graph/run';
  const via = isNatsEnabled() ? 'nats' : 'http-fallback';
  const fallbackUrl = process.env.TOOLS_GATEWAY_URL
    ? `${process.env.TOOLS_GATEWAY_URL}${fallbackPath}`
    : 'unknown';
  const fallbackDetails = via === 'http-fallback' ? `, fallbackUrl=${fallbackUrl}` : '';

  logger.info(
    `[TemporalClient] enqueueGraphTask start (conversation=${conversationId}, message=${messageId}, via=${via}${fallbackDetails})`
  );

  const result = await publishWithFallback(
    'NATS_GRAPH_SUBJECT',
    payload,
    fallbackPath,
    'GraphWorkflow',
  );

  logger.info(
    `[TemporalClient] enqueueGraphTask success (conversation=${conversationId}, message=${messageId}, via=${via}${fallbackDetails})`
  );

  return result;
}

async function enqueueSummaryTask(payload) {
  return publishWithFallback(
    'NATS_SUMMARY_SUBJECT',
    payload,
    '/temporal/summary/run',
    'SummaryWorkflow',
  );
}

module.exports = {
  enqueueMemoryTask,
  enqueueGraphTask,
  enqueueSummaryTask,
};
