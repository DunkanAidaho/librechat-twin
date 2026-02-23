# Чеклист разработчика LibreChat Twin

Документ фиксирует единые критерии ревью кода для форка LibreChat на Node.js/Express + React. Он учитывает текущие инициативы из `docs/project_map`, `docs/TODO.md`, `docs/1_Trasparent_logging.md` и используется на всех этапах разработки.

## 1. Архитектура и разделение слоёв
- **SRP и границы модулей**: каждый модуль делает одну вещь. Контроллеры (`server/controllers/agents/*.js`) не содержат бизнес-логики — она должна быть в `server/services/**` или `utils/**`.
- **Ports & Adapters**: бизнес-логика не обращается напрямую к Express/DB API. Используем сервисные слои (`RAG`, `agents`, `ConfigService`).
- **Dependency Injection**: не подтягиваем глобальные singletons кроме конфигов/логгера. Передаём зависимости как параметры (request context, scoped logger, signals).
- **Контракты backend**: файлы в `api/` — read-only относительно Git-патчей снапшота LibreChat (перепроверяем перед коммитом).
- **Согласованность с документацией**: изменения в сложных модулях дублируем в `docs/TODO.md` или профильных README.

## 2. Конфигурация и окружение
- **ConfigService как единственный источник**: новые переменные добавляем в `server/services/Config/ConfigService.js`, `.env.example` и README. Не читаем `process.env` напрямую в коде.
- **Feature flags**: используем `ConfigService.logging`, `memory`, `rag` секции вместо временных констант.
- **Secrets**: ключи LLM/NATS/Temporal — только через `.env`/секреты; никакого хардкода.
- **Валидация**: любые числовые/булевы параметры — через `parseOptionalInt/Bool/Float` или `zod`-схемы ConfigService.

-## 3. Логирование и наблюдаемость
- **Transparent logging initiative**: только scoped логгер (`utils/logger`) или `ragLogger` для RAG. Никаких `debug`, `console.log`, `warn` напрямую.
- **logContext helper**: перед любым логом вызывать `buildLogContext(reqOrMeta, extra)` из `~/utils/logContext.js`, чтобы добавить `requestId/conversationId/userId`. Изменения по логам обязательно фиксируем в документации (`docs/1_Transparent_logging.md`, `docs/TODO.md`).
- **Гигиена репозитория:** при переносе/переименовании логгеров удаляем старые файлы (`logger.js`, `.bak`, временные копии) и проверяем `git status`. Перед сборкой контейнера запускаем `docker build --no-cache` (или аналогичный шаг CI), чтобы исключить подтягивание устаревших артефактов.
- **Request context**: контроллеры обязаны создавать `requestId` и передавать его дальше (в SSE, RAG, очереди). Логи без `requestId` считаются долгом.
- **Единый формат событий**: `scope`, `phase`, `conversationId`, `userId`, `agentId`, `latency`, `model`, `attempt`, `signalAborted` и т.п. — по списку из `docs/1_Trasparent_logging.md`.
- **Структурные meta-поля**: `context` и другие объекты проходят через `sanitizePlainObject` (с лимитами глубины/размера и защитой от циклов). Нельзя применять `JSON.stringify` в hot-path или превращать объекты в строки — передаём лёгкую, но структурированную версию.
- **Метрики Prometheus**: новые сервисы/очереди регистрируют метрики через `utils/metrics.js`/`utils/ragMetrics.js` (гейджи ragCache, счётчики эвикций, latency).
- **Отладочные флаги**: verbose-трейсы (token usage, SSE, RAG) завязываем на ENV (`TRACE_PIPELINE`, `DEBUG_SSE`, `tokenUsageReportMode`).

## 4. RAG и память
- **Контекстный пайплайн**: изменения в `server/services/RAG/**`, `Graph/LongTextWorker`, `memoryQueue` должны сохранять контракт (enqueue -> metrics -> logging). Любые новые шаги документируем в `docs/TODO.md`.
- **Size-aware ragCache**: следим за лимитами по токенам/символам, логируем эвикции и обновляем метрики.
- **Abort-safe цепочка**: `AbortController`/`signal` пробрасываем во все операции (RAG, memory queue, vector search). Нет сигнала — блок считаем уязвимостью (#10 плана).
- **Retry стратегия**: используем `runWithResilience` и `utils/async.retryAsync`, учитываем типы ошибок (429/5xx). Жёстких тайм-аутов без backoff не оставляем.
- **Memory queue**: операции `enqueueMemoryTasks*` и `memoryStorageQueue` не должны запускаться после отмены запроса; flush/locks проверяем по сигналу.

## 5. Безопасность
- **sanitizeInput**: используем актуальную версию (fast-path, лимиты массивов). Никаких ручных `replace(/</g, ...)`.
- **Авторизация**: проверяем `persisted_user`, роли и ACL перед доступом к агентам/конверам. Роуты обязаны использовать middleware (`server/routes/agents/chat.js`, `server/routes/files/**`).
- **Секреты и токены**: запрещены в коммитах; для тестов — mock окружение.
- **Валидация ввода**: все внешние payload’ы проходят через `requestValidators`, `zod`-схемы или строгие проверки типов.
- **Rate limiting / защита от перебора**: для критических операций (файлы, ingest, агентские действия) проверяем наличие лимитов или добавляем TODO в чеклист.

## 6. Качество кода
- **Функции < 70 строк**: разбиваем большие пайплайны на шаги. Например, в `server/controllers/agents/request.js` используем приватные helpers.
- **Названия**: никаких `data1/temp`. Используем осмысленные имена (`enqueueMemoryTasksSafe`, `createScopedLogger`).
- **Error handling**: ловим конкретные ошибки (`axios.AxiosError`, `TemporalConnectionError`). Общий `catch (e)` допустим только для финального guard’а.
- **Повторное использование**: перед добавлением новой утилиты ищем аналоги (`utils/async`, `utils/security`, `server/utils/messageUtils`).
- **Логгирование вместо print**: любые заметки в коде должны идти через логгер с уровнем `debug/info/warn/error`.

## 7. Тестируемость и документация
- **Тесты**: новая логика → unit или интеграционные тесты (при необходимости mock NATS/Redis). Скрипты (`manage_summaries.js`, `sync_history.js`) тестируем минимум smoke-тестом.
- **Документация**: сложные участки описываем в docstring/комментариях «почему», а не «что». Новый флоу — апдейт `docs/TODO.md`.
- **Чистые TODO**: если оставляем TODO/FIXME — указываем ссылку на issue/план и дату.

## 8. Производительность и устойчивость
- **Async/await**: избегаем блокирующих вызовов внутри `async` (например, `fs.readFileSync` в hot-path).
- **Таймауты и cancellation**: HTTP/LLM/NATS вызовы идут только через `withTimeout`/`AbortSignal`.
- **Backpressure**: очереди (`memoryQueue`, `ingestDeduplicator`) отслеживают лимиты и при переполнении логируют + деградируют безопасно.
- **Resilience**: используем `runWithResilience` + `retryAsync`. Никаких ручных `setTimeout`-ретраев.
- **HTTP keep-alive**: клиенты LLM обязаны использовать `httpAgents.getKeepAliveAgents()`.

## 9. Клиент (React) и UX
- **Архитектура**: компоненты используют существующие hooks/utils (например, `client/src/utils/getThemeFromEnv`). Минимизируем дублирование логики состояния.
- **Типизация**: хотя проект на JS, новые сложные компоненты документируем JSDoc/PropTypes. Рассматриваем TS при добавлении новых модулей в `packages/client`.
- **UX & доступность**: пользователь получает явную обратную связь (загрузка, ошибка, успех). Тексты понятны, без служебных ID. Проверяем фокус/клавиатурную навигацию.
- **API-контракты**: фронтенд не должен предполагать не документированные поля сервера. Все новые поля — через контракт в `client/src/types` или shared-схемы.

## 10. DevOps, скрипты и поддерживаемость
- **Скрипты (`manage_summaries.js`, `sync_history.js`, `telegraph_poster/`)**: не должны вызывать Mongo/NATS без try/catch и без scoped логгера. Конфигурация только через `.env`.
- **Deployment**: проверяем, что новые ENV задокументированы и имеют дефолты. Не ломаем `docker-compose`/Helm значения.
- **Наблюдаемость**: при добавлении новых сервисов подключаем метрики и healthchecks.
- **Обучение команды**: нетривиальные архитектурные решения фиксируем в `docs/` (например, «как работает multiStepOrchestrator»).

## Как пользоваться чеклистом
1. Перед ревью сверяемся с соответствующими разделами (минимум разделы 1–5 + профильные модули).
2. Фиксируем замечания с указанием нарушенного пункта (например, `§3 Логирование` + файл/строка).
3. После исправлений обновляем статус задач в `docs/TODO.md` и, при необходимости, `docs/project_map`.

Чеклист является обязательной точкой входа при планировании фич и код-ревью для LibreChat Twin.