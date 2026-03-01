# Этап 4: Обновление существующих компонентов

## 1. ContextCompressor

```javascript
// api/server/services/agents/ContextCompressor.js

const BaseService = require('../Base/BaseService');

class ContextCompressor extends BaseService {
  constructor(options = {}) {
    super({ serviceName: 'compressor', ...options });
    this.tokenManager = options.tokenManager;
  }

  async compress(messages, options = {}) {
    const context = {
      messageCount: messages.length,
      ...options
    };

    this.log('debug', '[compressor.start]', context);

    try {
      const startTokens = await this.countTotalTokens(messages);
      
      // Существующая логика сжатия, но с:
      // 1. Использованием TokenManager
      // 2. Правильным логированием
      // 3. Сбором метрик

      const endTokens = await this.countTotalTokens(compressedMessages);
      
      this.log('info', '[compressor.complete]', {
        ...context,
        startTokens,
        endTokens,
        compressionRatio: endTokens / startTokens
      });

      return compressedMessages;
    } catch (error) {
      this.handleError(error, context);
    }
  }

  private async countTotalTokens(messages) {
    return messages.reduce((total, msg) => 
      total + this.tokenManager.getMessageTokenCount(msg), 0);
  }
}
```

## 2. MessageHistoryManager

```javascript
// api/server/services/agents/MessageHistoryManager.js

const BaseService = require('../Base/BaseService');

class MessageHistoryManager extends BaseService {
  constructor(options = {}) {
    super({ serviceName: 'history', ...options });
    this.messageProcessor = options.messageProcessor;
    this.memoryService = options.memoryService;
  }

  async processMessageHistory(options) {
    const context = this.buildLogContext(null, {
      conversationId: options.conversationId,
      userId: options.userId
    });

    this.log('debug', '[history.process.start]', context);

    try {
      // Использовать MessageProcessor для обработки
      const result = await this.messageProcessor.processMessageHistory(options);

      // Если есть сообщения для индексации
      if (result.toIngest.length > 0) {
        await this.memoryService.enqueueMemoryTasks(result.toIngest, {
          reason: 'history_sync',
          ...context
        });
      }

      this.log('info', '[history.process.complete]', {
        ...context,
        processedCount: result.modifiedMessages.length,
        ingestCount: result.toIngest.length
      });

      return result;
    } catch (error) {
      this.handleError(error, context);
    }
  }
}
```

## 3. RagCache

```javascript
// api/server/services/RAG/RagCache.js

const BaseService = require('../Base/BaseService');

class RagCache extends BaseService {
  constructor(options = {}) {
    super({ serviceName: 'rag.cache', ...options });
    this.tokenManager = options.tokenManager;
    this.cache = new Map();
    this.sizeTokens = 0;
    this.maxSizeTokens = options.maxSizeTokens || 1000000;
  }

  set(key, value) {
    const context = { key };

    try {
      const tokenCount = this.tokenManager.getTokenCount(value.systemContent);
      
      // Очистка кэша если нужно
      this.evictIfNeeded(tokenCount);

      this.cache.set(key, {
        ...value,
        tokenCount,
        accessedAt: Date.now()
      });

      this.sizeTokens += tokenCount;

      this.log('debug', '[cache.set]', {
        ...context,
        tokenCount,
        totalSize: this.sizeTokens
      });
    } catch (error) {
      this.handleError(error, context);
    }
  }

  private evictIfNeeded(requiredTokens) {
    if (this.sizeTokens + requiredTokens <= this.maxSizeTokens) {
      return;
    }

    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].accessedAt - b[1].accessedAt);

    for (const [key, entry] of entries) {
      if (this.sizeTokens + requiredTokens <= this.maxSizeTokens) {
        break;
      }

      this.cache.delete(key);
      this.sizeTokens -= entry.tokenCount;

      this.log('info', '[cache.evict]', {
        key,
        tokenCount: entry.tokenCount,
        remainingSize: this.sizeTokens
      });
    }
  }
}
```

## 4. LongTextWorker

```javascript
// api/server/services/Graph/LongTextWorker.js

const BaseService = require('../Base/BaseService');

class LongTextWorker extends BaseService {
  constructor(options = {}) {
    super({ serviceName: 'longtext', ...options });
    this.memoryService = options.memoryService;
    this.eventService = options.eventService;
  }

  async enqueue(options) {
    const {
      conversationId,
      userId,
      messageId,
      text,
      dedupeKey,
      res
    } = options;

    const context = {
      conversationId,
      messageId,
      userId,
      textLength: text.length
    };

    this.log('debug', '[longtext.enqueue]', context);

    try {
      // Обработка текста чанками
      const chunks = this.splitIntoChunks(text);
      
      for (const [index, chunk] of chunks.entries()) {
        const task = this.createChunkTask({
          chunk,
          index,
          total: chunks.length,
          messageId,
          userId,
          conversationId,
          dedupeKey
        });

        await this.memoryService.enqueueMemoryTasks([task], {
          reason: 'longtext_chunk',
          ...context,
          chunkIndex: index
        });

        // Отправка прогресса через EventService
        if (res) {
          this.eventService.sendEvent(res, {
            type: 'progress',
            data: {
              current: index + 1,
              total: chunks.length
            }
          });
        }
      }

      this.log('info', '[longtext.complete]', {
        ...context,
        chunks: chunks.length
      });
    } catch (error) {
      this.handleError(error, context);
    }
  }
}
```

## 5. Метрики

```javascript
// Добавить метрики для обновленных компонентов

const compressorMetrics = {
  compressionRatio: new Histogram({
    name: 'message_compression_ratio',
    help: 'Message compression ratio',
    labelNames: ['type']
  }),
  
  processingTime: new Histogram({
    name: 'compressor_processing_seconds',
    help: 'Time spent compressing messages',
    labelNames: ['status']
  })
};

const historyMetrics = {
  processedMessages: new Counter({
    name: 'history_messages_processed_total',
    help: 'Number of processed history messages',
    labelNames: ['type']
  }),
  
  ingestTasks: new Counter({
    name: 'history_ingest_tasks_total',
    help: 'Number of history ingest tasks created',
    labelNames: ['reason']
  })
};

const cacheMetrics = {
  size: new Gauge({
    name: 'rag_cache_size_tokens',
    help: 'Current size of RAG cache in tokens'
  }),
  
  evictions: new Counter({
    name: 'rag_cache_evictions_total',
    help: 'Number of cache evictions',
    labelNames: ['reason']
  })
};

const longtextMetrics = {
  chunks: new Histogram({
    name: 'longtext_chunks_count',
    help: 'Number of chunks per long text',
    labelNames: ['type']
  }),
  
  processingTime: new Histogram({
    name: 'longtext_processing_seconds',
    help: 'Time spent processing long text',
    labelNames: ['status']
  })
};
```

## 6. Логирование

События для логирования:

```javascript
// ContextCompressor
compressor.start
compressor.complete
compressor.chunk.start
compressor.chunk.complete

// MessageHistoryManager
history.process.start
history.process.complete
history.ingest.start
history.ingest.complete

// RagCache
cache.set
cache.get
cache.evict
cache.clear

// LongTextWorker
longtext.enqueue
longtext.chunk.start
longtext.chunk.complete
longtext.complete
```

## 7. Критерии готовности

1. Все компоненты обновлены и используют новые сервисы
2. Логирование соответствует transparent logging initiative
3. Метрики собираются и отправляются
4. Тесты обновлены и проходят
5. Документация актуализирована
6. Код соответствует требованиям из docs/coder_checklist.md

## 8. Тестирование

1. Unit тесты для обновленных компонентов
2. Интеграционные тесты с новыми сервисами
3. Тесты для проверки логирования
4. Тесты для проверки метрик
5. Нагрузочные тесты для кэша и обработки длинных текстов

## 9. Следующие шаги

1. Создать PR с обновлениями компонентов
2. Провести нагрузочное тестирование
3. Обновить документацию
4. Начать использование обновленных компонентов в основном коде