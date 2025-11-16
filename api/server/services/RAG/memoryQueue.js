// /opt/open-webui/api/server/services/RAG/memoryQueue.js
const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { setTemporalStatus, incMemoryQueueSkipped, incMemoryQueueToolsGatewayFailure } = require('~/utils/metrics');

const REQUIRED_FIELDS = new Set([
  'conversation_id',
  'message_id',
  'user_id',
  'role',
  'content',
]);

let temporalEnabled = (process.env.TEMPORAL_MEMORY_ENABLED || '').toLowerCase() === 'true';
let temporalClient = null;

const TOOLS_GATEWAY_URL = process.env.TOOLS_GATEWAY_URL || 'http://10.10.23.1:8000';
const TEMPORAL_STATUS_REASON = 'memory_queue';
setTemporalStatus(TEMPORAL_STATUS_REASON, temporalEnabled);

function initTemporalClient() {
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

async function enqueueMemoryTasks(tasks = [], meta = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { status: 'skipped', reason: 'empty_tasks' };
  }

  if (!temporalEnabled) {
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
      const payload = task.payload || task;
      if (!payload || !payload.conversation_id || !payload.message_id) {
        throw new Error('Invalid task payload: missing conversation_id/message_id');
      }

      const missing = [...REQUIRED_FIELDS].filter((key) => !(key in payload));
      if (missing.length) {
        logger.warn(
          `[memoryQueue] Пропуск задачи для Temporal (conversation=${payload.conversation_id}, message=${payload.message_id}) — отсутствуют поля: ${missing.join(', ')}`,
          payload,
        );

        try {
          const body = {
            conversation_id: payload.conversation_id,
            user_id: payload.user_id || meta.userId || null,
          };
          await axios.post(`${TOOLS_GATEWAY_URL}/neo4j/delete_conversation`, body, {
            timeout: 15000,
          });
          logger.info(
            `[memoryQueue] Вызвана очистка через tools-gateway (/neo4j/delete_conversation, conversation=${payload.conversation_id}).`,
          );
        } catch (error) {
          logger.error(
            '[memoryQueue] Ошибка вызова очистки tools-gateway:',
            error?.response?.data || error?.message || error,
          );
        }

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
