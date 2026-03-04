'use strict';

const fetch = require('node-fetch');
const configService = require('../server/services/Config/ConfigService');
const { publish } = require('./natsClient');
const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');

const logger = getLogger('utils.temporalClient');

function getQueueConfig() {
  return configService.getSection('queues');
}

function getNatsMaxPayloadBytes(queueConfig) {
  const fallbackBytes = 900_000;
  if (!queueConfig || typeof queueConfig !== 'object') {
    return fallbackBytes;
  }

  const maxBytes = queueConfig.natsMaxPayloadBytes;
  if (typeof maxBytes !== 'number' || Number.isNaN(maxBytes) || maxBytes <= 0) {
    return fallbackBytes;
  }

  return maxBytes;
}

function isNatsEnabled() {
  return configService.get('nats.enabled') === true;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeRetryDelay(attempt, baseMs = 500, maxMs = 5000) {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  const jitter = Math.floor(Math.random() * Math.floor(baseMs));
  return exp + jitter;
}

async function publishWithFallback(subjectKey, payload, fallbackPath, workflowLabel) {
  const queueConfig = getQueueConfig();
  const subject = resolveSubject(queueConfig, subjectKey);
  const maxPayloadBytes = getNatsMaxPayloadBytes(queueConfig);
  const payloadSize = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  const payloadTooLarge = payloadSize > maxPayloadBytes;
  const startAt = Date.now();

  if (payloadTooLarge) {
    logger.warn(
      'temporalClient.nats_payload_oversize',
      buildContext({}, {
        workflowLabel,
        subject,
        payloadSize,
        maxPayloadBytes,
      }),
    );
  }

  if (isNatsEnabled() && subject && !payloadTooLarge) {
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
  logger.info(
    'temporalClient.http_fallback_start',
    buildContext({}, {
      workflowLabel,
      subject,
      url,
      payloadSize,
      payloadTooLarge,
    }),
  );
  const maxAttempts = Math.max(Number(queueConfig.httpRetryMaxAttempts ?? 3), 1);
  const retryBaseMs = Math.max(Number(queueConfig.httpRetryBaseMs ?? 500), 100);
  const retryMaxMs = Math.max(Number(queueConfig.httpRetryMaxMs ?? 5000), retryBaseMs);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: queueConfig.httpTimeoutMs,
    }).catch((error) => ({ error }));

    if (response?.error) {
      const delayMs = computeRetryDelay(attempt, retryBaseMs, retryMaxMs);
      logger.warn(
        'temporalClient.http_fallback_retry',
        buildContext({}, {
          workflowLabel,
          subject,
          url,
          attempt: attempt + 1,
          maxAttempts,
          delayMs,
          err: response.error,
        }),
      );
      if (attempt < maxAttempts - 1) {
        await sleep(delayMs);
        continue;
      }
      throw response.error;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const delayMs = computeRetryDelay(attempt, retryBaseMs, retryMaxMs);
      logger.warn(
        'temporalClient.http_fallback_retry',
        buildContext({}, {
          workflowLabel,
          subject,
          url,
          attempt: attempt + 1,
          maxAttempts,
          delayMs,
          status: response.status,
          body: text?.slice(0, 1000),
        }),
      );
      if (attempt < maxAttempts - 1) {
        await sleep(delayMs);
        continue;
      }
      throw new Error(`[HTTP fallback] ${workflowLabel} → ${url} вернул ${response.status}: ${text}`);
    }

    const result = await response.json();
    logger.info(
      'temporalClient.http_fallback_done',
      buildContext({}, {
        workflowLabel,
        subject,
        url,
        status: response.status,
        durationMs: Date.now() - startAt,
      }),
    );
    return result;
  }

  throw new Error('HTTP fallback attempts exhausted');
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
