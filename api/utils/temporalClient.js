'use strict';

const fetch = require('node-fetch');
const config = require('~/server/services/Config/ConfigService');
const { publish } = require('./natsClient');
const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');

const logger = getLogger('utils.temporalClient');

function getQueueConfig() {
  return config.getSection('queues');
}

function isNatsEnabled() {
  return config.get('nats.enabled') === true;
}

function resolveSubject(queueConfig, subjectKey) {
  if (!queueConfig || typeof queueConfig !== 'object') {
    logger.warn(
      'temporalClient.queue_config_missing',
      buildContext({}, { subjectKey }),
    );
    return null;
  }

  const subjects = queueConfig.subjects;
  if (!subjects || typeof subjects !== 'object') {
    logger.warn(
      'temporalClient.subjects_missing',
      buildContext({}, { subjectKey }),
    );
    return null;
  }

  const subject = subjects[subjectKey];
  if (!subject || typeof subject !== 'string') {
    logger.warn('temporalClient.subject_not_found', buildContext({}, { subjectKey }));
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
        'temporalClient.nats_publish_failed',
        buildContext({}, { workflowLabel, err: error }),
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
    'temporalClient.enqueue_graph_start',
    buildContext(payload, {
      conversationId,
      messageId,
      via,
      fallbackUrl: via === 'http-fallback' ? fallbackUrl : undefined,
    }),
  );

  const result = await publishWithFallback('graph', payload, '/temporal/graph/run', 'GraphWorkflow');

  logger.info(
    'temporalClient.enqueue_graph_success',
    buildContext(payload, { conversationId, messageId, via }),
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
