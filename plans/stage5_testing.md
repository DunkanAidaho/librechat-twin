# Этап 5: План тестирования

## 1. Структура тестов

```
tests/
├── unit/
│   ├── services/
│   │   ├── Base/
│   │   │   ├── BaseService.test.js
│   │   │   ├── ErrorHandler.test.js
│   │   │   └── MetricsCollector.test.js
│   │   ├── Messages/
│   │   │   ├── MessageProcessor.test.js
│   │   │   └── ContextCompressor.test.js
│   │   ├── Memory/
│   │   │   ├── MemoryService.test.js
│   │   │   └── MessageHistoryManager.test.js
│   │   ├── RAG/
│   │   │   ├── RagContextBuilder.test.js
│   │   │   └── RagCache.test.js
│   │   ├── Files/
│   │   │   └── FileService.test.js
│   │   └── Events/
│   │       └── EventService.test.js
│   └── controllers/
│       └── agents/
│           ├── client.test.js
│           └── request.test.js
├── integration/
│   ├── rag-pipeline.test.js
│   ├── memory-flow.test.js
│   ├── file-processing.test.js
│   └── event-handling.test.js
└── performance/
    ├── rag-cache.test.js
    ├── message-compression.test.js
    └── long-text.test.js
```

## 2. Unit тесты

### BaseService
```javascript
describe('BaseService', () => {
  it('should create scoped logger', () => {
    const service = new BaseService({ serviceName: 'test' });
    expect(service.logger).toBeDefined();
  });

  it('should build log context correctly', () => {
    const service = new BaseService({ serviceName: 'test' });
    const req = { context: { requestId: '123' } };
    const context = service.buildLogContext(req);
    expect(context).toHaveProperty('service', 'test');
    expect(context).toHaveProperty('requestId', '123');
  });

  it('should handle errors with context', () => {
    const service = new BaseService({ serviceName: 'test' });
    const error = new Error('Test error');
    expect(() => service.handleError(error, { extra: 'data' }))
      .toThrow(error);
  });
});
```

### TokenManager
```javascript
describe('TokenManager', () => {
  it('should count tokens correctly', () => {
    const manager = new TokenManager();
    const text = 'Hello, world!';
    expect(manager.getTokenCount(text)).toBeGreaterThan(0);
  });

  it('should handle empty input', () => {
    const manager = new TokenManager();
    expect(manager.getTokenCount('')).toBe(0);
    expect(manager.getTokenCount(null)).toBe(0);
  });

  it('should validate token limits', () => {
    const manager = new TokenManager();
    expect(manager.validateTokenLimit(100, 200)).toBe(true);
    expect(manager.validateTokenLimit(300, 200)).toBe(false);
  });
});
```

### MemoryService
```javascript
describe('MemoryService', () => {
  it('should enqueue memory tasks', async () => {
    const service = new MemoryService();
    const tasks = [{ type: 'test', payload: {} }];
    const result = await service.enqueueMemoryTasks(tasks, { reason: 'test' });
    expect(result.status).toBe('queued');
  });

  it('should handle dedupe keys', async () => {
    const service = new MemoryService();
    const tasks = [{
      meta: { dedupe_key: 'test-key' },
      payload: {}
    }];
    await service.enqueueMemoryTasks(tasks, {});
    // Проверить, что ключ был очищен
  });
});
```

## 3. Интеграционные тесты

### RAG Pipeline
```javascript
describe('RAG Pipeline Integration', () => {
  it('should process full RAG flow', async () => {
    const ragBuilder = new RagContextBuilder({
      tokenManager: new TokenManager(),
      ragCache: new RagCache()
    });

    const messages = [/* тестовые сообщения */];
    const result = await ragBuilder.buildContext({
      orderedMessages: messages,
      systemContent: 'test',
      runtimeCfg: {}
    });

    expect(result.patchedSystemContent).toBeDefined();
    expect(result.contextLength).toBeGreaterThan(0);
  });
});
```

### Memory Flow
```javascript
describe('Memory Flow Integration', () => {
  it('should handle message history and memory tasks', async () => {
    const historyManager = new MessageHistoryManager({
      messageProcessor: new MessageProcessor(),
      memoryService: new MemoryService()
    });

    const result = await historyManager.processMessageHistory({
      orderedMessages: [/* тестовые сообщения */],
      conversationId: 'test',
      userId: 'user1'
    });

    expect(result.modifiedMessages).toBeDefined();
    expect(result.toIngest).toBeDefined();
  });
});
```

## 4. Нагрузочные тесты

### RagCache Performance
```javascript
describe('RagCache Performance', () => {
  it('should handle high load', async () => {
    const cache = new RagCache({
      maxSizeTokens: 1000000
    });

    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      cache.set(`key-${i}`, {
        systemContent: 'test'.repeat(100)
      });
    }
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(1000); // < 1 секунда
    expect(cache.sizeTokens).toBeLessThanOrEqual(1000000);
  });
});
```

### Message Compression
```javascript
describe('Message Compression Performance', () => {
  it('should compress large message history efficiently', async () => {
    const compressor = new ContextCompressor({
      tokenManager: new TokenManager()
    });

    const messages = Array(1000).fill().map(() => ({
      text: 'test'.repeat(100)
    }));

    const start = Date.now();
    const compressed = await compressor.compress(messages);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(5000); // < 5 секунд
    expect(compressed.length).toBeLessThan(messages.length);
  });
});
```

## 5. Метрики и логирование

### Проверка метрик
```javascript
describe('Metrics Collection', () => {
  it('should collect service metrics', async () => {
    const metrics = {}; // Mock метрик
    const service = new TestService({ metrics });

    await service.doSomething();

    expect(metrics.counter.calls).toBeGreaterThan(0);
    expect(metrics.histogram.observations).toBeGreaterThan(0);
  });
});
```

### Проверка логирования
```javascript
describe('Logging', () => {
  it('should log with correct context', () => {
    const logs = [];
    const mockLogger = {
      debug: (...args) => logs.push(['debug', ...args]),
      info: (...args) => logs.push(['info', ...args])
    };

    const service = new TestService({ logger: mockLogger });
    service.doSomething();

    expect(logs).toContainEqual([
      'debug',
      'test.operation.start',
      expect.objectContaining({ service: 'test' })
    ]);
  });
});
```

## 6. Критерии успешного тестирования

1. Покрытие кода:
   - Unit тесты: > 80%
   - Интеграционные тесты: > 70%
   - Критические пути: 100%

2. Производительность:
   - RagCache: < 1ms для операций чтения
   - Компрессия: < 100ms на сообщение
   - Очереди: < 50ms латентность

3. Надежность:
   - Корректная обработка ошибок
   - Правильное освобождение ресурсов
   - Устойчивость к нагрузке

4. Логирование:
   - Все события логируются
   - Контекст присутствует
   - Форматы соответствуют требованиям

5. Метрики:
   - Все метрики собираются
   - Правильные лейблы
   - Корректные значения

## 7. Инструменты

1. Jest для unit и интеграционных тестов
2. k6 для нагрузочного тестирования
3. Istanbul для измерения покрытия
4. Prometheus для проверки метрик
5. Winston для проверки логирования

## 8. CI/CD интеграция

```yaml
test:
  script:
    - npm run test:unit
    - npm run test:integration
    - npm run test:performance
  coverage: '/Statements.*?(\d+\.?\d+)%/'
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura-coverage.xml
```

## 9. Следующие шаги

1. Написать базовые тесты
2. Настроить CI/CD пайплайн
3. Добавить нагрузочные тесты
4. Обновить документацию
5. Провести код-ревью тестов