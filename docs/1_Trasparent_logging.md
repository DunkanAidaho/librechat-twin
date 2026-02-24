Ниже предлагаю план внедрения единого многоуровневого логирования:

**1. Цели, критерии успеха и ограничения**
- **Цель:** ввести централизованный слой логирования для всех серверных модулей (клиенты LLM, контроллеры, сервисы, worker’ы), обеспечив единый формат и уровни (`error/warn/info/debug/trace` + опциональные доменные теги), с конфигурацией через `ConfigService`.
- **Deliverables:**
  1. Новый модуль логирования (например `api/utils/logger/index.js`) на базе Winston или pino с:
     - настройкой уровней и транспортых каналов (консоль + опционально файл/JSON);
     - функцией `createScopedLogger(scope, options)` для включения доменных тегов;
     - поддержкой динамических флагов (`tracePipeline`, `debugSse`, `tokenUsageReportMode`).
  2. Расширение `ConfigService` (`logging` секция) новыми параметрами: глобальный уровень, формат вывода (json/text), включение файлового транспорта, опции трассировки.
  3. Обновление существующих модулей (начать с ключевых: `server/controllers/agents/*`, `app/clients/*`, `server/services/RAG/*`, `utils/metrics`, `memoryQueue`, `branchLogger` и т.д.), чтобы они использовали новый API и единый стиль сообщений.
  4. Документация (`README`/`project_map`/`docs/logging.md`) с описанием уровней, переменных окружения и правил добавления новых логов.
- **Критерии успеха:**
  - все основные узлы создают scoped-логгер через новый модуль;
  - уровни управляются через ENV, включение trace/debug не требует правок кода;
  - лог-сообщения содержат единый формат (timestamp, scope, level, message, context JSON);
  - ветвевой логгер (`branchLogger`) переиспользует этот слой, нет дублирования конфигурации;
  - регрессионных изменений в функционале нет (тесты/линтеры проходят).
- **Ограничения:** сохраняем совместимость с существующими ENV переменными (например `ENABLE_BRANCH_LOGGING`, `BRANCH_LOG_LEVEL`, `TRACE_PIPELINE`). Логи не должны перегружать stdout при прод-настройках; опционально поддержать файл/JSON transport, но дефолт остаётся консоль.
  - Критически важно соблюдать оптимизацию из `docs/TODO.md` (п.1 «sanitizeInput fast-path»):
    - любой пользовательский ввод перед логированием проходит через текущий `sanitizeInput` fast-path;
    - запрещено возвращаться к тяжёлым `JSON.stringify`/доп. аллокациям в hot-path (sanitizeInput, обработчики сообщений);
    - `meta` в логах может содержать только лёгкие копии/обрезки строк (без повторной нормализации).

### 1.1 Операционные требования при переносе модулей логирования
- **Чистое рабочее дерево:** перед переносом/переименованием логгеров выполняем `git status --short` и удаляем устаревшие файлы (`logger.js`, резервные копии). Если файлы были вынесены в подпапки, убедиться, что корень не содержит теневых дублей.
- **Нулевая кэшированность сборки:** следующий запуск контейнера выполняем через `docker build --no-cache` (или эквивалентный шаг CI), чтобы гарантировать отсутствие «прилипших» модулей из предыдущих слоёв.
- **Локальные линтеры/трансформации:** после удаления старых файлов прогоняем статические проверки (`npm run lint`, `eslint .`) без запуска прод-приложения. Ошибки типа `Cannot find module '~/utils/logger'` должны отлавливаться на этом этапе.
- **Документация:** каждое перемещение или консолидация логгера фиксируется в `docs/project_map` и `docs/coder_checklist.md`, чтобы команда знала, какие файлы необходимо удалять при cherry-pick/pull.

**2. Таблица прогресса (обновляется по мере миграции)**

| Модуль / область                     | Статус   | Комментарии |
|-------------------------------------|----------|-------------|
| Routes / middleware (`routes/agents`, `routes/files`) | ✅ Готово | requestId middleware + `buildContext`; `controllers/agents/request` переведён на scoped логгер `routes.agents.request` |
| Memory queue & Temporal client      | ✅ Готово | `rag.memoryQueue`, `utils.temporalClient` на scoped логгере |
| Response utils / SSE                | ✅ Готово | `safeWrite/safeEnd` через `buildContext` |
| RAG core (`condense`, `multiStep`, `LongTextWorker`, `RagContextBuilder`, `RagCache`, `intentAnalyzer`) | ✅ Готово | все сервисы используют scoped логгеры и `buildContext`; `rag.condense.*` покрывает Map/Reduce и итоговый `rag.condense.mr_finished` |
| Message history (MessageHistoryManager, trimmers) | ✅ Готово | scoped логгер `rag.history.*`, buildContext({ conversationId, userId }), события drop/prompt/context_layers/enqueue |
| LLM clients (`Anthropic`, `OpenAI`, `Google`, `BaseClient`) | ⏳ В работе | BaseClient + OpenAI обновлены, Anthropic/Google в прогрессе |
| Скрипты (`manage_summaries`, `sync_history`) | ✅ Готово | scoped логгеры и контекст |
| Документация                        | ⏳ В работе | Таблица прогресса, чеклист, TODO |

| RagContextBuilder                  | ✅ Готово | `rag.context.*` события + кэш контекст |
| RagCache                           | ✅ Готово | `rag.cache.*` события с контекстом |
| multiStep orchestrator             | ✅ Готово | `rag.multiStep.*` события с entity/pass |
| LongTextWorker                     | ✅ Готово | `rag.longText.*` события по chunk-ам |
| IntentAnalyzer                     | ✅ Готово | `rag.intent.*` события с duration |

**3. Примеры логов**

- JSON формат (`routes.files`):
  ```json
  {"timestamp":"2026-02-23T18:06:00.123Z","level":"debug","scope":"routes.files","message":"routes.files.request","context":{"requestId":"a12b","userId":"42","path":"/images","method":"POST"}}
  ```

- Текстовый формат (`rag.memoryQueue`):
  ```
  2026-02-23T18:06:02.456Z [rag.memoryQueue] info: memoryQueue.summary {"context":{"requestId":"a12b","conversationId":"conv-123"},"status":"queued","totalTasks":5,"enqueued":5,"errors":0}
  ```

- JSON формат (`rag.multiStep`):
  ```json
  {"timestamp":"2026-02-23T18:10:00.456Z","level":"info","scope":"rag.multiStep","message":"rag.multiStep.pass_start","context":{"conversationId":"conv-42","requestId":"req-99","userId":"user-7"},"passIndex":1,"entities":["Alpha","Beta"]}
  ```

- JSON формат (`rag.condense.chunk_start`):
  ```json
  {"timestamp":"2026-02-24T10:10:00.000Z","level":"info","scope":"rag.condense","message":"rag.condense.chunk_start","context":{"conversationId":"conv-1","userId":"user-2"},"chunkIndex":2,"chunkTotal":5,"chunkLength":14250}
  ```

- JSON формат (`rag.condense.mr_finished`):
  ```json
  {"timestamp":"2026-02-24T10:10:05.000Z","level":"info","scope":"rag.condense","message":"rag.condense.mr_finished","context":{"conversationId":"conv-1","userId":"user-2"},"finalLength":5800,"provider":"openrouter:llama-3.1","durationMs":4523}
  ```

- JSON формат (`rag.history.prompt_shrink`):
  ```json
  {"timestamp":"2026-02-24T10:12:00.000Z","level":"info","scope":"rag.history","message":"rag.history.prompt_shrink","context":{"conversationId":"conv-1","userId":"user-2"},"index":3,"role":"assistant","len":18000,"reason":"length","limitLabel":"ASSIST_LONG_TO_RAG","limitValue":15000,"snippetLen":1500}
  ```

- Текстовый формат (`rag.longTextWorker`):
  ```
  2026-02-23T18:12:00.789Z [rag.longTextWorker] info: rag.longText.chunk_start {"context":{"conversationId":"conv-42","requestId":"dedupe-123","userId":"user-7"},"chunkCount":3,"messageId":"msg-1"}
  ```


