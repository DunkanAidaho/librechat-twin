# Этап 1: Подготовка базовой инфраструктуры

## 1. Структура директорий

```
api/server/
├── services/
│   ├── Base/
│   │   ├── BaseService.js       # Базовый класс для всех сервисов
│   │   ├── ErrorHandler.js      # Обработка ошибок
│   │   └── MetricsCollector.js  # Сбор метрик
│   ├── Common/
│   │   ├── types.js            # Общие типы и интерфейсы
│   │   └── constants.js        # Константы для всех сервисов
```

## 2. BaseService

```javascript
// api/server/services/Base/BaseService.js

const { getLogger } = require('~/utils/logger');
const { buildContext, getRequestContext } = require('~/utils/logContext');
const configService = require('~/server/services/Config/ConfigService');

class BaseService {
  constructor(options = {}) {
    const { serviceName, config = {} } = options;
    
    if (!serviceName) {
      throw new Error('Service name is required');
    }

    this.serviceName = serviceName;
    this.logger = getLogger(`services.${serviceName}`);
    this.config = {
      ...configService.getSection(serviceName),
      ...config
    };
  }

  /**
   * Создает контекст для логирования
   */
  buildLogContext(req, additionalContext = {}) {
    const requestContext = getRequestContext(req);
    return buildContext(requestContext, {
      service: this.serviceName,
      ...additionalContext
    });
  }

  /**
   * Логирование с контекстом
   */
  log(level, message, context = {}) {
    const logContext = {
      service: this.serviceName,
      ...context
    };
    this.logger[level](message, logContext);
  }

  /**
   * Обработка ошибок с контекстом
   */
  handleError(error, context = {}) {
    const errorContext = {
      service: this.serviceName,
      error: error?.message || error,
      stack: error?.stack,
      ...context
    };

    this.log('error', `[${this.serviceName}] Error`, errorContext);
    throw error;
  }
}
```

## 3. ErrorHandler

```javascript
// api/server/services/Base/ErrorHandler.js

class ServiceError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.context = context;
  }
}

class ValidationError extends ServiceError {
  constructor(message, context = {}) {
    super(message, 'VALIDATION_ERROR', context);
    this.name = 'ValidationError';
  }
}

class ResourceError extends ServiceError {
  constructor(message, context = {}) {
    super(message, 'RESOURCE_ERROR', context);
    this.name = 'ResourceError';
  }
}

class TimeoutError extends ServiceError {
  constructor(message, context = {}) {
    super(message, 'TIMEOUT_ERROR', context);
    this.name = 'TimeoutError';
  }
}

module.exports = {
  ServiceError,
  ValidationError,
  ResourceError,
  TimeoutError
};
```

## 4. MetricsCollector

```javascript
// api/server/services/Base/MetricsCollector.js

const { 
  observeSendMessage,
  incSendMessageFailure,
  observeMemoryQueueLatency,
  incMemoryQueueFailure,
  observeSummaryEnqueue,
  incSummaryEnqueueFailure
} = require('~/utils/metrics');

class MetricsCollector {
  constructor(serviceName) {
    this.serviceName = serviceName;
  }

  /**
   * Нормализация меток для метрик
   */
  normalizeLabels(labels = {}) {
    const normalized = {};
    for (const [key, value] of Object.entries(labels)) {
      normalized[key] = String(value)
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .slice(0, 100);
    }
    return normalized;
  }

  /**
   * Запись метрики с длительностью
   */
  observeDuration(name, duration, labels = {}) {
    const normalizedLabels = this.normalizeLabels(labels);
    const metric = `${this.serviceName}_${name}_duration_seconds`;
    // Интеграция с существующей системой метрик
  }

  /**
   * Инкремент счетчика
   */
  incrementCounter(name, labels = {}) {
    const normalizedLabels = this.normalizeLabels(labels);
    const metric = `${this.serviceName}_${name}_total`;
    // Интеграция с существующей системой метрик
  }
}
```

## 5. Общие типы и константы

```javascript
// api/server/services/Common/types.js

/**
 * @typedef {Object} ServiceOptions
 * @property {string} serviceName
 * @property {Object} [config]
 * @property {Object} [logger]
 */

/**
 * @typedef {Object} LogContext
 * @property {string} service
 * @property {string} [requestId]
 * @property {string} [conversationId]
 * @property {string} [userId]
 */

module.exports = {
  ServiceOptions,
  LogContext
};
```

```javascript
// api/server/services/Common/constants.js

const DEFAULT_TIMEOUT = 30000;
const MAX_RETRY_ATTEMPTS = 3;
const CACHE_TTL = 300000;

module.exports = {
  DEFAULT_TIMEOUT,
  MAX_RETRY_ATTEMPTS,
  CACHE_TTL
};
```

## 6. Критерии готовности этапа

1. Все базовые классы созданы и протестированы
2. Логирование соответствует требованиям transparent logging
3. Метрики интегрированы с существующей системой
4. Документация обновлена
5. Типы и константы определены
6. Тесты для базовых классов написаны

## 7. Тестирование базовой инфраструктуры

```javascript
// tests/unit/services/Base/BaseService.test.js

describe('BaseService', () => {
  it('should create scoped logger', () => {
    const service = new BaseService({ serviceName: 'test' });
    expect(service.logger).toBeDefined();
    expect(service.serviceName).toBe('test');
  });

  it('should build log context correctly', () => {
    const service = new BaseService({ serviceName: 'test' });
    const req = { context: { requestId: '123' } };
    const context = service.buildLogContext(req, { extra: 'data' });
    expect(context).toMatchObject({
      service: 'test',
      requestId: '123',
      extra: 'data'
    });
  });
});
```

## 8. Следующие шаги

1. Создать PR с базовой инфраструктурой
2. Провести код-ревью
3. Обновить документацию
4. Начать миграцию существующих сервисов на новую инфраструктуру