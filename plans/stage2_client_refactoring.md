# Этап 2: Разделение client.js

## 1. RagContextBuilder (обновление существующего)

```javascript
// api/server/services/RAG/RagContextBuilder.js

const BaseService = require('../Base/BaseService');
const { ServiceError } = require('../Base/ErrorHandler');
const { observeSegmentTokens, setContextLength } = require('~/utils/ragMetrics');

class RagContextBuilder extends BaseService {
  constructor(options = {}) {
    super({ serviceName: 'rag.context', ...options });
    this.ragCache = options.ragCache;
    this.tokenManager = options.tokenManager;
  }

  async buildContext({
    orderedMessages,
    systemContent,
    runtimeCfg,
    req,
    res,
    endpointOption
  }) {
    const context = this.buildLogContext(req, {
      conversationId: req?.body?.conversationId
    });

    this.log('debug', '[rag.context.build.start]', context);

    try {
      // Существующая логика buildContext, но с:
      // 1. Использованием TokenManager для подсчета токенов
      // 2. Интеграцией с RagCache для кэширования
      // 3. Правильным логированием через buildLogContext
      // 4. Обработкой ошибок через ServiceError
    } catch (error) {
      this.handleError(error, context);
    }
  }
}
```

## 2. TokenManager (новый)

```javascript
// api/server/services/Tokens/TokenManager.js

const BaseService = require('../Base/BaseService');
const { Tokenizer } = require('@librechat/api');

class TokenManager extends BaseService {
  constructor(options = {}) {
    super({ serviceName: 'tokens', ...options });
    this.encoding = options.encoding || 'o200k_base';
  }

  getTokenCount(text, encoding = this.encoding) {
    const context = { encoding };
    try {
      if (!text) return 0;
      return Tokenizer.getTokenCount(text, encoding);
    } catch (error) {
      this.log('warn', '[tokens.count.error]', { ...context, error: error.message });
      return text.length; // Fallback
    }
  }

  getMessageTokenCount(message) {
    const context = { messageId: message?.messageId };
    try {
      return getTokenCountForMessage(message, (text) => this.getTokenCount(text));
    } catch (error) {
      this.log('error', '[tokens.message.error]', { ...context, error: error.message });
      throw error;
    }
  }

  validateTokenLimit(count, limit) {
    return count <= limit;
  }
}
```

## 3. MessageProcessor (новый)

```javascript
// api/server/services/Messages/MessageProcessor.js

const BaseService = require('../Base/BaseService');
const { ContextCompressor } = require('../agents/ContextCompressor');

class MessageProcessor extends BaseService {
  constructor(options = {}) {
    super({ serviceName: 'messages', ...options });
    this.tokenManager = options.tokenManager;
    this.compressor = new ContextCompressor({
      tokenManager: this.tokenManager,
      logger: this.logger
    });
  }

  async processMessageHistory({
    orderedMessages,
    conversationId,
    userId,
    histLongUserToRag,
    assistLongToRag,
    assistSnippetChars,
    dontShrinkLastN,
    trimmer,
    tokenBudget,
    contextHeadroom
  }) {
    const context = this.buildLogContext(null, {
      conversationId,
      userId,
      messageCount: orderedMessages.length
    });

    this.log('debug', '[messages.process.start]', context);

    try {
      // Логика из существующего MessageHistoryManager.processMessageHistory
      // но с использованием:
      // 1. TokenManager для подсчета токенов
      // 2. ContextCompressor для сжатия
      // 3. Правильного логирования
    } catch (error) {
      this.handleError(error, context);
    }
  }

  extractMessageText(message, options = {}) {
    const context = { messageId: message?.messageId };
    
    try {
      // Логика из существующего extractMessageText
      // с добавлением логирования
    } catch (error) {
      this.log('warn', '[messages.extract.error]', { ...context, error: error.message });
      return '';
    }
  }
}
```

## 4. Обновление AgentClient

```javascript
// api/server/controllers/agents/client.js

class AgentClient extends BaseClient {
  constructor(options = {}) {
    super(null, options);
    
    // Инициализация новых сервисов
    this.tokenManager = new TokenManager({
      encoding: this.getEncoding()
    });
    
    this.messageProcessor = new MessageProcessor({
      tokenManager: this.tokenManager
    });
    
    this.ragContextBuilder = new RagContextBuilder({
      tokenManager: this.tokenManager,
      ragCache: options.ragCache
    });
  }

  async buildMessages(messages, parentMessageId, options) {
    // Использование новых сервисов вместо прямой логики
    const processed = await this.messageProcessor.processMessageHistory({
      orderedMessages: messages,
      ...options
    });

    const context = await this.ragContextBuilder.buildContext({
      orderedMessages: processed.messages,
      ...options
    });

    return {
      messages: processed.messages,
      context: context
    };
  }
}
```

## 5. Метрики и логирование

1. Добавить метрики:
```javascript
// api/utils/metrics.js

const tokenMetrics = {
  tokenCount: new Counter({
    name: 'token_count_total',
    help: 'Total number of tokens processed',
    labelNames: ['service', 'type']
  }),
  
  messageTokens: new Histogram({
    name: 'message_tokens',
    help: 'Distribution of tokens per message',
    labelNames: ['service', 'role']
  })
};
```

2. Обновить логирование:
```javascript
// Примеры событий для логирования

// TokenManager
tokens.count.start
tokens.count.complete
tokens.message.start
tokens.message.complete
tokens.validate.limit

// MessageProcessor
messages.process.start
messages.process.complete
messages.extract.start
messages.extract.complete
messages.compress.start
messages.compress.complete

// RagContextBuilder
rag.context.build.start
rag.context.cache.hit
rag.context.cache.miss
rag.context.build.complete
```

## 6. Тестирование

1. Unit тесты для каждого сервиса
2. Интеграционные тесты для взаимодействия сервисов
3. Тесты производительности для TokenManager
4. Тесты для проверки логирования и метрик

## 7. Критерии готовности

1. Все новые сервисы реализованы и покрыты тестами
2. Логирование соответствует transparent logging initiative
3. Метрики собираются и отправляются
4. Старая функциональность полностью перенесена
5. Документация обновлена
6. Код соответствует требованиям из docs/coder_checklist.md

## 8. Следующие шаги

1. Создать PR с новыми сервисами
2. Провести нагрузочное тестирование
3. Обновить документацию
4. Начать миграцию существующего кода на новые сервисы