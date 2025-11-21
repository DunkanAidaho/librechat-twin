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

let temporalClient = null;
let temporalEnabled = Boolean(config.get('memory.temporalEnabled', false));

setTemporalStatus(TEMPORAL_STATUS_REASON, temporalEnabled);

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

  try {
    let enqueued = 0;
    for (const task of tasks) {
      const payload = task?.payload || task;
      if (!payload || !payload.conversation_id || !payload.message_id) {
        throw new Error('Invalid task payload: missing conversation_id/message_id');
      }

      const missing = [...REQUIRED_FIELDS].filter((key) => !(key in payload));
      if (missing.length) {
        incMemoryQueueSkipped('missing_fields');
        logger.warn(
          '[memoryQueue] Пропуск задачи для Temporal (conversation=%s, message=%s) — отсутствуют поля: %s',
          payload.conversation_id,
          payload.message_id,
          missing.join(', '),
          payload,
        );

        await callToolsGatewayDelete(payload.conversation_id, payload.user_id || meta.userId);
        continue;
      }

      const context = {
        ...payload,
        _metadata: {
          reason: meta.reason,
          conversationId: meta.conversationId,
          userId: meta.userId,
        },
      };

      await client.enqueueMemoryTask(context);
      enqueued += 1;
    }

    if (enqueued === 0) {
      incMemoryQueueSkipped('no_valid_payloads');
      return { status: 'skipped', reason: 'no_valid_payloads', count: 0 };
    }

    logger.info(
      `[memoryQueue] Поставлено ${enqueued} задач через Temporal (reason=${meta.reason}, conversation=${meta.conversationId || 'n/a'})`
    );

    return { status: 'queued', via: 'temporal', count: enqueued };
  } catch (error) {
    logger.error('[memoryQueue] Ошибка отправки задач в Temporal', error);
    disableTemporal(error?.message || 'temporal_enqueue_failed');
    return { status: 'failed', reason: error?.message || 'temporal_enqueue_failed', count: 0 };
  }
}

module.exports = {
  enqueueMemoryTasks,
  disableTemporal,
};
