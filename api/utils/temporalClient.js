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

function resolveSubject(queueConfig, subjectKey) {
  if (!queueConfig || typeof queueConfig !== 'object') {
    logger.warn('[TemporalClient] queueConfig отсутствует, пропускаем публикацию в NATS', {
      subjectKey,
    });
    return null;
  }

  const subjects = queueConfig.subjects;
  if (!subjects || typeof subjects !== 'object') {
    logger.warn('[TemporalClient] queueConfig.subjects отсутствует, пропускаем NATS', {
      subjectKey,
    });
    return null;
  }

  const subject = subjects[subjectKey];
  if (!subject || typeof subject !== 'string') {
    logger.warn('[TemporalClient] subject не найден', { subjectKey });
    return null;
  }

  return subject;
}

async function publishWithFallback(subjectKey, payload, fallbackPath, workflowLabel) {
  const queueConfig = getQueueConfig();
  const subject = resolveSubject(queueConfig, subjectKey);

  if (isNatsEnabled() && subject) {
    try {
      await publish(subject, payload);
      return { status: 'queued', via: 'nats' };
    } catch (error) {
      logger.error(
        `[TemporalClient] Ошибка публикации в NATS (${workflowLabel}): ${error?.message || error}`,
      );
    }
  }

  const baseUrl = queueConfig?.toolsGatewayUrl;
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
  const natsActive = isNatsEnabled();
  const queueConfig = getQueueConfig();
  const fallbackUrl = queueConfig?.toolsGatewayUrl
    ? `${queueConfig.toolsGatewayUrl}/temporal/graph/run`
    : 'unknown';
  const via = natsActive ? 'nats' : 'http-fallback';

  logger.info(
    '[TemporalClient] enqueueGraphTask start',
    {
      conversationId,
      messageId,
      via,
      fallbackUrl: via === 'http-fallback' ? fallbackUrl : undefined,
    },
  );

  const result = await publishWithFallback('graph', payload, '/temporal/graph/run', 'GraphWorkflow');

  logger.info('[TemporalClient] enqueueGraphTask success', { conversationId, messageId, via });

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
