const BaseService = require('../Base/BaseService');
const { ValidationError } = require('../Base/ErrorHandler');
const { queueGateway } = require('../agents/queue');
const { ingestDeduplicator } = require('../Deduplication/ingestDeduplicator');
const { clearDedupeKey } = require('../Deduplication/clearDedupeKey');
const { updateMessage } = require('~/models');

/**
 * Сервис для управления памятью
 * - Управление очередями памяти
 * - Дедупликация
 * - Маркировка сообщений
 */
class MemoryService extends BaseService {
  /**
   * @param {Object} options
   * @param {MetricsCollector} options.metrics - Сборщик метрик
   */
  constructor(options = {}) {
    super({ serviceName: 'memory', ...options });
    this.metrics = options.metrics;
    this.pendingIngestMarks = new Set();
  }

  /**
   * Ставит задачи в очередь памяти
   * @param {Array} tasks - Задачи для очереди
   * @param {Object} meta - Метаданные
   * @param {Object} [options] - Опции
   * @returns {Promise<Object>} Результат постановки в очередь
   */
  async enqueueMemoryTasks(tasks, meta = {}, options = {}) {
    const context = this.buildLogContext(null, {
      reason: meta.reason,
      conversationId: meta.conversationId
    });

    const startTime = Date.now();
    const dedupeKeys = this.extractDedupeKeys(tasks);

    try {
      this.log('debug', '[memory.queue.start]', {
        ...context,
        taskCount: tasks.length
      });

      const result = await queueGateway.enqueueMemory(tasks, meta);

      if (result?.status === 'queued' && dedupeKeys.length > 0) {
        await this.clearDedupeKeys(dedupeKeys);
      }

      const duration = Date.now() - startTime;
      if (this.metrics) {
        this.metrics.observeDuration('memory_queue', duration, {
          reason: meta.reason,
          status: 'success'
        });
      }

      this.log('info', '[memory.queue.complete]', {
        ...context,
        duration,
        status: result?.status
      });

      return { success: true, error: null, result };
    } catch (error) {
      const duration = Date.now() - startTime;
      if (this.metrics) {
        this.metrics.observeDuration('memory_queue', duration, {
          reason: meta.reason,
          status: 'error'
        });
        this.metrics.incrementErrorCount('memory_queue', {
          reason: meta.reason
        });
      }

      this.handleError(error, context);
    }
  }

  /**
   * Маркирует сообщения как сохраненные в памяти
   * @param {Object} req - Express request
   * @param {Array<string>} messageIds - ID сообщений
   * @returns {Promise<void>}
   */
  async markMessagesAsStored(req, messageIds) {
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return;
    }

    const context = this.buildLogContext(req, {
      messageCount: messageIds.length
    });

    try {
      this.log('debug', '[memory.mark.start]', context);

      const result = await updateMessage(
        req,
        {
          messageId: { $in: messageIds },
          isMemoryStored: true
        },
        { context: 'markMessagesAsStored', multi: true }
      );

      this.log('debug', '[memory.mark.complete]', {
        ...context,
        modifiedCount: result?.modifiedCount
      });
    } catch (error) {
      this.handleError(error, context);
    }
  }

  /**
   * Проверяет и маркирует задачу как обработанную
   * @param {string} key - Ключ дедупликации
   * @param {string} operation - Тип операции
   * @returns {Promise<Object>} Результат проверки
   */
  async markAsIngested(key, operation) {
    const context = { key, operation };

    try {
      this.log('debug', '[memory.dedupe.check]', context);

      const result = await ingestDeduplicator.markAsIngested(key, operation);
      
      if (result.deduplicated) {
        this.log('info', '[memory.dedupe.skip]', {
          ...context,
          mode: result.mode
        });
      } else {
        this.pendingIngestMarks.add(key);
      }

      return result;
    } catch (error) {
      this.handleError(error, context);
    }
  }

  /**
   * Очищает ключ дедупликации
   * @param {string} key - Ключ для очистки
   * @returns {Promise<void>}
   */
  async clearDedupeKey(key) {
    const context = { key };

    try {
      await clearDedupeKey(key, '[MemoryService]');
      this.pendingIngestMarks.delete(key);
    } catch (error) {
      this.log('warn', '[memory.dedupe.clear.error]', {
        ...context,
        error: error.message
      });
    }
  }

  /**
   * Очищает все ожидающие ключи дедупликации
   * @returns {Promise<void>}
   */
  async clearPendingIngestMarks() {
    if (this.pendingIngestMarks.size === 0) {
      return;
    }

    const keys = Array.from(this.pendingIngestMarks);
    for (const key of keys) {
      await this.clearDedupeKey(key);
    }
  }

  /**
   * Извлекает ключи дедупликации из задач
   * @private
   */
  extractDedupeKeys(tasks = []) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return [];
    }

    const keys = [];
    for (const task of tasks) {
      if (!task || typeof task !== 'object') continue;
      
      const payload = task.payload && typeof task.payload === 'object' 
        ? task.payload 
        : task;
      
      const key = task.meta?.dedupe_key || payload?.ingest_dedupe_key;
      if (key) keys.push(key);
    }
    return keys;
  }

  /**
   * Очищает список ключей дедупликации
   * @private
   */
  async clearDedupeKeys(keys) {
    for (const key of keys) {
      await this.clearDedupeKey(key);
    }
  }
}

module.exports = MemoryService;