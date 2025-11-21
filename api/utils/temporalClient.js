'use strict';

const fetch = require('node-fetch');
const { logger } = require('@librechat/data-schemas');
const config = require('~/server/services/Config/ConfigService');
const { publish } = require('./natsClient');

function getQueueConfig() {
  return config.getSection('queues');
}

function isNatsEnabled() {
  return config.get('nats.enabled') === true;
}

async function publishWithFallback(subjectKey, payload, fallbackPath, workflowLabel) {
  const queueConfig = getQueueConfig();
  const subject = queueConfig.subjects[subjectKey];

  if (isNatsEnabled() && subject) {
    try {
      await publish(subject, payload);
      return { status: 'queued', via: 'nats' };
    } catch (err) {
      logger.error(
        '[TemporalClient] Ошибка публикации в NATS (%s): %s',
        workflowLabel,
        err?.message || err,
      );
    }
  }

  const baseUrl = queueConfig.toolsGatewayUrl;
  if (!baseUrl) {
    throw new Error('TOOLS_GATEWAY_URL не настроен, HTTP fallback невозможен.');
  }

  const url = `${baseUrl}${fallbackPath}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: queueConfig.httpTimeoutMs,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`[HTTP fallback] ${workflowLabel} → ${url} вернул ${response.status}: ${text}`);
  }

  return response.json();
}

async function enqueueMemoryTask(payload) {
  return publishWithFallback('memory', payload, '/temporal/memory/run', 'MemoryWorkflow');
}

async function enqueueGraphTask(payload) {
  const conversationId = payload?.conversation_id ?? 'unknown';
  const messageId = payload?.message_id ?? 'unknown';
  const via = isNatsEnabled() ? 'nats' : 'http-fallback';
  const queueConfig = getQueueConfig();
  const fallbackUrl = queueConfig.toolsGatewayUrl
    ? `${queueConfig.toolsGatewayUrl}/temporal/graph/run`
    : 'unknown';

  logger.info(
    `[TemporalClient] enqueueGraphTask start (conversation=${conversationId}, message=${messageId}, via=${via}${via === 'http-fallback' ? `, fallbackUrl=${fallbackUrl}` : ''})`
  );

  const result = await publishWithFallback('graph', payload, '/temporal/graph/run', 'GraphWorkflow');

  logger.info(
    `[TemporalClient] enqueueGraphTask success (conversation=${conversationId}, message=${messageId}, via=${via})`
  );

  return result;
}

async function enqueueSummaryTask(payload) {
  return publishWithFallback('summary', payload, '/temporal/summary/run', 'SummaryWorkflow');
}

module.exports = {
  enqueueMemoryTask,
  enqueueGraphTask,
  enqueueSummaryTask,
};
