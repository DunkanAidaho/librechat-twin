# EventService API

## Общее описание

`EventService` предоставляет унифицированный интерфейс для отправки Server-Sent Events (SSE) клиенту. Сервис наследуется от `BaseService` и включает встроенное логирование и обработку ошибок.

## Установка

```javascript
const { EventService } = require('../../services/Events/EventService');
const eventService = new EventService();
```

## Методы

### sendEvent(res, event)

Отправляет произвольное событие клиенту.

```javascript
eventService.sendEvent(res, {
  type: 'message',
  data: {
    content: 'Hello world'
  }
});
```

#### Параметры
- `res` (Response): Express response объект
- `event` (Object): Объект события
  - `type` (string): Тип события
  - `data` (any): Данные события

### sendCompletionEvent(res)

Отправляет событие завершения.

```javascript
eventService.sendCompletionEvent(res);
```

#### Параметры
- `res` (Response): Express response объект

### sendErrorEvent(res, error)

Отправляет событие ошибки.

```javascript
eventService.sendErrorEvent(res, {
  code: 'VALIDATION_ERROR',
  message: 'Invalid input'
});
```

#### Параметры
- `res` (Response): Express response объект
- `error` (Object|Error): Объект ошибки
  - `code` (string): Код ошибки
  - `message` (string): Сообщение об ошибке
  - `stack` (string, optional): Стек ошибки (только в development)

### sendAcknowledgement(res, metadata)

Отправляет событие подтверждения.

```javascript
eventService.sendAcknowledgement(res, {
  messageId: 'msg-123',
  status: 'received'
});
```

#### Параметры
- `res` (Response): Express response объект
- `metadata` (Object): Дополнительные метаданные события

## Форматы событий

### Базовый формат
```javascript
{
  type: string,          // Тип события
  data?: any,           // Данные события (опционально)
  meta?: Object,        // Метаданные (опционально)
  final?: boolean       // Флаг завершающего события (опционально)
}
```

### Формат ошибки
```javascript
{
  type: 'error',
  error: {
    code: string,       // Код ошибки
    message: string,    // Сообщение
    stack?: string     // Стек (только в development)
  }
}
```

### Формат подтверждения
```javascript
{
  type: 'acknowledgement',
  ...metadata           // Дополнительные поля из metadata
}
```

## Примеры использования

### Отправка прогресса обработки
```javascript
eventService.sendEvent(res, {
  type: 'progress',
  data: {
    percent: 45,
    status: 'processing'
  }
});
```

### Отправка финального результата
```javascript
eventService.sendEvent(res, {
  type: 'message',
  final: true,
  data: {
    result: 'Completed',
    details: { ... }
  }
});
```

### Обработка ошибок
```javascript
try {
  // ... some code
} catch (error) {
  eventService.sendErrorEvent(res, {
    code: error.code || 'UNKNOWN_ERROR',
    message: error.message
  });
}
```

## Лучшие практики

1. **Типы событий**
   - Используйте константы для типов событий
   - Документируйте новые типы событий

2. **Обработка ошибок**
   - Всегда оборачивайте отправку событий в try-catch
   - Используйте информативные коды ошибок

3. **Метаданные**
   - Добавляйте контекстную информацию в meta
   - Используйте стандартные поля метаданных

4. **Финализация**
   - Используйте `final: true` для последнего события
   - Закрывайте соединение после финального события

## Отладка

Сервис автоматически логирует все события и ошибки. Для отладки проверяйте:

1. Логи сервера с тегом `[EventService]`
2. Network панель в DevTools (вкладка EventStream)
3. Метрики в мониторинге событий