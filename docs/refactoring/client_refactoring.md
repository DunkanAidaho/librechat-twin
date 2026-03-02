# Рефакторинг `api/server/controllers/agents/client.js`

Документ фиксирует текущее состояние и оставшийся план SRP-разноса. Ранее описанные «готовые» сервисы (TokenManager/MessageProcessor/RagContextBuilder) относятся к целевой архитектуре, но не полностью вынесены из `client.js`.

## Текущее состояние (фактическое)

- **RAG и история**: логика построения контекста и многошагового RAG уже вынесена в сервисы:
  - `server/services/agents/context/*` — построение контекста и map/reduce;
  - `server/services/agents/MessageHistoryManager` + `historyTrimmer` — управление историей;
  - `server/services/RAG/*` — condense, intent, multi-step, cache.
- **Токены/прайсинг**: часть подсчётов и breakdown остаётся в `client.js`, отдельные утилиты есть в `server/services/tokens/TokenCounter` и `server/services/pricing/PricingCalculator`.
- **Память**: интеграции с memory queue и memory agent смешаны с orchestration в `client.js`.
- **Утилиты**: локальные helpers (`parseUsdRate`, `resolvePricingRates`, `detectContextOverflow`, `normalizeInstructionsPayload`) остаются в файле.

## Дубликаты/устаревшие описания (исправлено)

- Убраны утверждения о завершённом разделении на `TokenManager/MessageProcessor/RagContextBuilder` внутри `client.js` — это целевое состояние, а не факт.
- Примеры конфигураций и логов приведены к фактическим модулям (`ConfigService`, `rag.*`, `usageReporter`, `historyTrimmer`).

## Целевая декомпозиция (SRP)

1. **utils/**
   - `normalizeInstructionsPayload` → `app/clients/utils/instructions.js`.
   - `extractMessageText`, `normalizeMemoryText`, `makeIngestKey` → `server/utils/messageUtils.js`.
   - `detectContextOverflow`, `compressMessagesForRetry` → `server/services/agents/utils.js`.
   - Аналоги: `server/utils/messageUtils.js`, `app/clients/utils/instructions.js`, `utils/security.js`, `utils/async.js`.

2. **config/**
   - Вынести дефолты и `ConfigService`-обёртки (например, `DEBUG_SSE`, лимиты графа/истории) в `server/services/Config`.
   - Проверить согласованность с `memoryConfig` и `rag` секциями.

3. **pricing/**
   - `parseUsdRate`/`resolvePricingRates` → `server/services/pricing/PricingCalculator` (или новый helper рядом).
   - `recordCollectedUsage`/`emitPromptTokenBreakdown` → `server/services/agents/usage`.

4. **memory/**
   - `useMemory`, `enrichContextWithMemoryAgent`, enqueue/ingest логика → `server/services/agents/history` или `server/services/Memory`.
   - Привязка к `queueGateway` и `memoryQueue` — через один фасад.

5. **prompt/**
   - `buildMessages`, `applyDeferredCondensation`, работа с `ragContext` → `server/services/agents/context` + `RagContextManager`.
   - Инкапсулировать правила `DEFAULT_SYSTEM_PROMPT` и обработку OCR.

6. **tools/**
   - Tool error handling (`logToolError`), tool-context и `createContextHandlers` → отдельный helper в `server/services/agents/tools`.

7. **usage/**
   - `recordTokenUsage`, `recordCollectedUsage`, `calculateCurrentTokenCount` → `server/services/agents/usage`.

## Карта привязки к существующим сервисам

| Блок | Что вынести | Куда привязать | Файлы-ориентиры |
| --- | --- | --- | --- |
| utils | normalize/extract helpers, overflow/retry | `server/utils/messageUtils.js`, `app/clients/utils/instructions.js`, `server/services/agents/utils.js` | `api/server/utils/messageUtils.js`, `api/app/clients/utils/instructions.js`, `api/server/services/agents/utils.js` |
| config | лимиты history/graph/debug | `server/services/Config/ConfigService.js` | `api/server/services/Config/ConfigService.js` |
| pricing | pricing rates, cost calc | `server/services/pricing/PricingCalculator.js` | `api/server/services/pricing/PricingCalculator.js` |
| memory | memory agent + queue | `server/services/agents/history`, `server/services/RAG/memoryQueue` | `api/server/services/agents/history/index.js`, `api/server/services/RAG/memoryQueue.js` |
| prompt | buildMessages, deferred condense | `server/services/agents/context`, `server/services/RAG/RagContextManager` | `api/server/services/agents/context/index.js`, `api/server/services/RAG/RagContextManager.js` |
| tools | tool errors/context handlers | `server/services/agents/tools` (новый фасад) | `api/server/services/agents/tools/index.js` |
| usage | usage reporting & breakdown | `server/services/agents/usage` | `api/server/services/agents/usage/index.js` |

## Следующие шаги

1. ✅ Вынести утилиты из `client.js` и обновить импорты (instructions/messageUtils/agents/utils).
2. ✅ Разделить pricing/usage/memory в сервисы с единым интерфейсом.
3. ✅ Разнести prompt/tools/usage и зафиксировать новые фасады.
4. Обновить `docs/TODO.md` и `docs/project_map` после первых переносов.
