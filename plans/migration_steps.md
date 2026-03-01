# План миграции client.js и request.js

## Этап 1: Подготовка базовых классов и утилит

1. Создать базовый сервисный класс в `api/server/services/Base/BaseService.js`:
```javascript
const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');

class BaseService {
  constructor(serviceName, config) {
    this.logger = getLogger(`services.${serviceName}`);
    this.config = config;
    this.serviceName = serviceName;
  }

  buildLogContext(req, additionalContext = {}) {
    return buildContext(req?.context || {}, {
      service: this.serviceName,
      ...additionalContext
    });
  }
}
```

2. Создать базовый класс для обработки ошибок в `api/server/services/Base/ErrorHandler.js`:
```javascript
class ServiceError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.code = code;
    this.context = context;
  }
}
```

## Этап 2: Миграция client.js

1. Создать MessageProcessor:
- Перенести логику обработки сообщений из client.js
- Интегрировать с существующим MessageHistoryManager
- Добавить scoped логирование

2. Обновить RagContextBuilder:
- Вынести логику кэширования в отдельный RagCache
- Добавить интеграцию с TokenManager
- Обновить логирование согласно transparent logging

3. Создать TokenManager:
- Перенести всю логику работы с токенами
- Добавить метрики подсчета токенов
- Интегрировать с существующими сервисами

## Этап 3: Миграция request.js

1. Создать MemoryService:
- Перенести логику очередей и дедупликации
- Интегрировать с существующим memoryQueue
- Добавить метрики и логирование

2. Создать FileService:
- Перенести логику обработки файлов и LongText
- Интегрировать с MemoryService
- Добавить обработку ошибок и метрики

3. Создать EventService:
- Перенести логику SSE и detachable responses
- Добавить метрики для отслеживания соединений
- Обеспечить корректную обработку отключений

## Этап 4: Обновление существующих компонентов

1. MessageHistoryManager:
```javascript
class MessageHistoryManager {
  constructor(options) {
    this.logger = getLogger('services.history');
    this.processor = new MessageProcessor(options);
  }

  async processMessageHistory(options) {
    const context = this.buildLogContext(options);
    this.logger.debug('history.process.start', context);
    // ... существующая логика ...
  }
}
```

2. ContextCompressor:
```javascript
class ContextCompressor {
  constructor(options) {
    this.logger = getLogger('services.compressor');
    this.tokenManager = options.tokenManager;
  }

  async compress(messages, options) {
    const context = this.buildLogContext(options);
    this.logger.debug('compressor.start', context);
    // ... существующая логика ...
  }
}
```

## Этап 5: Обновление контроллеров

1. Обновить AgentController:
```javascript
class AgentController {
  constructor(options) {
    this.services = {
      memory: new MemoryService(options),
      file: new FileService(options),
      event: new EventService(options)
    };
    this.logger = getLogger('controllers.agent');
  }

  async handleRequest(req, res) {
    const context = this.buildLogContext(req);
    this.logger.info('request.start', context);
    // ... обновленная логика с использованием сервисов ...
  }
}
```

## Этап 6: Тестирование и документация

1. Создать тесты для новых компонентов:
- Unit тесты для каждого сервиса
- Интеграционные тесты для основных flow
- Тесты для проверки логирования и метрик

2. Обновить документацию:
- Добавить описания новых сервисов
- Обновить примеры использования
- Добавить диаграммы взаимодействия

## Порядок миграции

1. Начать с TokenManager, так как он имеет минимум зависимостей
2. Создать MessageProcessor и обновить MessageHistoryManager
3. Обновить RagContextBuilder и RagCache
4. Создать MemoryService и FileService
5. Создать EventService
6. Обновить контроллеры
7. Провести тестирование
8. Обновить документацию

## Критерии готовности

1. Все новые сервисы используют scoped логгеры
2. Метрики собираются и отправляются
3. Тесты проходят успешно
4. Документация актуализирована
5. Код соответствует требованиям из docs/coder_checklist.md
6. Логирование соответствует transparent logging initiative