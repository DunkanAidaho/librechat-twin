# Этап 3: Разделение request.js

## 1. MemoryService (новый)

```javascript
// api/server/services/Memory/MemoryService.js

const BaseService = require('../Base/BaseService');
const { queueGateway } = require('../agents/queue');
const { ingestDeduplicator } = require('../Deduplication/ingestDeduplicator');

class MemoryService extends BaseService {
  constructor(options = {}) {
    super({ serviceName: 'memory', ...options });
    this.queueGateway = queueGateway;
  }

  async enqueueMemoryTasks(tasks, meta = {}) {
    const context = this.buildLogContext(null, {
      reason: meta.reason,
      conversationId: meta.conversationId
    });

    this.log('debug', '[memory.queue.start]', context);

    try {
      const dedupeKeys = this.extractDedupeKeys(tasks);
      const result = await this.queueGateway.enqueueMemory(tasks, meta);

      if (result?.status === 'queued') {
        await this.clearDedupeKeys(dedupeKeys);
      }

      this.log('info', '[memory.queue.complete]', {
        ...context,
        status: result?.status,
        taskCount: tasks.length
      });

      return result;
    } catch (error) {
      this.handleError(error, context);
    }
  }

  async markMessagesAsStored(userId, messageIds) {
    const context = { userId, messageCount: messageIds.length };
    
    this.log('debug', '[memory.mark.start]', context);

    try {
      const result = await updateMessage(
        { user: userId },
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

  private extractDedupeKeys(tasks) {
    return tasks
      .filter(task => task?.meta?.dedupe_key || task?.payload?.ingest_dedupe_key)
      .map(task => task.meta?.dedupe_key || task.payload?.ingest_dedupe_key);
  }

  private async clearDedupeKeys(keys) {
    for (const key of keys) {
      try {
        await clearDedupeKey(key, '[MemoryService]');
      } catch (error) {
        this.log('warn', '[memory.dedupe.clear.error]', {
          key,
          error: error.message
        });
      }
    }
  }
}
```

## 2. FileService (новый)

```javascript
// api/server/services/Files/FileService.js

const BaseService = require('../Base/BaseService');
const { encodeAndFormat } = require('./images/encode');
const { LongTextGraphWorker } = require('../Graph/LongTextWorker');

class FileService extends BaseService {
  constructor(options = {}) {
    super({ serviceName: 'files', ...options });
    this.memoryService = options.memoryService;
    this.maxTextSize = this.config.maxTextSize || 500000;
  }

  async processFiles(req, files) {
    const context = this.buildLogContext(req);
    
    this.log('debug', '[files.process.start]', {
      ...context,
      fileCount: files.length
    });

    try {
      const { files: processedFiles, text: ocrText } = await encodeAndFormat(req, files);
      
      if (this.shouldIndexText(ocrText)) {
        await this.handleLongText({
          text: ocrText,
          userId: req.user.id,
          conversationId: req.body.conversationId,
          file: processedFiles[0]
        });
      }

      return processedFiles;
    } catch (error) {
      this.handleError(error, context);
    }
  }

  async handleLongText({ text, userId, conversationId, file }) {
    const context = {
      userId,
      conversationId,
      fileId: file?.file_id,
      textLength: text.length
    };

    this.log('debug', '[files.longtext.start]', context);

    try {
      const dedupeKey = this.makeDedupeKey('text', file.file_id);
      const task = this.createIndexTask({
        text,
        userId,
        conversationId,
        file,
        dedupeKey
      });

      await this.memoryService.enqueueMemoryTasks([task], {
        reason: 'index_text',
        ...context
      });

      // Запуск LongTextGraphWorker
      setImmediate(() => {
        LongTextGraphWorker.enqueue({
          conversationId,
          userId,
          messageId: dedupeKey,
          text,
          dedupeKey
        });
      });
    } catch (error) {
      this.handleError(error, context);
    }
  }

  private shouldIndexText(text) {
    return text && text.length > 0 && text.length <= this.maxTextSize;
  }

  private makeDedupeKey(scope, id) {
    return `ingest_${scope}_${id}`;
  }

  private createIndexTask({ text, userId, conversationId, file, dedupeKey }) {
    return {
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
  }
}
```

## 3. EventService (новый)

```javascript
// api/server/services/Events/EventService.js

const BaseService = require('../Base/BaseService');
const { sendEvent } = require('@librechat/api');
const { canWrite, isResponseFinalized } = require('~/server/utils/responseUtils');

class EventService extends BaseService {
  constructor(options = {}) {
    super({ serviceName: 'events', ...options });
  }

  makeDetachableRes(res) {
    const context = { mode: 'headless' };
    let detached = false;

    const detachableRes = {
      ...res,
      isDetached: () => detached,
      setDetached: (value) => {
        detached = value;
        this.log('info', '[events.detach]', context);
      }
    };

    return detachableRes;
  }

  sendEvent(res, event, options = {}) {
    if (!canWrite(res)) {
      this.log('debug', '[events.skip]', { reason: 'cannot_write' });
      return;
    }

    try {
      sendEvent(res, event);
      
      if (event.final) {
        this.log('debug', '[events.final]', {
          conversationId: event.conversation?.id
        });
      }
    } catch (error) {
      this.log('error', '[events.error]', {
        error: error.message,
        event: event.type
      });
    }
  }

  handleAbortError(res, req, error, context = {}) {
    const logContext = this.buildLogContext(req, {
      ...context,
      error: error.message
    });

    this.log('error', '[events.abort]', logContext);

    if (!isResponseFinalized(res)) {
      this.sendEvent(res, {
        type: 'error',
        error: error.message,
        ...context
      });
    }
  }
}
```

## 4. Обновление AgentController

```javascript
// api/server/controllers/agents/request.js

class AgentController {
  constructor(options = {}) {
    this.services = {
      memory: new MemoryService(options),
      file: new FileService({
        ...options,
        memoryService: this.services.memory
      }),
      event: new EventService(options)
    };
    
    this.logger = getLogger('controllers.agent');
  }

  async handleRequest(req, res, next) {
    const context = this.buildLogContext(req);
    this.logger.info('[request.start]', context);

    try {
      // Обработка файлов
      if (req.body.files?.length) {
        const files = await this.services.file.processFiles(req, req.body.files);
        req.body.files = files;
      }

      // Создание detachable response для headless режима
      const dres = HEADLESS_STREAM ? 
        this.services.event.makeDetachableRes(res) : 
        res;

      // Обработка запроса...

      // Отправка событий
      this.services.event.sendEvent(dres, {
        final: true,
        conversation,
        requestMessage: userMessage,
        responseMessage: response
      });

    } catch (error) {
      this.services.event.handleAbortError(res, req, error, {
        conversationId,
        messageId: responseMessageId
      });
    }
  }
}
```

## 5. Метрики

```javascript
// Добавить метрики для новых сервисов

const memoryMetrics = {
  queueLatency: new Histogram({
    name: 'memory_queue_latency_seconds',
    help: 'Memory queue operation latency',
    labelNames: ['operation', 'status']
  }),
  
  taskCount: new Counter({
    name: 'memory_tasks_total',
    help: 'Number of memory tasks processed',
    labelNames: ['type', 'status']
  })
};

const fileMetrics = {
  processingDuration: new Histogram({
    name: 'file_processing_duration_seconds',
    help: 'File processing duration',
    labelNames: ['type', 'status']
  }),
  
  fileSize: new Histogram({
    name: 'file_size_bytes',
    help: 'Processed file sizes',
    labelNames: ['type']
  })
};

const eventMetrics = {
  eventCount: new Counter({
    name: 'events_sent_total',
    help: 'Number of events sent',
    labelNames: ['type', 'status']
  }),
  
  detachedCount: new Counter({
    name: 'responses_detached_total',
    help: 'Number of detached responses',
    labelNames: ['reason']
  })
};
```

## 6. Логирование

События для логирования:

```javascript
// MemoryService
memory.queue.start
memory.queue.complete
memory.mark.start
memory.mark.complete
memory.dedupe.clear.error

// FileService
files.process.start
files.process.complete
files.longtext.start
files.longtext.complete

// EventService
events.detach
events.skip
events.final
events.error
events.abort
```

## 7. Критерии готовности

1. Все сервисы реализованы и покрыты тестами
2. Логирование соответствует transparent logging initiative
3. Метрики собираются и отправляются
4. Старая функциональность полностью перенесена
5. Документация обновлена
6. Код соответствует требованиям из docs/coder_checklist.md

## 8. Тестирование

1. Unit тесты для каждого сервиса
2. Интеграционные тесты для взаимодействия сервисов
3. Тесты для проверки обработки ошибок
4. Тесты для проверки логирования и метрик
5. Нагрузочные тесты для очередей и обработки файлов

## 9. Следующие шаги

1. Создать PR с новыми сервисами
2. Провести нагрузочное тестирование
3. Обновить документацию
4. Начать миграцию существующего кода на новые сервисы