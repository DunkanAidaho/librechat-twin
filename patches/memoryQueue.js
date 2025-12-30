'use strict';

const { logger } = require('@librechat/data-schemas');
const { setTimeout: sleep } = require('node:timers/promises');
const { getRedisClient, publishToRedis } = require('../../../utils/rag_redis');
const MemoryBacklog = require('../../../models/MemoryBacklog');

const MEMORY_REDIS_RETRIES = parseInt(process.env.MEMORY_REDIS_RETRIES || '3', 10);
const MEMORY_REDIS_BACKOFF_MS = parseInt(process.env.MEMORY_REDIS_BACKOFF_MS || '200', 10);

async function enqueueMemoryTasks(tasks, { conversationId, userId, fileId, textLength, reason }) {
  const queueName = process.env.REDIS_MEMORY_QUEUE_NAME;
  if (!queueName) {
    logger.error('[MemoryQueue] REDIS_MEMORY_QUEUE_NAME не задан. reason=%s conv=%s', reason, conversationId);
    return saveMemoryBacklog(tasks, { conversationId, userId, fileId, textLength, reason, note: 'no_queue' });
  }

  const redis = getRedisClient();
  if (!redis) {
    logger.error('[MemoryQueue] Redis клиент недоступен. reason=%s conv=%s', reason, conversationId);
    return saveMemoryBacklog(tasks, { conversationId, userId, fileId, textLength, reason, note: 'client_missing' });
  }

  for (let attempt = 1; attempt <= MEMORY_REDIS_RETRIES; attempt++) {
    try {
      await publishToRedis(queueName, tasks);
      logger.info(
        '[MemoryQueue] Публикация успешна (attempt=%d) reason=%s conv=%s file=%s len=%s',
        attempt,
        reason,
        conversationId,
        fileId,
        textLength
      );
      return;
    } catch (err) {
      logger.error(
        '[MemoryQueue] Ошибка публикации (attempt=%d/%d) reason=%s conv=%s file=%s len=%s: %s',
        attempt,
        MEMORY_REDIS_RETRIES,
        reason,
        conversationId,
        fileId,
        textLength,
        err?.message || err
      );
      if (attempt === MEMORY_REDIS_RETRIES) {
        return saveMemoryBacklog(tasks, { conversationId, userId, fileId, textLength, reason, note: 'max_retries' });
      }
      await sleep(MEMORY_REDIS_BACKOFF_MS * attempt);
    }
  }
}

async function saveMemoryBacklog(tasks, metadata) {
  try {
    await MemoryBacklog.create({
      tasks,
      metadata,
      createdAt: new Date(),
    });
    logger.warn(
      '[MemoryQueue] Задачи сохранены во временный backlog. reason=%s conv=%s file=%s len=%s',
      metadata.reason,
      metadata.conversationId,
      metadata.fileId,
      metadata.textLength
    );
  } catch (err) {
    logger.error(
      '[MemoryQueue] Не удалось сохранить backlog. reason=%s conv=%s file=%s len=%s: %s',
      metadata.reason,
      metadata.conversationId,
      metadata.fileId,
      metadata.textLength,
      err?.message || err
    );
  }
}

module.exports = { enqueueMemoryTasks };
