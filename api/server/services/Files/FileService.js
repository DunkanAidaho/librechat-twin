const BaseService = require('../Base/BaseService');
const { ValidationError } = require('../Base/ErrorHandler');
const { encodeAndFormat } = require('./images/encode');
const { LongTextGraphWorker } = require('../Graph/LongTextWorker');
const { makeIngestKey } = require('../utils/messageUtils');

/**
 * Сервис для обработки файлов
 * - Обработка загруженных файлов
 * - Обработка длинных текстов
 * - Интеграция с LongTextGraphWorker
 */
class FileService extends BaseService {
  /**
   * @param {Object} options
   * @param {MemoryService} options.memoryService - Сервис памяти
   * @param {EventService} options.eventService - Сервис событий
   * @param {MetricsCollector} options.metrics - Сборщик метрик
   */
  constructor(options = {}) {
    super({ serviceName: 'files', ...options });

    if (!options.memoryService) {
      throw new ValidationError('MemoryService is required');
    }
    if (!options.eventService) {
      throw new ValidationError('EventService is required');
    }

    this.memoryService = options.memoryService;
    this.eventService = options.eventService;
    this.metrics = options.metrics;
    this.maxTextSize = this.getConfig('maxTextSize', 500000);
  }

  /**
   * Обрабатывает загруженные файлы
   * @param {Object} req - Express request
   * @param {Array} files - Загруженные файлы
   * @returns {Promise<Object>} Результат обработки
   */
  async processFiles(req, files) {
    const context = this.buildLogContext(req);

    try {
      this.log('debug', '[files.process.start]', {
        ...context,
        fileCount: files.length
      });

      // Кодируем и форматируем файлы
      const { files: processedFiles, text: ocrText } = await encodeAndFormat(
        req,
        files,
        req.body?.endpointOption?.provider,
        req.body?.endpointOption?.visionMode
      );

      // Проверяем необходимость индексации текста
      const file = processedFiles[0];
      if (this.shouldIndexText(file, ocrText)) {
        await this.handleLongText({
          text: ocrText,
          userId: req.user.id,
          conversationId: req.body.conversationId,
          file,
          req
        });
      } else {
        this.log('debug', '[files.index.skip]', {
          ...context,
          fileId: file?.file_id,
          reason: 'not_indexable'
        });
      }

      return processedFiles;
    } catch (error) {
      this.handleError(error, context);
    }
  }

  /**
   * Обрабатывает длинный текст
   * @param {Object} options
   * @returns {Promise<void>}
   */
  async handleLongText({ text, userId, conversationId, file, req }) {
    const context = {
      conversationId,
      userId,
      fileId: file?.file_id,
      textLength: text.length
    };

    try {
      this.log('debug', '[files.longtext.start]', context);

      // Создаем ключ дедупликации
      const dedupeKey = makeIngestKey('text', file.file_id);
      
      // Проверяем дедупликацию
      const dedupeResult = await this.memoryService.markAsIngested(
        dedupeKey,
        'index_text'
      );

      if (dedupeResult.deduplicated) {
        this.log('info', '[files.longtext.dedupe]', {
          ...context,
          mode: dedupeResult.mode
        });
        return;
      }

      // Создаем задачу индексации
      const task = {
        type: 'index_text',
        payload: {
          ingest_dedupe_key: dedupeKey,
          message_id: dedupeKey,
          user_id: userId,
          conversation_id: conversationId,
          role: 'user',
          content: text,
          content_type: 'plain_text',
          created_at: new Date().toISOString(),
          source_filename: file.originalname || file.filename,
          mime_type: file.type,
          file_size: file.size
        },
        meta: { dedupe_key: dedupeKey }
      };

      // Ставим в очередь
      const enqueueResult = await this.memoryService.enqueueMemoryTasks(
        [task],
        {
          reason: 'index_text',
          conversationId,
          userId,
          textLength: text.length
        }
      );

      if (!enqueueResult.success) {
        throw enqueueResult.error || new Error('Failed to enqueue memory task');
      }

      if (this.metrics) {
        this.metrics.incrementCounter('longtext_tasks', { status: 'queued' });
      }

      // Отправляем событие об индексации
      const indexedEvent = {
        status: 'indexed',
        conversationId,
        textSize: text.length,
        messageId: dedupeKey
      };

      if (req?.res) {
        this.eventService.sendEvent(req.res, {
          meta: { longTextInfo: indexedEvent }
        });
      }

      // Запускаем LongTextGraphWorker
      setImmediate(() => {
        try {
          LongTextGraphWorker.enqueue({
            conversationId,
            userId,
            messageId: dedupeKey,
            text,
            dedupeKey,
            res: req?.res
          });
        } catch (workerError) {
          this.log('error', '[files.longtext.worker.error]', {
            ...context,
            error: workerError.message
          });
        }
      });

      this.log('info', '[files.longtext.complete]', {
        ...context,
        dedupeKey
      });
    } catch (error) {
      if (this.metrics) {
        this.metrics.incrementCounter('longtext_tasks', { status: 'failed' });
      }
      this.handleError(error, context);
    }
  }

  /**
   * Проверяет, нужно ли индексировать текст
   * @private
   */
  shouldIndexText(file, text) {
    if (!text || !file) {
      return false;
    }

    // Проверяем размер текста
    if (text.length > this.maxTextSize) {
      return false;
    }

    // Проверяем тип файла
    const isTextLike = file.type && (
      file.type.startsWith('text/') ||
      file.type.includes('html') ||
      file.type.includes('json') ||
      file.type.includes('javascript') ||
      file.type.includes('python')
    );

    return isTextLike;
  }
}

module.exports = FileService;