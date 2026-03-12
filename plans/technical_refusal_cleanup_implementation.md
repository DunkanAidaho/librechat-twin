# План реализации очистки истории от технических отказов

## Шаг 1: Подготовка MessageHistoryManager.js
**Файл**: [`api/server/services/agents/MessageHistoryManager.js`](api/server/services/agents/MessageHistoryManager.js)

1. Проверить наличие метода `isTechnicalRefusal(text)`. Если отсутствует или неполный, обновить его согласно спецификации.
2. В методе `processMessageHistory` убедиться, что параметр `hasFreshContext` принимается и используется для фильтрации `orderedMessages`.
3. Логика фильтрации должна быть первой операцией в методе, создавая `filteredMessages`.
4. Все последующие циклы и операции в методе должны использовать `filteredMessages`.

## Шаг 2: Интеграция в AgentClient (client.js)
**Файл**: [`api/server/controllers/agents/client.js`](api/server/controllers/agents/client.js)

1. В методе `buildMessages` вычислить флаг `hasFreshContext`:
   ```javascript
   const hasFreshContext = Boolean(
     (this.options?.req?.ragContextTokens > 0) ||
     (this.options?.req?.ragMultiStep?.ragContext?.entities?.length > 0)
   );
   ```
2. Передать `hasFreshContext` в вызов `this.historyManager.processMessageHistory`.

## Шаг 3: Верификация и логирование
1. Проверить логи `rag.history.refusal_removed` и `rag.history.cleanup_done` при выполнении запросов с RAG.
2. Убедиться, что при отсутствии RAG-контекста сообщения не удаляются.

## Рекомендации для Code mode:
- Используйте `read_file` для получения актуального состояния перед правками.
- Применяйте изменения через `apply_diff` по одному блоку за раз.
- Избегайте полной перезаписи файлов через `write_to_file`, чтобы не повредить структуру (особенно в `client.js`).
