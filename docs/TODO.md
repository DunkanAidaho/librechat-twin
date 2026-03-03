# LibreChat RAG & Memory Improvement Plan — Backlog

Этот документ переведён в формат бэклога: эпики → задачи → статус/приоритет/оценка.
Формат ориентирован на Agile (Jira/YouTrack/таблица).

---

## Бэклог проекта: LibreChat RAG & Memory Improvement Plan

## FIX (выполняется в первую очередь)
**Правило:** пока FIX не стабилизирован/исправлен, к остальному бэклогу не приступаем.

| ID | Задача | Приоритет | Оценка (усл. ед.) | Статус | Описание (зачем/что делаем) | Ссылки |
|----|------|----------|------------------|--------|-----------------------------|--------|
| F-1 | Текст пользователя усечён до LLM | Критический | 5 | Готово | **Зачем:** модель должна видеть полный пользовательский текст, иначе ответы деградируют. **Что делаем:** фиксируем точку усечения (до `buildMessages`/форматирования/лимитов), добавляем трассировку длины/токенов входного `message.text` и итогового массива `formattedMessages`, устраняем неверный лимит/обрезку, держим последний user‑сообщение вне сжатия, исправляем падение токен‑счётчика в chain‑runner, логируем фактическое сжатие последнего user при overflow‑ретрае, фикс: не сжимать последнее user‑сообщение при overflow‑ретрае. | [`api/server/controllers/agents/request.js`](api/server/controllers/agents/request.js), [`api/server/controllers/agents/client.js`](api/server/controllers/agents/client.js), [`api/server/services/agents/MessageHistoryManager.js`](api/server/services/agents/MessageHistoryManager.js), [`api/server/services/agents/historyTrimmer.js`](api/server/services/agents/historyTrimmer.js), [`api/server/services/tokens/TokenCounter.js`](api/server/services/tokens/TokenCounter.js), [`api/server/services/agents/utils.js`](api/server/services/agents/utils.js) |
| F-2 | Контекст «снежным комом» → переполнение окна модели | Критический | 3 | В работе | **Зачем:** короткие запросы тащат весь хвост (история+RAG+инструкции), упираются в лимит модели, дальше сжимаются пост‑фактум и дают обрывки. **Что делаем:** перейти от «широкой трубы» к фильтрации релевантного: (1) **динамический бюджет per‑model** (gpt‑5.2=400k, gemini‑pro=1M и т.д.) в `PromptBudgetManager`/`AgentClient` с headroom и share для instructions/history/RAG; (2) **отбор истории**: live‑window + summary, гигантские блоки → summary+memory/RAG; (3) **RAG как фильтр**: лимиты per‑model на graph/vector, rerank+top‑k по сущностям, condense только при переполнении share; (4) **минимизировать overflow‑retry** за счёт предварительного budget‑контроля. **QA:** короткий запрос после длинного контекста; модель с лимитом 1M; RAG с множеством сущностей. **Подробная декомпозиция:** [`plans/f2_context_decomposition.md`](plans/f2_context_decomposition.md). | [`api/server/services/agents/PromptBudgetManager.js`](api/server/services/agents/PromptBudgetManager.js), [`api/server/controllers/agents/client.js`](api/server/controllers/agents/client.js), [`api/server/services/agents/historyTrimmer.js`](api/server/services/agents/historyTrimmer.js), [`api/server/services/RAG/RagContextBuilder.js`](api/server/services/RAG/RagContextBuilder.js), [`api/server/services/RAG/multiStepOrchestrator.js`](api/server/services/RAG/multiStepOrchestrator.js), [`api/server/services/RAG/RagContextManager.js`](api/server/services/RAG/RagContextManager.js) |

---

### Эпик 1: Док-индекс и инвентаризация
**Приоритет:** Низкий  
**Статус:** Готово  

| ID | Задача | Приоритет | Оценка (усл. ед.) | Статус | Описание (зачем/что делаем) | Ссылки |
|----|------|----------|------------------|--------|-----------------------------|--------|
| 1.1 | Инвентаризация docs/индексов | Низкий | 2 | Готово | **Зачем:** единая навигация по документации. **Что делаем:** сводим индекс по подпапкам `docs/`, проверяем ссылки на `TODO/project_map`. | [`docs/README.md`](docs/README.md), [`docs/project_map`](docs/project_map) |
| 1.2 | Поддержка синхронизации при переносах | Низкий | 1 | Готово | **Зачем:** избежать расхождений между индексами. **Что делаем:** фиксируем переносы в `docs/README.md`, `docs/TODO.md`, `docs/project_map`. | [`docs/README.md`](docs/README.md), [`docs/project_map`](docs/project_map) |

---

### Эпик 2: Transparent logging initiative
**Приоритет:** Высокий  
**Статус:** В работе  

| ID | Задача | Приоритет | Оценка (усл. ед.) | Статус | Описание (зачем/что делаем) | Ссылки |
|----|------|----------|------------------|--------|-----------------------------|--------|
| 2.1 | Расширить `logging` секцию в `ConfigService` | Высокий | 3 | В работе | **Зачем:** управлять логированием из единого конфига. **Что делаем:** добавляем уровень, формат, цвет, файл-транспорт, флаги `tracePipeline/debugSse/tokenUsageReportMode`. | [`api/server/services/Config/ConfigService.js`](api/server/services/Config/ConfigService.js), [`docs/logging/transparent_logging.md`](docs/logging/transparent_logging.md) |
| 2.2 | Обновить `.env` примеры и README | Средний | 1 | Ожидает | **Зачем:** документировать новые переменные. **Что делаем:** дополняем `.env` и README описанием параметров логирования. | [`.env`](.env), [`docs/README.md`](docs/README.md) |
| 2.3 | Генерация `requestId` в middleware | Высокий | 2 | В работе | **Зачем:** сквозной трейсинг запросов. **Что делаем:** генерируем `requestId` на входе и пробрасываем в `req.context`. | [`api/server/routes/agents/chat.js`](api/server/routes/agents/chat.js) |
| 2.4 | Стандартизовать события для LLM клиентов | Средний | 3 | В работе | **Зачем:** единый формат событий по провайдерам. **Что делаем:** приводим события к `request:start/stream:token/request:retry/request:error`. | [`api/app/clients/AnthropicClient.js`](api/app/clients/AnthropicClient.js), [`api/app/clients/OpenAIClient.js`](api/app/clients/OpenAIClient.js), [`api/app/clients/GoogleClient.js`](api/app/clients/GoogleClient.js), [`api/app/clients/BaseClient.js`](api/app/clients/BaseClient.js) |
| 2.5 | Утвердить набор полей для логов | Средний | 2 | Ожидает | **Зачем:** предсказуемая структура логов. **Что делаем:** фиксируем обязательные поля `timestamp/level/scope/message/requestId/conversationId/userId/context`. | [`docs/logging/transparent_logging.md`](docs/logging/transparent_logging.md) |
| 2.6 | Обновить документацию по логированию | Средний | 1 | Ожидает | **Зачем:** актуальная карта статусов. **Что делаем:** обновляем примеры и отмечаем статусы по файлам в `docs/project_map`. | [`docs/logging/transparent_logging.md`](docs/logging/transparent_logging.md), [`docs/project_map`](docs/project_map) |
| 2.7 | Снизить накладные расходы логирования | Средний | 2 | Ожидает | **Зачем:** снизить I/O и шум в проде. **Что делаем:** управляем детализацией через `TRACE_PIPELINE/DEBUG_SSE`, агрегируем метрики пачками. | [`docs/logging/transparent_logging.md`](docs/logging/transparent_logging.md), [`api/utils/logger/index.js`](api/utils/logger/index.js) |

---

### Эпик 3: SRP-разнос AgentClient
**Приоритет:** Высокий  
**Статус:** В работе  

| ID | Задача | Приоритет | Оценка (усл. ед.) | Статус | Описание (зачем/что делаем) | Ссылки |
|----|------|----------|------------------|--------|-----------------------------|--------|
| 3.1 | Разнести `client.js` по блокам utils/config/pricing/memory/prompt/tools/usage | Высокий | 5 | В работе | **Зачем:** соблюдение SRP и тестируемость. **Что делаем:** выносим логику `AgentClient` в сервисы и фасады. | [`api/server/controllers/agents/client.js`](api/server/controllers/agents/client.js), [`docs/refactoring/client_refactoring.md`](docs/refactoring/client_refactoring.md) |
| 3.2 | Увязать с существующими сервисами | Средний | 3 | Ожидает | **Зачем:** минимизировать дублирование. **Что делаем:** интегрируем с `server/services/agents/*`, `pricing/*`, `RAG/*`. | [`api/server/services/agents`](api/server/services/agents), [`api/server/services/pricing`](api/server/services/pricing), [`api/server/services/RAG`](api/server/services/RAG) |
| 3.3 | Архитектурные сервисы SRP | Высокий | 4 | Ожидает | **Зачем:** разделить ответственности. **Что делаем:** выделяем HistoryManager, RagOrchestrator, ContextBuilder, MessageProcessor, ToolExecutor, UsageTracker. | [`docs/refactoring/client_refactoring.md`](docs/refactoring/client_refactoring.md) |
| 3.4 | Chain of Responsibility для обработки сообщений | Средний | 3 | Ожидает | **Зачем:** расширяемость пайплайна. **Что делаем:** вводим цепочку OCR → сжатие → RAG → токены → промпт. | [`api/server/services/agents/context`](api/server/services/agents/context) |
| 3.5 | Конфиги через ConfigService | Средний | 2 | Ожидает | **Зачем:** единый источник параметров. **Что делаем:** переносим `runtimeCfg/historyCompressionCfg/limits` в ConfigService. | [`api/server/services/Config/ConfigService.js`](api/server/services/Config/ConfigService.js) |
| 3.6 | Изоляция инфраструктуры | Средний | 3 | Ожидает | **Зачем:** снизить связанность и упростить мокирование. **Что делаем:** вводим адаптеры для `queueGateway/axios/Message.updateMany`. | [`api/server/services/agents/queue`](api/server/services/agents/queue), [`api/models/Message.js`](api/models/Message.js) |
| 3.7 | Оптимизация производительности | Средний | 4 | Ожидает | **Зачем:** ускорить обработку сообщений. **Что делаем:** кэш intent/graph, async ingest, лимиты, токенизация, снижение логов. | [`docs/refactoring/client_refactoring.md`](docs/refactoring/client_refactoring.md) |

---

### Эпик 4: Multi-step RAG + Graph resilience
**Приоритет:** Критический  
**Статус:** Ожидает  

| ID | Задача | Приоритет | Оценка (усл. ед.) | Статус | Описание (зачем/что делаем) | Ссылки |
|----|------|----------|------------------|--------|-----------------------------|--------|
| 4.1 | Собрать данные за 18–20.02.2026 | Высокий | 2 | Ожидает | **Зачем:** иметь факты для RCA. **Что делаем:** выгружаем логи/метрики, собираем `conversationId`, дедуп-ключи, статус очередей. | [`api/server/services/Graph/LongTextWorker.js`](api/server/services/Graph/LongTextWorker.js) |
| 4.2 | Реплицировать сценарий LongText ingestion → multi-step RAG | Высокий | 3 | Ожидает | **Зачем:** локализовать сбой. **Что делаем:** поднимаем stand-alone сценарий с тем же конфигом, фиксируем место разрыва. | [`api/server/services/Graph/LongTextWorker.js`](api/server/services/Graph/LongTextWorker.js) |
| 4.3 | Провести аудит pipeline | Высокий | 4 | Ожидает | **Зачем:** выявить конфликты таймаутов/бюджетов. **Что делаем:** анализируем цепочку `LongTextWorker → RagContextBuilder → multiStepOrchestrator → condenseContext`. | [`api/server/services/RAG/RagContextBuilder.js`](api/server/services/RAG/RagContextBuilder.js), [`api/server/services/RAG/multiStepOrchestrator.js`](api/server/services/RAG/multiStepOrchestrator.js) |
| 4.4 | Реализовать фиксы для pipeline | Высокий | 5 | Ожидает | **Зачем:** стабилизировать multi-step. **Что делаем:** выравниваем таймауты, защищаем очереди, корректно помечаем LongText-чанки. | [`api/server/services/RAG/multiStepOrchestrator.js`](api/server/services/RAG/multiStepOrchestrator.js) |
| 4.5 | Подготовить варианты для пользователя | Средний | 2 | Ожидает | **Зачем:** управляемый rollout. **Что делаем:** описываем workaround и полноценный патч с сроками. | [`docs/logging/transparent_logging.md`](docs/logging/transparent_logging.md) |
| 4.6 | Добавить автотесты и алерты | Средний | 3 | Ожидает | **Зачем:** предотвратить регресс. **Что делаем:** автотест large-context, нагрузка, алерты по таймаутам. | [`docs/coder_checklist.md`](docs/coder_checklist.md) |

---

### Эпик 5: Оптимизация RAG
**Приоритет:** Средний  
**Статус:** Ожидает  

| ID | Задача | Приоритет | Оценка (усл. ед.) | Статус | Описание (зачем/что делаем) | Ссылки |
|----|------|----------|------------------|--------|-----------------------------|--------|
| 5.1 | Реализовать size-aware cache | Средний | 4 | Ожидает | **Зачем:** контролировать память кэша. **Что делаем:** учитываем «вес» записей и общий бюджет. | [`api/server/services/RAG/RagCache.js`](api/server/services/RAG/RagCache.js) |
| 5.2 | Добавить метрики Prometheus для ragCache | Средний | 3 | Ожидает | **Зачем:** наблюдаемость кэша. **Что делаем:** метрики объёма, эвикций, hit/miss, алерты >80%. | [`api/utils/ragMetrics.js`](api/utils/ragMetrics.js) |
| 5.3 | Кэшировать `analyzeIntent` и `fetchGraphContext` | Средний | 3 | Ожидает | **Зачем:** ускорить повторные запросы. **Что делаем:** кэш на сессию + LRU для фрагментов. | [`api/server/services/RAG/intentAnalyzer.js`](api/server/services/RAG/intentAnalyzer.js), [`api/server/services/agents/context/helpers.js`](api/server/services/agents/context/helpers.js) |
| 5.4 | Кэширование токенизации | Средний | 3 | Ожидает | **Зачем:** снизить стоимость токенизации. **Что делаем:** кэш токенов и инкрементальная токенизация. | [`api/server/services/tokens/TokenCounter.js`](api/server/services/tokens/TokenCounter.js) |

---

### Эпик 6: Оптимизация устойчивости
**Приоритет:** Высокий  
**Статус:** Ожидает  

| ID | Задача | Приоритет | Оценка (усл. ед.) | Статус | Описание (зачем/что делаем) | Ссылки |
|----|------|----------|------------------|--------|-----------------------------|--------|
| 6.1 | Создать единый AbortController на запрос | Высокий | 4 | Ожидает | **Зачем:** корректная отмена. **Что делаем:** общий `signal` для RAG/граф/очередей. | [`api/server/controllers/agents/request.js`](api/server/controllers/agents/request.js) |
| 6.2 | Реализовать adaptive retry strategy | Средний | 3 | Ожидает | **Зачем:** устойчивость к сбоям. **Что делаем:** backoff по типу ошибок и метрикам. | [`api/server/utils/resilience.js`](api/server/utils/resilience.js) |
| 6.3 | Сделать memory queue abort-safe | Средний | 2 | Ожидает | **Зачем:** не выполнять enqueue после отмены. **Что делаем:** `enqueueMemoryTasksSafe` учитывает `signal`. | [`api/server/services/RAG/memoryQueue.js`](api/server/services/RAG/memoryQueue.js) |
| 6.4 | Таймауты для внешних вызовов | Высокий | 2 | Ожидает | **Зачем:** избежать зависаний. **Что делаем:** таймауты для `fetchGraphContext`, `queueGateway` и т.д. | [`api/server/services/agents/context/helpers.js`](api/server/services/agents/context/helpers.js), [`api/server/services/agents/queue`](api/server/services/agents/queue) |
| 6.5 | Жёсткие лимиты контекста | Средний | 2 | Ожидает | **Зачем:** предотвратить переполнение памяти. **Что делаем:** лимиты `MAX_MESSAGES_TO_PROCESS/historyTokenBudget` + валидация при старте. | [`api/server/services/Config/ConfigService.js`](api/server/services/Config/ConfigService.js) |
| 6.6 | Адаптивное сжатие по необходимости | Средний | 3 | Ожидает | **Зачем:** не сжимать лишнее. **Что делаем:** применять `MessageCompressorBridge` только при превышении бюджетов. | [`api/server/services/agents/ContextCompressor.js`](api/server/services/agents/ContextCompressor.js) |

---

### Эпик 7: Observability
**Приоритет:** Средний  
**Статус:** Ожидает  

| ID | Задача | Приоритет | Оценка (усл. ед.) | Статус | Описание (зачем/что делаем) | Ссылки |
|----|------|----------|------------------|--------|-----------------------------|--------|
| 7.1 | Рефакторинг Token breakdown логики | Средний | 2 | Ожидает | **Зачем:** корректный учёт токенов. **Что делаем:** `emitPromptTokenBreakdown` обновляет `req.promptTokenBreakdown`, учитываем config toggle. | [`api/server/utils/tokenBreakdown.js`](api/server/utils/tokenBreakdown.js), [`api/server/services/agents/usage/agentUsageService.js`](api/server/services/agents/usage/agentUsageService.js) |
| 7.2 | Headless/non-headless log contracts | Средний | 2 | Ожидает | **Зачем:** единый формат логов. **Что делаем:** вводим `[agent.controller.<phase>]` и helper `logAgentEvent(phase, meta)`. | [`api/server/controllers/agents/request.js`](api/server/controllers/agents/request.js) |

---

### Эпик 8: Производительность и память
**Приоритет:** Средний  
**Статус:** Ожидает  

| ID | Задача | Приоритет | Оценка (усл. ед.) | Статус | Описание (зачем/что делаем) | Ссылки |
|----|------|----------|------------------|--------|-----------------------------|--------|
| 8.1 | Асинхронная индексация файлов | Средний | 3 | Ожидает | **Зачем:** не блокировать ответ. **Что делаем:** переносим `index_file` в фоновые задачи. | [`api/server/routes/files/index.js`](api/server/routes/files/index.js), [`api/server/services/Files/FileService.js`](api/server/services/Files/FileService.js) |
| 8.2 | Параллелить источники RAG | Средний | 3 | Ожидает | **Зачем:** ускорить сбор контекста. **Что делаем:** параллелим векторный поиск и графовый контекст. | [`api/server/services/RAG/RagContextBuilder.js`](api/server/services/RAG/RagContextBuilder.js) |
| 8.3 | Оптимизация использования памяти сообщений | Средний | 2 | Ожидает | **Зачем:** снизить расход памяти. **Что делаем:** исключаем дублирование `orderedMessages/ formattedMessages/ initialMessages`. | [`api/server/controllers/agents/client.js`](api/server/controllers/agents/client.js) |
| 8.4 | Стриминг больших вложений | Средний | 3 | Ожидает | **Зачем:** уменьшить пиковую память. **Что делаем:** стримим изображения/OCR-тексты вместо полной загрузки. | [`api/server/routes/files/index.js`](api/server/routes/files/index.js) |
| 8.5 | Улучшить обработку ошибок | Средний | 2 | Ожидает | **Зачем:** понятные ответы пользователю. **Что делаем:** возвращаем ясные ошибки вместо `ContentTypes.ERROR`. | [`api/server/utils/responseUtils.js`](api/server/utils/responseUtils.js) |
