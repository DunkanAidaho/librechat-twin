'use strict';

const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const {
  setTemporalStatus,
  incMemoryQueueSkipped,
  incMemoryQueueToolsGatewayFailure,
} = require('~/utils/metrics');
const config = require('~/server/services/Config/ConfigService');

const REQUIRED_FIELDS = new Set([
  'conversation_id',
  'message_id',
  'user_id',
  'role',
  'content',
]);

const TEMPORAL_STATUS_REASON = 'memory_queue';

// Transient error patterns that should not disable Temporal globally
const TRANSIENT_ERROR_PATTERNS = [
  /timeout/i,
  /ResourceExhausted/i,
  /503/,
  /502/,
  /429/,
  /connection reset/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /Service Unavailable/i,
];

let temporalClient = null;
let temporalEnabled = Boolean(config.get('memory.temporalEnabled', false));

setTemporalStatus(TEMPORAL_STATUS_REASON, temporalEnabled);

/**
 * Splits array into chunks of specified size
 */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Classifies error as transient (retryable) or permanent
 */
function isTransientError(error) {
  const message = String(error?.message || error || '');
  return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

function getToolsGatewayConfig() {
  const url = config.get('queues.toolsGatewayUrl', null);
  const timeoutMs = config.getNumber('queues.httpTimeoutMs', 15000);
  return { url, timeoutMs };
}

function initTemporalClient() {
  if (!temporalEnabled) {
    return null;
  }

  if (temporalClient) {
    return temporalClient;
  }

  try {
    temporalClient = require('~/utils/temporalClient');
    setTemporalStatus(TEMPORAL_STATUS_REASON, true);
  } catch (error) {
    temporalClient = null;
    temporalEnabled = false;
    logger.error('[memoryQueue] Не удалось загрузить temporalClient, Temporal отключён.', error);
    setTemporalStatus(TEMPORAL_STATUS_REASON, false);
  }

  return temporalClient;
}

function disableTemporal(reason) {
  if (temporalEnabled) {
    temporalEnabled = false;
    logger.error('[memoryQueue] Temporal отключён из-за ошибки: %s', reason);
    setTemporalStatus(TEMPORAL_STATUS_REASON, false);
  }
}

async function callToolsGatewayDelete(conversationId, userId) {
  const { url, timeoutMs } = getToolsGatewayConfig();
  if (!url) {
    logger.warn(
      '[memoryQueue] Пропуск очистки через tools-gateway: toolsGatewayUrl не настроен (conversation=%s)',
      conversationId,
    );
    incMemoryQueueSkipped('tools_gateway_missing');
    return;
  }

  try {
    await axios.post(
      `${url}/neo4j/delete_conversation`,
      {
        conversation_id: conversationId,
        user_id: userId ?? null,
      },
      { timeout: timeoutMs },
    );
    logger.info(
      '[memoryQueue] Вызвана очистка через tools-gateway (/neo4j/delete_conversation, conversation=%s).',
      conversationId,
    );
  } catch (error) {
    incMemoryQueueToolsGatewayFailure();
    logger.error(
      '[memoryQueue] Ошибка вызова очистки tools-gateway:',
      error?.response?.data || error?.message || error,
    );
  }
}

/**
 * Enqueues a single batch of memory tasks
 */
async function enqueueBatch(client, batch, meta) {
  let enqueued = 0;
  const errors = [];

  for (const task of batch) {
    const payload = task?.payload || task;
    if (!payload || !payload.conversation_id || !payload.message_id) {
      errors.push(new Error('Invalid task payload: missing conversation_id/message_id'));
      continue;
    }

    const missing = [...REQUIRED_FIELDS].filter((key) => !(key in payload));
    if (missing.length) {
      incMemoryQueueSkipped('missing_fields');
      logger.warn(
        '[memoryQueue] Пропуск задачи для Temporal (conversation=%s, message=%s) — отсутствуют поля: %s',
        payload.conversation_id,
        payload.message_id,
        missing.join(', '),
      );
      // REMOVED: automatic delete call - this was dangerous
      continue;
    }

    try {
      const context = {
        ...payload,
        _metadata: {
          reason: meta.reason,
          conversationId: meta.conversationId,
          userId: meta.userId,
        },
      };

      await client.enqueueMemoryTask(context);
      enqueued++;
    } catch (error) {
      errors.push(error);
      logger.warn(
        '[memoryQueue] Ошибка enqueue отдельной задачи (conversation=%s, message=%s): %s',
        payload.conversation_id,
        payload.message_id,
        error?.message,
      );
    }
  }

  return { enqueued, errors };
}

async function enqueueMemoryTasks(tasks = [], meta = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    incMemoryQueueSkipped('empty_tasks');
    return { status: 'skipped', reason: 'empty_tasks' };
  }

  if (!temporalEnabled) {
    incMemoryQueueSkipped('temporal_disabled');
    logger.warn('[memoryQueue] Temporal выключен, задачи пропущены', meta);
    return { status: 'skipped', reason: 'temporal_disabled', count: tasks.length };
  }

  const client = initTemporalClient();
  if (!client) {
    logger.error('[memoryQueue] temporalClient не инициализирован, не удалось поставить задачи.');
    disableTemporal('temporal_client_init_failed');
    return { status: 'failed', reason: 'temporal_client_init_failed', count: 0 };
  }

  // Get batching configuration
  const memoryConfig = config.getSection('memory');
  const batchSize = Math.max(1, memoryConfig.queue?.enqueueBatchSize ?? 25);
  const maxTotalMs = memoryConfig.queue?.enqueueMaxTotalMs ?? 60000;
  const failOpen = memoryConfig.queue?.failOpen ?? true;
  const isDropped = meta.reason === 'history_window_drop';

  // Handle fire-and-forget for dropped history
  if (isDropped && meta.fireAndForget) {
    // Start async processing without waiting
    setImmediate(async () => {
      try {
        await enqueueMemoryTasksSync(client, tasks, meta, batchSize);
      } catch (error) {
        logger.error('[memoryQueue] Fire-and-forget enqueue failed', {
          reason: meta.reason,
          conversationId: meta.conversationId,
          taskCount: tasks.length,
          error: error?.message,
        });
      }
    });
    
    logger.info(
      `[memoryQueue] Started fire-and-forget enqueue (reason=${meta.reason}, tasks=${tasks.length}, conversation=${meta.conversationId || 'n/a'})`
    );
    return { status: 'queued_async', via: 'temporal', count: tasks.length };
  }

  // Synchronous processing with timeout
  try {
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Enqueue timed out after ${maxTotalMs}ms`)), maxTotalMs)
    );

    const enqueuePromise = enqueueMemoryTasksSync(client, tasks, meta, batchSize);
    const result = await Promise.race([enqueuePromise, timeoutPromise]);
    
    return result;
  } catch (error) {
    const isTransient = isTransientError(error);
    
    logger.error('[memoryQueue] Ошибка отправки задач в Temporal', {
      error: error?.message,
      isTransient,
      reason: meta.reason,
      conversationId: meta.conversationId,
      taskCount: tasks.length,
    });

    // Only disable Temporal for permanent errors
    if (!isTransient || !failOpen) {
      disableTemporal(error?.message || 'temporal_enqueue_failed');
      return { status: 'failed', reason: error?.message || 'temporal_enqueue_failed', count: 0 };
    }

    // For transient errors with failOpen, return retryable failure
    return { 
      status: 'failed', 
      reason: error?.message || 'temporal_enqueue_failed', 
      retryable: true,
      count: 0 
    };
  }
}

/**
 * Synchronous enqueue processing with batching
 */
async function enqueueMemoryTasksSync(client, tasks, meta, batchSize) {
  const batches = chunk(tasks, batchSize);
  let enqueuedTotal = 0;
  const allErrors = [];

  logger.info(
    `[memoryQueue] Processing ${tasks.length} tasks in ${batches.length} batches (batchSize=${batchSize}, reason=${meta.reason})`
  );

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    
    try {
      const { enqueued, errors } = await enqueueBatch(client, batch, meta);
      enqueuedTotal += enqueued;
      allErrors.push(...errors);

      logger.info(
        `[memoryQueue] Batch ${bi + 1}/${batches.length} enqueued=${enqueued}/${batch.length} total=${enqueuedTotal} reason=${meta.reason}`
      );
    } catch (batchError) {
      logger.error(
        `[memoryQueue] Batch ${bi + 1}/${batches.length} failed completely: ${batchError?.message}`,
        { reason: meta.reason, conversationId: meta.conversationId }
      );
      allErrors.push(batchError);
    }
  }

  if (enqueuedTotal === 0) {
    incMemoryQueueSkipped('no_valid_payloads');
    return { status: 'skipped', reason: 'no_valid_payloads', count: 0 };
  }

  if (allErrors.length > 0) {
    logger.warn(
      `[memoryQueue] Completed with ${allErrors.length} errors, ${enqueuedTotal} successful enqueues`
    );
  }

  logger.info(
    `[memoryQueue] Поставлено ${enqueuedTotal} задач через Temporal (reason=${meta.reason}, conversation=${meta.conversationId || 'n/a'})`
  );

  return { status: 'queued', via: 'temporal', count: enqueuedTotal };
}

module.exports = {
  enqueueMemoryTasks,
  disableTemporal,
};
