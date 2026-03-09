# План устранения ReferenceError budgetChars

## 1. Анализ причин и охват
- Основная точка отказа: отложенная ветка в [`buildContext`](api/server/services/agents/context/builder.js:559) обращается к `budgetChars`/`chunkChars`, объявленным внутри блока `else`, что при отсутствии графа/вектора порождает `ReferenceError`.
- Повторное использование настроек в [`applyDeferredCondensation`](api/server/services/agents/context/index.js:220) полагается на снимок, который сейчас не гарантированно содержит валидные значения.
- Смежные сервисы (например, [`context/helpers`](api/server/services/agents/context/helpers.js:210) и [`OverflowGuardService`](api/server/services/agents/OverflowGuardService.js:100)) используют аналогичные параметры, поэтому требуется консистентная инициализация.

## 2. План действий
1. **Унификация вычисления лимитов**
   - Вынести расчёт `budgetChars`, `chunkChars`, `baseTimeoutMs`, `dynamicBudgetChars`, `dynamicChunkChars` в верх функции [`buildContext`](api/server/services/agents/context/builder.js:559), чтобы переменные существовали для всех веток.
   - Принять решение о месте размещения общего helper'а `resolveSummarizationLimits` перед реализацией: либо оставить внутри [`builder.js`](api/server/services/agents/context/builder.js:559) и экспортировать, либо вынести в общий util (например, `context/utils.js`). Требование — runtime, deferred и вспомогательные сервисы (`OverflowGuard`, history) должны брать значения из одного источника.
   - После выбора площадки подключить helper в [`context/index`](api/server/services/agents/context/index.js:220) и [`context/helpers`](api/server/services/agents/context/helpers.js:210).
2. **Надёжный deferred-снимок**
   - При вызове `setDeferredContext` сохранять `summarizationConfigResolved` и дополнительные флаги (`dynamicBudgetChars`, `dynamicChunkChars`).
   - В `applyDeferredCondensation` перестать вычислять дефолты самостоятельно и доверять снимку; при отсутствии значений логировать предупреждение и fallback к helper.
3. **Валидация и логирование**
   - После расчёта лимитов логировать событие `[rag.context.config]` с параметрами, чтобы отлавливать NaN/undefined.
   - На уровне [`context/index`](api/server/services/agents/context/index.js:220) и [`OverflowGuardService`](api/server/services/agents/OverflowGuardService.js:100) добавить защиту от нулевого/отрицательного бюджета.
4. **Тестовое покрытие**
   - Интеграционные тесты на `buildContext`: кейсы "нет контекста + multiStep" (ожидается отсутствие ReferenceError) и "summarization timeout" (фолбек до `budgetChars`).
   - Тест на `applyDeferredCondensation`: снимок без `summarizationConfig` должен обрабатываться дефолтами и логировать предупреждение.
5. **Статический контроль**
   - Добавить ESLint правило/скрипт, проверяющий, что `budgetChars`/`chunkChars` объявлены до использования (особенно в новых файлах сервисов агентов).

## 3. Проверка и внедрение
- Прогнать unit/integration тесты сервисов агентов и RAG.
- Проверить метрики `observeSegmentTokens` и новые логи после деплоя, чтобы убедиться в отсутствии новых превышений и повторных референсов к неопределённым переменным.
