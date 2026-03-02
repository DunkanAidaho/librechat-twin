# LibreChat RAG & Memory Improvement Plan

Эта дорожная карта включает **весь пул задач** по кастомному LibreChat — как уже выполненные, так и оставшиеся.
Для каждой задачи приведены детали «что сделать», «как нельзя делать», «как нужно делать», а также предпосылки или
возможные граничные условия.

---

## ✅ Выполненные задачи (для контроля и переиспользования подходов)

1. **Оптимизация sanitizeInput (fast-path + лимит массивов)**
   - Что сделано: добавлен быстрый путь для коротких ASCII-строк, ограничения при склейке массивов.
   - Как нельзя: возвращаться к JSON.stringify для коротких строк; добавлять тяжёлые операции в hot-path.
   - Как нужно: оставлять fast-path, контролировать лимиты, минимизировать аллокации.

2. **Temporal client: проверка subject и fallback**
   - Что сделано: при отсутствии темы NATS выполняется HTTP fallback с логированием.
   - Как нельзя: слепо обращаться к queueConfig.subjects без проверки.
   - Как нужно: перед publish валидировать конфиг, корректно логировать, фолбечить.

3. **NATS client: адаптивный backoff + auth fallbacks**
   - Что сделано: динамический backoff, корректная авторизация (user/pass или token).
   - Как нельзя: жёстко забить параметры в код, держать постоянный backoff.
   - Как нужно: использовать retryAsync с переменным множителем, логировать попытки.

4. **Memory config cache с TTL**
   - Что сделано: кеш секции memory/bin с тайм-аутом, refresh по требованию.
   - Как нельзя: хранить ссылку навсегда, заставлять перезапускать процесс для обновления.
   - Как нужно: использовать TTL и refreshCache().

5. **RAG logger и keep-alive агенты**
   - Что сделано: ragLogger для единых логов, httpAgents для axios keep-alive.
   - Как нельзя: логировать хаотично в разных форматах, открывать новые TCP на каждый запрос.
   - Как нужно: использовать ragLogger.* и httpAgents.getKeepAliveAgents().

6. **Очередь memoryStorageQueue для isMemoryStored**
   - Что сделано: батчевая установка флага через очередь + flush/retry логика.
   - Как нельзя: дергать updateMany на каждое сообщение.
   - Как нужно: enqueue(userId, messageIds, meta) и периодические flush’и.

7. **TTL-очистка для ingest dedupe ключей**
   - Что сделано: карта с expiresAt, автоочистка, LRU при избытке.
   - Как нельзя: хранить ключи бессрочно, отъедая память.
   - Как нужно: регистрировать через registerIngestMark, очищать sweepExpiredIngestMarks.

8. **Memory guard в Mongo**
   - Что сделано: ensureConversationMemoryFlags() проверяет флаги, догоняет пропущенные сообщения.
   - Как нельзя: полагаться на внешний RAG без проверки в Mongo.
   - Как нужно: брать список сообщений через Message.find, формировать add_turn, ставить флаг после enqueue.

9. **Этап 0 — Hotfix для prompt shrink / heavy history** *(✅ завершено 25.02.2026)*
   - Что сделано: полностью снята логика shrink в `MessageHistoryManager.processMessageHistory`, prompt всегда содержит исходные сообщения; `AgentClient.buildMessages` фильтрует устаревшие `[[moved_to_memory]]`; добавлен счётчик `rag_history_passthrough_total` c лейблами длины/лимита; intent-анализатор нормализует ack-сообщения и корректно извлекает текст из `content[]`; `memoryConfig` расширен параметрами `mode/liveWindow/waitForIngestMs` и реагирует на `HISTORY_TOKEN_BUDGET`.
   - Как нельзя: возвращать усечённый текст в prompt, смешивать shrink c ingest, скрывать heavy-сообщения без метрик.
   - Как нужно: сохранять полные сообщения до внедрения нового оркестратора, продолжать ingestion в память, мониторить `rag.history.prompt_passthrough` и логи `rag.history.memory_task_prepared`/`memoryQueue.start`.

---

## 🔜 Оставшиеся задачи (подробная декомпозиция)

### 0. Док-индекс и инвентаризация (docs/)
- **Что нужно сделать**
  - Собрать единый индекс по тематическим подпапкам `docs/` и проверить ссылки на TODO/project_map.
  - Убедиться, что основной план логирования — `docs/logging/transparent_logging.md`.
- **Как нельзя**
  - Оставлять дубликаты файлов без ссылки/редиректа в индексах.
- **Как нужно**
  - Любой перенос фиксировать в `docs/README.md`, `docs/TODO.md` и `docs/project_map`.

**Статус:** ✅ актуальная структура уже в `docs/architecture/`, `docs/logging/`, `docs/refactoring/`, `docs/event_service/`; дублей вне подпапок нет.

### 1. Transparent logging initiative (сквозное API-логирование)
- **Статус**
  - memoryQueue + temporalClient, scripts (manage_summaries/sync_history), routes/files (+ RAG подроуты) и response utils уже переведены на scoped логгеры и `buildContext`.
  - ✅ RAG core (`condense`, `multiStepOrchestrator`, `LongTextWorker`, `RagContextBuilder`, `RagCache`, `intentAnalyzer`) завершён, Map/Reduce логирует `rag.condense.*` и финальный `rag.condense.mr_finished`.
  - ✅ Маршруты SSE и response utils завершены.
  - ✅ LLM clients (`Anthropic`, `OpenAI`, `Google`, `BaseClient`) завершены.
- [x] RAG core: RagContextBuilder / RagCache / intentAnalyzer / multiStepOrchestrator / LongTextWorker / condense  
- [x] LLM clients: BaseClient / Anthropic / OpenAI / Google (после переноса обновить `docs/logging/transparent_logging.md` и чеклист)
- **Что нужно сделать**
  - Построить единый слой логирования для всех API-проходов (клиенты, контроллеры, сервисы, очереди, утилиты), чтобы каждая стадия запроса фиксировалась с единым форматом и requestId.
  - Использовать план из `docs/logging/transparent_logging.md`, дополненный конкретными областями из `docs/project_map`.
- **Декомпозиция**
  1. **Config & инфраструктура**
     - Расширить `logging` секцию `ConfigService`: глобальный уровень, формат (json/text), опции консольных цветов, файловый транспорт, feature-флаги (`tracePipeline`, `debugSse`, `tokenUsageReportMode`).
     - Обновить `.env` примеры и README с новыми переменными.
  2. **Библиотека логирования**
     - ✅ Реализован `api/utils/logger` (Winston + `createScopedLogger`, `sanitizePlainObject`).
     - Инкапсулировать существующий `branchLogger`, чтобы ветвевой транспорт просто подключал scoped логгер.
  3. **Request context & middleware**
     - В `server/routes/agents/chat.js` и других входных точках генерировать `requestId`, пробрасывать в `req.context`.
     - Обновить SSE/response utils (`server/utils/responseUtils.js`) для хранения `requestId`/`conversationId` в логах.
  4. **Инструментирование модулей (по project_map)**
     - **Клиенты LLM** (`app/clients/AnthropicClient.js`, `BaseClient.js`, `GoogleClient.js`, `OpenAIClient.js`, `app/clients/utils/instructions.js`): *в процессе* — стандартизовать события `request:start`, `stream:token`, `request:retry`, `request:error`.
     - **Контроллеры** (`server/controllers/agents/client.js`, `server/controllers/agents/request.js`, middleware, routes/files/*, response utils): *частично готово* — requestId middleware в `/agents`, `/files`, response utils обновлены.
     - **RAG / Memory сервисы** (`server/services/RAG/*`, `Graph/LongTextWorker`, `memoryQueue` и др.): *memoryQueue + temporalClient выполнены, Map/Reduce condense и MessageHistoryManager перенесены*, оставшиеся сервисы в миграции.
     - **Утилиты и очереди** (`utils/metrics.js`, `utils/ragMetrics.js`, `utils/memoryConfig.js`, `utils/natsClient.js`, `utils/async.js`, `manage_summaries.js`, `sync_history.js`, `server/routes/files/*`, `server/routes/convos.js`): *routes/files и core scripts обновлены*, остальные queued.
  5. **Форматы и соглашения**
     - Утвердить набор полей (`timestamp`, `level`, `scope`, `message`, `requestId`, `conversationId`, `userId`, `context`).
     - Для trace-режима писать вложенные объекты (например, токенайзер, RAG cache hits) в `meta`.
  6. **Документация и контроль качества**
     - Обновить `docs/logging/transparent_logging.md` по мере реализации (статус, примеры JSON/console).
     - Добавить раздел в `docs/project_map` о статусе логирования по файлам (готово/в работе).
     - План тестирования: smoke-тесты с `TRACE_PIPELINE=true`, прогон unit/интеграционных тестов, проверка того, что `DEBUG_SSE`/`tokenUsageReportMode` переключаются из ENV.
- **Как нельзя**
  - Смешивать новые логи и старый `debug` пакет, оставляя разрозненные форматы.
  - Добавлять тяжёлые синхронные операции в форматтер (нужен лёгкий JSON/printf).
- **Как нужно**
  - Использовать scoped loggers повсеместно, не хранить глобальное состояние вне Logger-модуля.
  - Для шумных путей (RAG trace) привязывать вывод к конфиг-флагам.

**Статус по документации:** основной план и примеры живут в [`docs/logging/transparent_logging.md`](docs/logging/transparent_logging.md).

### 1.1 SRP-разнос `client.js` (AgentClient)
- **Что нужно сделать**
  - Разнести `api/server/controllers/agents/client.js` по блокам utils/config/pricing/memory/prompt/tools/usage.
  - Увязать с существующими сервисами (`server/services/agents/*`, `server/services/pricing/*`, `server/services/RAG/*`).
- **Статус**
  - ✅ utils-хелперы вынесены: `normalizeInstructionsPayload` → `app/clients/utils/instructions.js`, `extractMessageText/normalizeMemoryText/makeIngestKey` → `server/utils/messageUtils.js`, `detectContextOverflow/compressMessagesForRetry` → `server/services/agents/utils.js`.
  - ✅ pricing/usage: `recordCollectedUsage` + `emitPromptTokenBreakdown` переключены на `server/services/agents/usage`, pricing config подключён в usage service.
- **Ссылки**
  - План: [`docs/refactoring/client_refactoring.md`](docs/refactoring/client_refactoring.md)

### 2. Multi-step RAG + Graph resilience (инцидент 18–20 фев 2026)
- **Статус**
  - Пользователь (инцидент `18–20.02.2026`) сообщил, что multi-step RAG+Graph перестаёт давать результат при больших объёмах контекста и через LongText-обёртки.
  - Наблюдаются таймауты и расхождения между LongTextWorker → RagContextBuilder → multiStepOrchestrator; неизвестно, отрабатывают ли fallback’и.
- **Что нужно сделать**
  - Расследовать корневые причины (pipeline, конфиг, инфраструктура), оформить отчёт для пользователя с вариантами решения и сроками.
  - Закалить multi-step RAG+Graph: выдерживать крупные контексты, комбинированные Graph+Vector ответы и LongText ingest без ручных манипуляций.
  - Добавить автоматические проверки (load/perf + regression) и оповещения, чтобы подобный регресс ловился до продакшена.
- **Декомпозиция**
  1. **Сбор фактов**: выгрузить логи/метрики за `18–20.02.2026`, собрать связанные conversationId, дедуп-ключи LongTextWorker, статус очередей.
  2. **Репликация**: поднять stand-alone сценарий (LongText ingestion → multi-step RAG) с тем же конфигом объемов; зафиксировать, где рвётся (memoryQueue, Graph fetch, summarize).
  3. **Аудит pipeline**: пройти цепочку `LongTextWorker → RagContextBuilder → multiStepOrchestrator → condenseContext`, выявить: а) зависания на cache-miss, б) неверные таймауты/бюджеты, в) конфликт настроек summarization vs. LongText.
  4. **Фиксы**: 
     - выровнять timeout/конкурентность между Graph и summarizer (динамический `timeoutMs`, budget-aware chunking),
     - добавить защиту от переполнения очередей (backpressure, дедуп),
     - обеспечить, что LongText-чанки помечаются и не ломают multi-step слои.
  5. **Варианты для пользователя**: подготовить две опции (быстрый workaround + полноценный патч), описать в отдельном ответе: когда включать degraded mode, когда повторно запускать multi-step.
  6. **Тесты и наблюдаемость**: автотест на large-context, нагрузочный прогон с LongText wrappers, алерты по таймаутам `multiStepRag`/`graph.enqueue`.
  7. **Документация**: обновить `docs/LongTextWorker.md`/`docs/RAG.md` (если необходимо) и чеклист `docs/coder_checklist.md` пунктом про multi-step.
- **Как нельзя**
  - «Подкручивать» таймауты локально без понимания причин, откладывая RCA.
  - Править LongTextWorker в обход дедуп/очередей или отключать multi-step без уведомления пользователя.
- **Как нужно**
  - Делать RCA с конкретными данными (requestId, conversationId, dedупKey).
  - Выкатывать фиксы под feature-flag/конфигом, сопровождать нагрузочным тестом и публичным постмортем.

#### План стабилизации multi-step RAG (v0 → v2)

**Этап 0 — Hotfix (текущий релиз)**
- Цель: убрать разрушающий prompt-shrink, пока не внедрён новый оркестратор.
- Действия:
  - сохраняем полные тексты сообщений в prompt, даже если они ушли в память;
  - оставляем ingest в память (RAG всё равно сможет найти текст);
  - логируем `rag.history.prompt_passthrough`, чтобы видеть, сколько сообщений потенциально «тяжёлые».
- Smoke-тест перед выкладкой:
  - загрузить LongText (>60k токенов) и убедиться, что ответ модели больше не содержит `[..., truncated ...]`;
  - по логам проверить, что ingestion остаётся активным (`rag.history.memory_task_prepared`, `memoryQueue.start`);
  - мониторить метрику `rag_history_passthrough_total` — значения должны инкрементироваться при тяжёлых сообщениях.
- Как нельзя: оставлять `[[moved_to_memory]]` в prompt; смешивать усечённые части и свежий контент.
- Как нужно: до вывода нового пайплайна просто передавать LLM полный текст, но следить за токенами (лог + метрики).

**Этап 1 — Живое окно и history-orchestrator** *(✅ завершено 25.02.2026)*
- Живое окно (N последних сообщений) держим целиком, вне зависимости от размеров.
- Остальную историю отправляем только в память (vector/graph). В prompt — либо ссылки (для отладки), либо ничего (если RAG гарантированно тянет контент).
- Добавляем конфиг `RAG_HISTORY_MODE=full|memory_ref|drop`.
  - full — legacy режим;
  - memory_ref — используем живое окно + память;
  - drop — агрессивное удаление (fallback для headless).
- **Проверка Stage 1**: включить `HISTORY_MODE=live_window`, `HISTORY_LIVEWINDOW_SIZE=12`, `HISTORY_WAIT_FOR_INGEST_MS=2000`; прогнать >20 смешанных сообщений (user/assistant, часть длинных). В логах ожидаем `rag.history.live_window_kept/dropped` и `history.live_window.applied`, gauge `rag_history_live_window_size` ≈ 12. В Prometheus следим за `rag_history_passthrough_total` + отсутствием `context.overflow`. Дропнутые сообщения должны попадать в логи `rag.history.drop_enqueue`.

**Этап 2 — Context orchestrator + стратегии**
- Вводим `RAG_STRATEGY=simple|multistep|cascade`.
  - simple — vector + graph без дополнительных проходов;
  - multistep — текущий каскад с intent → follow-up;
  - cascade — multi-step + condense + кэш.
- Кэш (`RAG_CACHE_ENABLED`) переключается независимо от стратегии.
- Оркестратор решает, какие кластеры из памяти попадают в prompt; placeholder не попадает напрямую к LLM.

**Этап 3 — Расширенные метрики/трейсинг**
- Для каждого этапа (`history_window`, `memory_ingest`, `rag_fetch`, `multi_step`, `prompt_build`) логируем `rag.pipeline.stage`.
- Добавляем gauge типа `rag_context_window_tokens`, `rag_history_passthrough_total`.
- `requestId`/`messageId` обязательны во всех новых логах.

**Best practices (для всех этапов)**
- История: последнее сообщение пользователя никогда не сжимается.
- Multi-step: любые срезы контента должны ссылаться на сохранённые кластеры, а не на произвольные `[...truncated...]`.
- Graph/vector: таймауты завязаны на объём запроса (`timeoutMs = base + contextLength/50`).
- Режимы управляются через ENV (не магические константы в коде).
- Для отладки: включаем `TRACE_PIPELINE`, проверяем pipeline-stage.

### 3. Size-aware RAG cache (Оптимизация #6)
- **Что нужно сделать**
  - Вести учёт «веса» записей (символы/токены) и ограничивать кэш не только TTL, но и суммарным бюджетом.
  - При добавлении записи проверять, не превышен ли лимит; если да — удалять самые «тяжёлые» или старые записи.
- **Как нельзя**
  - Удалять записи без учёта веса (просто по FIFO).
  - Игнорировать ситуацию, когда одна запись больше бюджета: нужно обрабатывать (например, не кэшировать её вовсе).
- **Как нужно**
  - Добавить конфиг `memory.ragCache.maxSizeTokens`/`maxSizeChars`.
  - Хранить в ragCache структуру `{sizeTokens, ...}` и вести текущую сумму.
  - Перед вставкой очищать пока сумма + новая запись > лимита, логировать эвикции.

### 4. Unified AbortController chain (Оптимизация #10)
- **Что нужно сделать**
  - Создать единый AbortController на запрос и пробрасывать его во все подпроцессы (RAG, граф, vector search, memory queue).
  - При отмене клиента все дочерние операции должны корректно завершаться.
- **Как нельзя**
  - Создавать отдельные контроллеры без связки (нельзя, чтобы память продолжала работать после отмены запроса).
- **Как нужно**
  - Реализовать helper `createLinkedAbortSignal(parentSignal, ...children)` или хранить один контроллер в req.context.
  - В `buildRagContext`, `enqueueMemoryTasksSafe`, `fetchGraphContext` и т.д. использовать общий signal.

### 5. Adaptive RAG retry strategy (Оптимизация #8)
- **Что нужно сделать**
  - В зависимости от типа ошибки/метрик RAG-пайплайна подстраивать задержки и количество повторов (например, для `429`).
  - Собирать простые метрики (ответ 503, таймауты) и усиливать backoff.
- **Как нельзя**
  - Лезть в `retryAsync` с жёстким delay; игнорировать типы ошибок.
- **Как нужно**
  - В `runWithResilience` расширить onRetry, передавая тип ошибки.
  - В RAG-запросах (graph, vector) анализировать статус: 5xx -> экспоненциальное увеличение задержки, 4xx -> быстрый отказ.

### 6. Дополнительная сверка Mongo ↔ pgvector (если доступно)
- **Что нужно сделать**
  - Если появится API в tools-gateway, до обращения к pgvector проверять соответствие `isMemoryStored`.
  - Например, дергать `/rag/status` с messageId, сверять список.
- **Как нельзя**
  - Предполагать, что pgvector всегда доступен (добавить guard).
- **Как нужно**
  - Обнаружив расхождение, запускать repair (похоже на memoryGuard).
  - При невозможности запроса фиксировать это в логах и не тормозить обработку.

### 7. Size-aware ragCache + TTL мониторинги
- **Что нужно сделать**
  - Добавить метрики Prometheus: текущий объём кэша, количество эвикций, доля хит/мисс.
  - Триггерить предупреждения при >80% загрузке.
- **Как нельзя**
  - Полагаться только на логи; без метрик сложно отлавливать деградацию.
- **Как нужно**
  - Обновить `observeCache` (или добавить новую метрику).
  - Завести счетчик `ragCacheEvictions{reason="size"}`.

### 8. Abort-safe memory queue (следствие из #10)
- **Что нужно сделать**
  - Все вызовы `enqueueMemoryTasksSafe` должны учитывать signal; при отмене не начинать новые попытки.
- **Как нельзя**
  - Стартовать enqueue даже если запрос уже отменён.
- **Как нужно**
  - Перед `runWithResilience` проверять `signal?.aborted`; в onRetry смотреть `signal`.
  - При отмене очищать pendingIngestMarks, чтобы не висели.

### 9. Рефакторинг Token Breakdown логики (повторная проверка)
- **Что нужно сделать**
  - `emitPromptTokenBreakdown` должен корректно обновлять `req.promptTokenBreakdown`.
  - Убедиться, что caching режимы не ломают подсчёт.
- **Как нельзя**
  - Логировать «unknown» conversationId (если есть возможность получить реальный id).
- **Как нужно**
  - Пробрасывать conversationId через req.
  - Если breakdown не нужен — отключать через конфиг.

### 10. Headless и non-headless: единые контракты логов
- **Что нужно сделать**
  - Привести логи в `AgentController` к единому формату `[agent.controller.<phase>]`.
  - Отдельно помечать headless-case.
- **Как нельзя**
  - Миксовать русский/английский текст логов в одной строке.
- **Как нужно**
  - Ввести helper `logAgentEvent(phase, meta)`.

---

## ℹ Общие рекомендации

- **Не удалять** уже реализованную батч-очередь `memoryStorageQueue` (использовать для всех новых фич).
- **Не смешивать** контрольные логи ragLogger с обычными logger.* — ragLogger только для RAG-процессов.
- **Не запускать** дорогостоящие операции (vector search) без проверки `req?.user?.id` и `conversationId`.
- **Предусмотреть** конфиги для всех новых лимитов / TTL (через ConfigService).
- **Документировать** каждую новую метрику или переменную окружения в README/ENV примерах.

## Как пользоваться чеклистом
1. Перед ревью сверяемся с соответствующими разделами (минимум разделы 1–5 + профильные модули).
2. Фиксируем замечания с указанием нарушенного пункта (например, `§3 Логирование` + файл/строка).
3. После исправлений обновляем статус задач в `docs/TODO.md` и, при необходимости, `docs/project_map`.

Чеклист является обязательной точкой входа при планировании фич и код-ревью для LibreChat Twin.
