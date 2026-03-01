# План рефакторинга client.js и request.js

## Общие принципы
- Следуем SRP (Single Responsibility Principle)
- Используем scoped логгеры для каждого компонента
- Обеспечиваем прозрачное логирование согласно `docs/1_Trasparent_logging.md`
- Поддерживаем существующие метрики и добавляем новые где необходимо
- Соблюдаем требования к обработке ошибок и resilience

## 1. Разделение client.js

### RagContextBuilder (уже существует, требует рефакторинга)
```typescript
// api/server/services/RAG/RagContextBuilder.js
class RagContextBuilder {
  constructor(options: {
    logger: ScopedLogger,
    config: ConfigService
  })
  
  async buildContext({
    orderedMessages,
    systemContent,
    runtimeCfg,
    req,
    res,
    endpointOption
  }): Promise<{
    patchedSystemContent: string,
    contextLength: number,
    cacheStatus: string,
    metrics: RagMetrics
  }>
}
```

### MessageProcessor (новый)
```typescript
// api/server/services/Messages/MessageProcessor.js
class MessageProcessor {
  constructor(options: {
    logger: ScopedLogger,
    config: ConfigService,
    historyManager: MessageHistoryManager
  })

  async processMessageHistory(options: {
    orderedMessages: Message[],
    conversationId: string,
    userId: string,
    ...historyOptions
  }): Promise<{
    toIngest: Task[],
    modifiedMessages: Message[],
    liveWindowStats?: WindowStats
  }>
}
```

### TokenManager (новый)
```typescript
// api/server/services/Tokens/TokenManager.js
class TokenManager {
  constructor(options: {
    logger: ScopedLogger,
    config: ConfigService
  })

  getTokenCount(text: string, encoding: string): number
  computePromptTokens(messages: Message[]): number
  validateTokenLimits(count: number, limits: TokenLimits): boolean
}
```

## 2. Разделение request.js

### RequestController (рефакторинг существующего)
```typescript
// api/server/controllers/agents/request.js
class RequestController {
  constructor(options: {
    logger: ScopedLogger,
    config: ConfigService,
    services: {
      memory: MemoryService,
      file: FileService,
      event: EventService,
      metrics: MetricsService
    }
  })

  async handleRequest(req: Request, res: Response): Promise<void>
}
```

### MemoryService (новый)
```typescript
// api/server/services/Memory/MemoryService.js
class MemoryService {
  constructor(options: {
    logger: ScopedLogger,
    config: ConfigService,
    queueGateway: QueueGateway
  })

  async enqueueMemoryTasks(tasks: Task[], meta: TaskMeta): Promise<QueueResult>
  async markMessagesAsStored(userId: string, messageIds: string[]): Promise<void>
  async processConversationArtifacts(options: ArtifactOptions): Promise<void>
}
```

### FileService (новый)
```typescript
// api/server/services/Files/FileService.js
class FileService {
  constructor(options: {
    logger: ScopedLogger,
    config: ConfigService,
    memoryService: MemoryService
  })

  async processFiles(files: File[], options: FileOptions): Promise<ProcessedFiles>
  async handleLongText(text: string, options: TextOptions): Promise<void>
}
```

### EventService (новый)
```typescript
// api/server/services/Events/EventService.js
class EventService {
  constructor(options: {
    logger: ScopedLogger,
    config: ConfigService
  })

  sendEvent(res: Response, event: Event): void
  makeDetachableRes(res: Response): DetachableResponse
  handleAbortError(res: Response, error: Error, context: ErrorContext): void
}
```

## 3. Обновление существующих компонентов

### MessageHistoryManager
- Добавить интеграцию с новым MessageProcessor
- Обновить логирование согласно transparent logging initiative
- Добавить метрики для отслеживания обработки истории

### ContextCompressor
- Интегрировать с TokenManager для подсчета токенов
- Добавить метрики сжатия
- Обновить логирование

### RagCache
- Добавить size-aware функциональность
- Интегрировать с метриками
- Обновить логирование

## 4. Метрики и логирование

### Новые метрики
- message_processor_compression_ratio
- token_manager_counts
- memory_service_queue_latency
- file_service_processing_duration
- event_service_detach_count

### Логирование
- Использовать scoped логгеры для всех компонентов
- Добавить buildContext во все операции
- Обеспечить единый формат событий
- Добавить трейсинг для отладки

## 5. Тестирование

### Unit тесты
- Для каждого нового сервиса
- Для обновленных компонентов
- Для интеграций между сервисами

### Интеграционные тесты
- Полный flow обработки запроса
- Сценарии с ошибками и восстановлением
- Проверка метрик и логирования

## 6. Документация

### Обновить
- docs/1_Trasparent_logging.md
- docs/TODO.md
- docs/project_map

### Добавить
- Описание новой архитектуры
- Примеры использования сервисов
- Гайд по миграции