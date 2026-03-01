# Базовая инфраструктура сервисов

## Компоненты

### 1. BaseService
Базовый класс для всех сервисов, обеспечивающий:
- Единый подход к логированию через scoped логгеры
- Централизованную обработку ошибок
- Доступ к конфигурации
- Построение контекста для логов

```javascript
const service = new BaseService({ 
  serviceName: 'my.service',
  config: { /* доп. конфигурация */ }
});

// Логирование
service.log('info', 'operation.start', { data: 'value' });

// Обработка ошибок
try {
  // ...
} catch (error) {
  service.handleError(error, { operation: 'specific_operation' });
}
```

### 2. ErrorHandler
Система типизированных ошибок и утилит для их обработки:
- ServiceError - базовый класс ошибок
- Специализированные типы ошибок (Validation, Resource, Timeout и т.д.)
- Утилиты для обработки ошибок

```javascript
// Создание специфической ошибки
throw new ValidationError('Invalid input', { field: 'username' });

// Обработка асинхронных операций
const safeOperation = ErrorUtils.wrapAsync(async () => {
  // ...
}, { context: 'operation_context' });
```

### 3. MetricsCollector
Централизованный сбор метрик:
- Измерение длительности операций
- Подсчет ошибок
- Метрики токенов и кэша
- Метрики стоимости

```javascript
const metrics = new MetricsCollector({ serviceName: 'my.service' });

// Измерение длительности
const stop = metrics.startTimer('operation_name', { labels });
// ... выполнение операции
const duration = stop();

// Метрики токенов
metrics.observeTokens({
  segment: 'rag_graph',
  tokens: 1000,
  endpoint: 'test',
  model: 'gpt4'
});
```

## Использование

### 1. Создание нового сервиса
```javascript
const BaseService = require('../Base/BaseService');
const { ValidationError } = require('../Base/ErrorHandler');

class MyService extends BaseService {
  constructor(options = {}) {
    super({ serviceName: 'my.service', ...options });
    this.metrics = new MetricsCollector({ serviceName: 'my.service' });
  }

  async performOperation(data) {
    const context = this.buildLogContext(null, { operation: 'perform' });
    const stop = this.metrics.startTimer('operation', context);

    try {
      this.log('debug', 'operation.start', context);
      
      // Выполнение операции
      const result = await this.processData(data);
      
      this.log('info', 'operation.complete', { ...context, result });
      stop();
      return result;
    } catch (error) {
      this.metrics.incrementErrorCount('operation', context);
      this.handleError(error, context);
    }
  }
}
```

### 2. Обработка ошибок
```javascript
try {
  await service.performOperation(data);
} catch (error) {
  if (ErrorUtils.isErrorType(error, 'VALIDATION_ERROR')) {
    // Обработка ошибки валидации
  } else if (error instanceof TimeoutError) {
    // Обработка таймаута
  } else {
    // Общая обработка ошибок
  }
}
```

### 3. Сбор метрик
```javascript
// Метрики длительности
const stop = metrics.startTimer('request_duration', { 
  endpoint: 'api',
  method: 'POST' 
});

// Метрики ошибок
metrics.incrementErrorCount('request_error', {
  endpoint: 'api',
  reason: 'validation'
});

// Метрики токенов
metrics.observeTokens({
  segment: 'rag_vector',
  tokens: tokenCount,
  endpoint: 'openai',
  model: 'gpt4'
});
```

## Тестирование

Для каждого компонента созданы unit-тесты:
- tests/unit/services/Base/BaseService.test.js
- tests/unit/services/Base/ErrorHandler.test.js
- tests/unit/services/Base/MetricsCollector.test.js

### Запуск тестов
```bash
# Все тесты базовой инфраструктуры
npm run test:base

# Конкретный компонент
npm run test -- BaseService.test.js
```

## Метрики и логирование

### Логи
- Все сервисы используют scoped логгеры
- Единый формат логов с контекстом
- Уровни: debug, info, warn, error

### Метрики
- Длительность операций
- Количество ошибок
- Использование токенов
- Статистика кэша
- Стоимость запросов

## Дальнейшее развитие

1. Добавление новых типов ошибок по необходимости
2. Расширение набора метрик
3. Улучшение контекста логирования
4. Добавление трейсинга операций