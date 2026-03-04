# F-2 — Управление контекстом и релевантный отбор (подробная декомпозиция)

## 0. Назначение документа

Этот документ — подробный, независимый от контекста чата гайд по реализации F‑2. Его цель: обеспечить устойчивый и объяснимый **отбор релевантного контекста**, избежать «снежного кома» и исключить пост‑фактум обрезки через `context.overflow.retry`. Документ предназначен для сохранения знаний, даже если история чата утеряна.

**Ключевая идея:** мы **не сужаем трубу**, а **фильтруем содержимое**. Лимит модели — это физический потолок, а система должна разумно распределять бюджет между instructions, history, RAG и прочими компонентами, **учитывая конкретную модель** (например, gpt‑5.2=400k, gemini‑pro=1M).

**Выполнено ранее (артефакты, чтобы не начинать заново):**
- Лимит NATS payload и HTTP fallback при превышении размера (логирование старта/окончания fallback).
- Дросселирование condense: уменьшены chunk/budget для стабилизации провайдера.
- Подняты лимиты long‑text pipeline (MAX_TEXT_SIZE/MAX_USER_MSG_TO_MODEL_CHARS/LONG_TEXT_MAX_CHARS до 1_200_000).
- Реординг RAG pipeline: multi‑step → RAG → condense, исключение последнего user из раннего condense.
- Улучшен intent analyzer (fallback на lowercase‑tokens при отсутствии сущностей).
- Диагностические логи prompt tail и таймаутов memory queue.
- Настройки memory queue: batch size/timeout увеличены для устойчивости.

## 1. Термины и словарь

**Model limit** — максимальный контекст модели, объявленный провайдером.

**Safe budget** — модельный лимит * (1 − headroom), где headroom 5–10% на вариативность токенизации, метаданные, промпт‑обвязку.

**Shares** — доли бюджета, выделяемые на:
- Instructions (system + agent instructions),
- History (живое окно + summary),
- RAG (graph + vector),
- Tool context / metadata.

**Live window** — последние N сообщений (обычно N пар user/assistant) с максимальным приоритетом.

**Summary window** — краткие summaries старых сообщений, поддерживающие «память» без сырого текста.

**Ingested content** — текст, проиндексированный в память/векторную БД/graph и доступный через RAG.

**Rerank** — пересортировка кандидатов RAG по релевантности запросу.

**Overflow‑retry** — fallback механика, которая срабатывает **после** ошибки 400 от модели и сжимает контекст пост‑фактум. Использовать как редкий safety net, не как норму.

**Chunk** — порция текста, индексируемая в векторном поиске.

**Entity** — сущность, извлечённая из запроса (NER или эвристики), которая используется как семантический ключ поиска.

**Graph context** — данные из графа знаний, связанные с сущностями запроса.

**Vector context** — результаты векторного поиска по релевантным фрагментам.

**Condense** — компрессия уже отобранного контекста при превышении бюджетов.

## 2. Границы ответственности

### 2.1 PromptBudgetManager
Отвечает за:
- вычисление `modelLimit`,
- расчёт `safeBudget`,
- распределение shares,
- публикацию бюджета в логах.

### 2.2 AgentClient.buildMessages
Отвечает за:
- сбор messages,
- применение history‑filter,
- применение RAG,
- финальный budget‑контроль до LLM.

### 2.3 HistoryTrimmer / MessageHistoryManager
Отвечают за:
- live window,
- summary,
- маркеры ingest,
- исключение дублей.

### 2.4 RagContextBuilder / multiStepOrchestrator
Отвечают за:
- поиск релевантного контекста,
- суммирование при превышении share,
- контроль размера graph/vector.

### 2.5 Логирование
Нужно обеспечить traceability:
- per‑model budgets,
- итоговые токены в каждой части,
- overflow‑retry usage,
- источники контекста (history vs RAG),
- причины отбора/отбраковки.

## 3. Главная цель: от «кома» к фильтрации

**Нынешняя проблема:**
Даже короткий запрос тянет гигантский хвост истории + RAG + instructions, что приводит к overflow. После overflow срабатывает пост‑фактум компрессия, откуда появляются «обрывки», из‑за чего модель сообщает «сообщение обрезалось».

**Цель F‑2:**
1. До LLM строго гарантировать, что prompt попадает в budget.
2. Считать токены и распределять share per‑model.
3. Внутри каждой части (history / RAG) применять **фильтрацию**, а не механическое обрезание.

## 4. Декомпозиция задач

### 4.1 Пер‑model budgets

**Требование:** бюджет должен зависеть от модели, а не глобально от 400k.

**Сделать:**
- Добавить конфиг per‑model budget (пример ниже).
- В PromptBudgetManager вычислять safeBudget = min(modelLimit, override) * (1 − headroom).
- Добавить shares (instructions/history/RAG). Default shares можно хранить в config, но учитывать per‑model overrides.
- Добавить валидацию: сумма shares не превышает 1.0, minimum для instructions/history не меньше заданного порога.

**Пример конфига:**

```
models:
  "openai/gpt-5.2":
    maxContextTokens: 400000
    promptMaxContextPercent: 0.92
    historyShare: 0.35
    ragShare: 0.25
    instructionsShare: 0.15
  "google/gemini-3-pro":
    maxContextTokens: 1000000
    promptMaxContextPercent: 0.92
    historyShare: 0.30
    ragShare: 0.30
    instructionsShare: 0.10
```

**Нельзя:**
- Жёсткий лимит 400k для всех моделей.
- Подмена modelLimit «по умолчанию», если конфиг модели известен.
- Игнорировать ограничения провайдера, которые могут быть ниже заявленных.

**Best practice:**
- Для каждой модели логировать: `modelLimit`, `safeBudget`, `shares`.
- Отображать эти значения в диагностике, чтобы не скрывать перерасходы.
- Хранить значения в ConfigService, не зашивать в код.

### 4.2 History фильтрация

**Цель:** избежать тащения сырой длинной истории.

**Сделать:**
- Чётко определить live window (например, 10–12 последних сообщений или 5–6 пар).
- Старые сообщения → summary через `MessageCompressorBridge` или отдельный summarizer.
- Огромные сообщения (> N chars) → **не включать** в prompt. Только summary + ссылка (ingest).
- Удалять старые raw‑сообщения, если их summary уже есть.
- Вводить «priority» для системных сообщений, чтобы важные инструкции не выпадали.

**Нельзя:**
- Держать в prompt старые raw‑документы после того, как они ingest‑нуты.
- Оставлять live window без лимитов и без учета бюджета.

**Best practice:**
- Поддерживать «summary‑слот», где суммируется весь старый хвост истории.
- При резком росте historyTokens — снижать размер live window, а не включать всё подряд.
- Устанавливать отдельный лимит на один message, чтобы один гигант не вытеснил всё.

### 4.3 RAG как фильтр

**Цель:** RAG должен приносить релевантное, а не «всё подряд».

**Сделать:**
- Ограничить graph/vector по share per‑model.
- **Иерархический RAG:**
  - vector поиск → top‑chunks,
  - entity extraction по top‑chunks,
  - graph fetch только по критичным сущностям,
  - condense по budget при необходимости.
- Использовать rerank и entity‑based selection:
  - если нет сущностей → минимальный контекст,
  - если сущности есть → top‑k per entity.
- Если RAG превышает share → condense/summary с бюджетом, зависящим от лимита модели.
- Устанавливать per‑source quotas: graphTokens и vectorTokens отдельно.
- Ввести правила ранжирования сущностей/узлов графа: близость к запросу, частота в vector hits, свежесть по метаданным (дата), веса по типу источника.

**Нельзя:**
- Включать все chunks, даже если rerank показал низкую релевантность.
- Держать одинаковый top‑k для всех моделей без учета контекста.

**Best practice:**
- В логах фиксировать: сколько chunks вошло, сколько отброшено, суммарные токены.
- Хранить «explain» в metadata: почему выбран конкретный chunk.

### 4.4 Исключение дублей

**Цель:** исключить «raw + RAG» дубль.

**Сделать:**
- Если сообщение ingest‑нуто, оно не может повторно попасть в prompt в raw виде.
- В prompt только summary + ссылки.
- Для ingest‑контента хранить флаг `isIngested` или `hasRagRef`.

**Нельзя:**
- Держать raw content и RAG chunks одновременно.
- Включать summary и raw без ясных причин.

### 4.5 Budget‑контроль до LLM

**Цель:** overflow‑retry должен быть редким исключением.

**Сделать:**
- До отправки LLM вычислять totalTokens.
- Если превышено → урезать history/RAG по share.
- Триггер overflow‑retry только если неожиданная ошибка или обновление модели.
- Поддерживать «emergency shrink» с жесткими правилами (например, drop старых summaries, а не свежих user сообщений).

**Нельзя:**
- Использовать overflow‑retry как основной механизм.
- Применять random‑drop без логики.

### 4.6 Инструкции

**Цель:** system prompt не должен провоцировать модель сообщать «обрезано» при summary.

**Сделать:**
- Уточнить инструкции: «контекст может быть суммаризован, сообщай об этом нейтрально».
- Отдельные инструкции для summary‑режима и для полного контекста.

**Нельзя:**
- Инструкция «если видишь обрывки — попроси продолжение» для summary‑контекста.

## 5. Подробные best practices

### 5.1 Token accounting
Использовать `Tokenizer.getTokenCount` с правильным encoding для модели. Никаких char‑length как основного.

### 5.2 Логирование (без метрик)
Логировать per‑request:
- instructionsTokens
- historyTokens
- ragTokens
- totalTokens
- shares / headroom
- chunkCount, entityCount, rerankScore.

### 5.3 Consistency
Данные про budget должны быть одинаковыми между `PromptBudgetManager` и `AgentClient` (не дублировать расчёты).

### 5.4 Минимальные значения
Всегда оставлять минимум:
- 1 user‑сообщение полностью,
- минимум 1 summary,
- минимум 1 RAG chunk для сущности (если есть).

### 5.5 Не «магия», а явные правила
Каждый шаг budget‑контроля должен быть детерминирован.

### 5.6 Проверка на регрессии
Добавлять регрессионные тесты, которые воспроизводят короткий запрос после длинного контекста.

## 6. Анти‑паттерны

1. **Широкий prompt без фильтрации**
   - «Тащим всё» и надеемся на модель.
2. **Слепой overflow‑retry**
   - После 400 режем историю случайно.
3. **RAG без rerank**
   - Всё векторное выдаётся в prompt.
4. **Дублирование ingest**
   - РAG + raw документ одновременно.
5. **Фиксированный лимит для всех моделей**
   - Игнорирование 1M у Gemini или 200k у других.
6. **Слишком большой headroom**
   - Потеря полезного пространства без необходимости.

## 7. Пример workflow

1. Пользователь отправляет короткий запрос.
2. `PromptBudgetManager` определяет modelLimit=400k, safeBudget=368k.
3. Shares: instructions=15%, history=35%, RAG=25%.
4. История: live window 6 пар, старое summary 1 блок.
5. RAG: из сущностей берутся 3 chunk per entity, rerank.
6. TotalTokens < safeBudget → отправка.
7. Overflow‑retry не активируется.

## 8. Контроль качества (QA)

**Сценарий 1:** короткий запрос после длинного контекста
- ожидаем: только live window + summary, без full raw.

**Сценарий 2:** модель с лимитом 1M
- ожидаем: больше RAG и history, но не «всё подряд».

**Сценарий 3:** RAG с десятками сущностей
- ожидаем: top‑k per entity, rerank, summary при overflow.

**Сценарий 4:** массивные исторические документы
- ожидаем: summary + RAG, raw текст остаётся вне prompt.

**Сценарий 5:** много разных моделей
- ожидаем: budgets отличаются per model.

## 9. Диагностический чеклист

- [ ] Логи показывают modelLimit и safeBudget.
- [ ] historyTokens и ragTokens входят в shares.
- [ ] overflow‑retry < 1% запросов.
- [ ] Дубликатов raw+RAG нет.
- [ ] Per‑model budgets фактически отличаются.

## 10. Приложение: дополнительные пояснения

### 10.1 Почему «снежный ком» происходит
Потому что pipeline не фильтрует history и RAG, и каждый новый запрос включает всю историю + все RAG блоки. С ростом истории растёт и контекст, пока не упирается в лимит модели.

### 10.2 Почему важен per‑model budget
У моделей разные лимиты. Если резать всех под 400k — мы теряем преимущества 1M моделей. Если не резать вообще — переполняем 400k модели.

### 10.3 Почему нельзя оставлять overflow‑retry как норму
Потому что сжатие post‑factum приводит к обрывкам, и модель честно пишет «обрезано». Это снижает доверие и качество.

### 10.4 Почему нужен rerank
Без rerank в prompt попадёт «околопохожий» контент, что снижает релевантность ответа.

## 11. Расширенная декомпозиция по компонентам

### 11.1 PromptBudgetManager

**Входы:** model, config, request metadata.

**Выходы:** safeBudget, shares.

**Псевдокод:**

```
modelLimit = resolveModelLimit(model)
override = config.prompt.overrideLimit
safeBudget = min(modelLimit, override || modelLimit) * (1 - headroom)
shares = resolveShares(model, config)
return { safeBudget, shares }
```

**Проверки:**
- shares sum <= 1.0
- instructionsShare >= min

### 11.2 HistoryTrimmer / MessageHistoryManager

**Задача:** отдать historyTokens <= historyShare * safeBudget.

**Псевдокод:**

```
liveWindow = takeLastN(messages, N)
summaries = summarize(oldMessages)
if liveWindowTokens + summaryTokens > historyBudget:
   reduce liveWindow
   further compress summaries
```

**Проверки:**
- последний user‑message сохраняется полностью.

### 11.3 RagContextBuilder

**Задача:** обеспечить ragTokens <= ragShare * safeBudget.

**Псевдокод:**

```
entities = analyzeIntent()
candidates = vectorSearch(entities)
reranked = rerank(candidates)
topK = selectTopKPerEntity(reranked)
if tokens(topK) > ragBudget:
   condensed = condense(topK)
```

### 11.4 AgentClient.buildMessages

**Задача:** объединить всё и гарантировать totalTokens <= safeBudget.

**Псевдокод:**

```
budget = PromptBudgetManager.get()
history = buildHistory(budget.historyShare)
rag = buildRag(budget.ragShare)
instructions = buildInstructions()
total = tokens(instructions) + tokens(history) + tokens(rag)
if total > budget.safeBudget:
   reduce history and rag
```

## 12. Раздел «как делать нельзя» (с примерами)

**Плохой подход:**
```
messages = fullHistory
rag = fullRag
prompt = instructions + messages + rag
```

**Хороший подход:**
```
messages = liveWindow + summary
rag = topK + condensedIfNeeded
prompt = instructions + messages + rag
```

## 13. Дополнительные советы

### 13.1 Обновление инструкций
Инструкции не должны вводить в заблуждение при summary.

### 13.2 Унификация логов
Логи должны быть едиными по структуре.

### 13.3 Документация
Все изменения в budget‑контроле фиксировать в docs/README.md и docs/logging/transparent_logging.md.

## 14. Объём и полнота

Этот документ должен быть достаточен для передачи задачи другому разработчику без контекста чата.

## 15. Шаблоны для задач (copy/paste)

**Task template:**

```
Задача: Implement per-model budget in PromptBudgetManager
Цель: compute safeBudget per model
Шаги:
- add config schema
- implement budget resolver
- log budgets
Проверка:
- logs show correct budgets
```

## 16. Дополнительная детализация (расширение)

### 16.1 Принципы распределения share

Рекомендуемые пропорции (пример):
- Instructions: 10–20%
- History: 30–40%
- RAG: 20–35%
- Tools: 5–10%

### 16.2 Условия для summary

Summary должен срабатывать, если:
- historyTokens > historyBudget
- message.length > largeMessageThreshold

### 16.3 Large messages

Гигантский блок текста должен:
- ingest‑нуться в memory
- получить summary 1–2k tokens
- быть исключён из prompt

### 16.4 RAG condense

Condense должен:
- использовать map‑reduce при overflow
- сохранять entity context

### 16.5 Avoid prompt bloat

Нельзя добавлять в instructions:
- подробные копии RAG,
- длинные debug‑данные.

## 17. Чеклист соблюдения SRP

Каждый компонент делает только своё:
- BudgetManager: расчёт
- Trimmer: фильтрация истории
- RAG: подбор контекста
- AgentClient: сбор и финальная проверка

## 18. Практические примеры

### Пример 1 (gpt‑5.2)
- Model limit 400k
- Safe budget 360k
- History share 35% = 126k
- RAG share 25% = 90k
- Instructions 15% = 54k

### Пример 2 (gemini‑pro)
- Model limit 1M
- Safe budget 900k
- History share 30% = 270k
- RAG share 30% = 270k
- Instructions 10% = 90k

## 19. Итоговые ожидания

После реализации:
- короткий запрос не тащит гигантский хвост;
- overflow‑retry не активируется регулярно;
- contextTokens снижается;
- ответы модели не содержат сообщений об обрезке.

## 20. Приложение: расширенные списки

### 20.1 Метрики
- ragTokens
- historyTokens
- instructionsTokens
- totalTokens

### 20.2 Логи
- context.budget
- context.history.stats
- context.rag.stats
- context.total

### 20.3 Дополнительные anti‑patterns
- Подмешивание всего инструментария в system prompt
- Дублирование summary и raw
- Слишком большой headroom

## 21. Расширение: tests

Добавить тесты:
- overflow handling
- live window size
- rag share enforcement
- multi‑model budget selection

## 22. Миграционный план

1. Добавить per‑model config.
2. Внедрить budget в PromptBudgetManager.
3. Интегрировать с AgentClient.
4. Включить фильтрацию истории.
5. Включить RAG фильтрацию.
6. Удалить reliance на overflow‑retry.

## 23. Дополнительные рекомендации

- Сохранять совместимость с существующими конфигами.
- Делать изменения инкрементально.
- Поддерживать fallback на старую логику только временно.

## 24. Риски

- Слишком агрессивная фильтрация может ухудшить ответы.
- Отсутствие rerank может пропускать релевантные фрагменты.
- Ошибки в токенизации могут приводить к некорректному budget‑контролю.

## 25. Смягчения рисков

- Использовать логирование и метрики.
- Тестировать на коротких/длинных запросах.
- Сохранять headroom.

## 26. Отдельный блок: «как делать нельзя» (дополнительно)

**Нельзя:**
- Считать токены по длине строки.
- Игнорировать differences моделей.
- Игнорировать live window.

## 27. Раздел «как делать нельзя» (расширенные кейсы)

### 27.1 Нельзя включать full RAG без контроля

Пример проблемы: графовый контекст даёт 100k токенов даже на короткий запрос. Итог — модель видит бесполезные связи и вывод «обрезано».

**Правильное действие:** ограничить graph context, выбрать top‑k связей, конденсировать при необходимости.

### 27.2 Нельзя хранить историю «как есть»

Если сырые документы хранятся в истории, то каждый новый запрос тянет гигантский хвост. Это приводит к «неумным» расходам токенов.

**Правильное действие:** summary + ingest, raw текст только в памяти.

### 27.3 Нельзя оставлять инструкцию «просить продолжение»

Она работает в режиме, где текст реально обрезан. Но если summary «корректен», то модель не должна просить продолжение.

**Правильное действие:** инструкции должны отражать суммаризацию.

## 28. Рекомендации по структуре кода

- Бюджет и shares не вычислять внутри `AgentClient` напрямую — использовать `PromptBudgetManager`.
- Историю формировать через `HistoryTrimmer` и `MessageHistoryManager`.
- RAG формировать через `RagContextBuilder` и `multiStepOrchestrator`.
- Любые спец‑кейсы вынести в отдельные функции, не увеличивая сложность `buildMessages`.

## 29. Обоснование фильтрации (policy level)

Фильтрация должна быть основана на **релевантности**. Приоритет:
1. Последние сообщения пользователя.
2. Summary старой истории.
3. Релевантный RAG контекст (top‑k, rerank).
4. Нерелевантный или «околопохожий» контент исключается.

## 30. Поддержка различных моделей

### 30.1 gpt‑5.2
- Лимит 400k
- Более строгий share для history и RAG
- Обязательный headroom >= 8%

### 30.2 gemini‑pro
- Лимит 1M
- Share можно расширить
- Всё равно нужен rerank и фильтр

### 30.3 Другие модели
- При неизвестном лимите использовать conservative fallback
- Логи должны показывать источник лимита

## 31. Сводные правила

1. Всегда учитывать лимит конкретной модели.
2. Резать не «всех», а фильтровать по релевантности.
3. Не дублировать ingest‑контент.
4. Удерживать overflow‑retry как редкий fallback.
5. Обеспечить диагностику и логирование.

## 32. Тест‑план (детализация)

### 32.1 Unit
- `PromptBudgetManager` возвращает разные budgets per model.
- `HistoryTrimmer` не удаляет последнее user‑сообщение.
- `RagContextBuilder` уважает rag share.

### 32.2 Integration
- Короткий запрос после длинного контекста → нормальный ответ без overflow.
- Длинный запрос → summary + ingest.

### 32.3 Load
- Пакет запросов на 10k сообщений → overflow‑retry < 1%.

## 33. Расширенная метрика для наблюдаемости

**Поля:**
- `budget.modelLimit`
- `budget.safeBudget`
- `budget.shares`
- `tokens.instructions`
- `tokens.history`
- `tokens.rag`
- `tokens.total`
- `rag.entitiesCount`
- `rag.rerankScoreAvg`
- `history.liveWindowCount`
- `history.summaryCount`

## 34. Протокол отладки

1. Проверить modelLimit по логам.
2. Проверить safeBudget и shares.
3. Проверить, что totalTokens <= safeBudget до LLM.
4. Проверить отсутствие overflow‑retry.
5. Проверить отсутствие дублей raw+RAG.

## 35. Пример «до/после»

**До:**
- totalTokens ~ 1.1M
- overflow‑retry постоянно
- модель пишет «обрезано»

**После:**
- totalTokens <= safeBudget
- overflow‑retry редко
- модель не жалуется

## 36. Расширенный анализ рисков

- Если shares слишком малы → потеря полезного контекста.
- Если shares слишком велики → overflow.
- Если rerank ошибается → нерелевантные фрагменты в prompt.

**Смягчения:**
- A/B тестирование
- метрики
- возможность ручной настройки

## 37. Документация и коммуникация

- Любые изменения в pipeline фиксировать в `docs/TODO.md` и `docs/README.md`.
- В `docs/logging/transparent_logging.md` добавить секцию про budget‑логи.

## 38. Итоговое резюме

F‑2 требует системного пересмотра pipeline: от жёстких лимитов к фильтрации и per‑model бюджетам. Принцип: **релевантный отбор**, а не просто пережимание контекста. Документ должен быть главным источником правды по реализации F‑2.

***

Документ создан для длительного хранения контекста по F‑2.

## 46. Модуль OpenRouter Model Catalog (лимиты и стоимость)

### 46.1 Зачем нужен отдельный модуль

Чтобы корректно вычислять лимиты токенов **per‑model**, необходимо регулярно получать актуальные параметры моделей из OpenRouter: лимиты контекста, стоимость и метаданные. Ручные константы быстро устаревают и приводят к неверному budget‑контролю.

### 46.2 Цели модуля

- Получать **полный список моделей** из OpenRouter API.
- Нормализовать данные: `provider`, `modelId`, `maxContextTokens`, `pricing`, `availability`, `modalities`.
- Сохранять кэш на диск и в память.
- Давать fallback‑карту при ошибках API.
- Поставлять лимиты в `PromptBudgetManager` и в конфиг бюджета.

### 46.3 Адаптация под текущий проект

В проекте нужна **JS/TS‑реализация**, аналогичная приведённому Python примеру. Предлагаемая структура (пример):

- `api/server/services/Models/OpenRouterModelService.js`
- `api/server/services/Models/index.js`
- `api/server/services/Config/ConfigService.js` — секция openrouter models

### 46.4 Основные функции сервиса

1. **getModelsMap** — возвращает модельные параметры из RAM, API или дискового кэша.
2. **fetchModels** — запрашивает OpenRouter `/models` endpoint.
3. **processModels** — нормализует и группирует по провайдеру.
4. **saveCache / loadCache** — диск + fallback.
5. **logDiff** — изменения между предыдущими и текущими моделями.

### 46.5 Псевдокод JS (адаптация)

```
class OpenRouterModelService {
  constructor(config, httpClient, logger) {
    this.config = config;
    this.httpClient = httpClient;
    this.logger = logger;
    this.cachePath = config.openrouter.modelsCachePath;
    this.refreshIntervalMs = config.openrouter.refreshIntervalMs || 24 * 3600 * 1000;
    this.cachedModels = null;
    this.lastFetch = null;
  }

  async getModelsMap() {
    if (this.cachedModels && this.lastFetch && Date.now() - this.lastFetch < this.refreshIntervalMs) {
      return this.cachedModels;
    }

    const headers = { Accept: "application/json" };
    if (this.config.openrouter.apiKey) {
      headers.Authorization = `Bearer ${this.config.openrouter.apiKey}`;
    }

    const previous = this.readCacheRaw();
    const previousIds = new Set((previous || []).map(m => m.id).filter(Boolean));

    try {
      const resp = await this.httpClient.get(this.config.openrouter.modelsUrl, { headers, timeout: 10000 });
      const payload = resp.data || {};
      const models = payload.data || [];
      const normalized = this.processModels(models);

      this.logDiff(previousIds, new Set(Object.keys(normalized)));
      this.saveCache(models);

      this.cachedModels = normalized;
      this.lastFetch = Date.now();
      return normalized;
    } catch (err) {
      this.logger.warn("openrouter.models.fetch_failed", { err });
      if (this.cachedModels) return this.cachedModels;
      const cached = this.loadFromCache();
      if (cached) return cached;
      return this.fallbackMap();
    }
  }
}
```

### 46.6 Поля нормализованной модели

Минимальные поля, которые нужны для budget‑контроля:

- `modelId` (openrouter model id)
- `provider` (openai, google, anthropic и т.д.)
- `maxContextTokens`
- `pricing` (prompt/completion)
- `modalities` (text, vision)
- `isDeprecated`

### 46.7 Интеграция с PromptBudgetManager

- `PromptBudgetManager` сначала спрашивает **OpenRouterModelService**.
- Если данные есть → берём `maxContextTokens` и используем их в вычислении safeBudget.
- Если данных нет → fallback на config.

### 46.8 Логирование и кэш

Логи должны включать:
- `models.fetch.success` / `models.fetch.failed`
- `models.cache.hit` / `models.cache.miss`
- `models.diff.added` / `models.diff.removed`

Кэш должен храниться локально на диске, чтобы при временной недоступности OpenRouter не ломать работу.

### 46.9 Политика обновления

- Обновление минимум 1 раз в 24 часа.
- Возможность ручного сброса кэша.
- Возможность уменьшить интервал для staging.

### 46.10 Ограничения и анти‑паттерны

**Нельзя:**
- Жёстко прошивать лимиты моделей в коде.
- Отключать кэш и зависеть от API на каждый запрос.
- Игнорировать изменения моделей (deprecated/removed).

**Best practice:**
- Поддерживать fallback‑модель в config.
- При серьёзных изменениях модели логировать алерт.

### 46.11 Мини‑чеклист для модуля

- [ ] API запрос к OpenRouter проходит с timeout.
- [ ] Кэш и fallback работают при ошибке API.
- [ ] Поля `maxContextTokens` и `pricing` доступны в PromptBudgetManager.
- [ ] Логи фиксируют изменения списка моделей.

### 46.12 Где использовать цены

Стоимость (`pricing`) нужна для:
- cost‑tracking,
- бюджетирования на сессию,
- UI‑индикации стоимости.

Для F‑2 она вторична, но модуль должен сохранять эти данные вместе с лимитами.

## 39. Дополнительная детализация: пошаговая реализация

### 39.1 Шаг 1 — Inventory лимитов моделей

Собрать список моделей, реально используемых в проде. Для каждой модели зафиксировать:
- maxContextTokens от провайдера,
- минимально допустимый headroom,
- предпочтительные shares.

**Как делать:**
- использовать фактические лимиты провайдера;
- документировать источники лимита.

**Как делать нельзя:**
- брать лимиты «на глаз» или оставлять дефолт 400k для всех.

### 39.2 Шаг 2 — Встроить per‑model budgets в ConfigService

Подготовить структуру конфигов, допускающую overrides per model. Настроить fallback на глобальные значения.

**Best practice:** хранить и глобальные и per‑model значения, чтобы не ломать старые конфиги.

### 39.3 Шаг 3 — Подключить PromptBudgetManager

Добавить расчёт safeBudget, shares, headroom. Вывести диагностику `context.budget`.

### 39.4 Шаг 4 — Live window и summary

Определить параметры live window отдельно от historyBudget. При необходимости уменьшать N.

### 39.5 Шаг 5 — RAG quotas

Ввести per‑model quotas:
- graphTokensBudget,
- vectorTokensBudget.

При превышении запускать condense только на избранном top‑k.

### 39.6 Шаг 6 — Non‑duplication enforcement

Если `isIngested=true`, исключить raw content из prompt. Вывести диагностику `context.dedup`.

### 39.7 Шаг 7 — End‑to‑end guardrail

Перед вызовом LLM проверять totalTokens. Если превышение — выполнять controlled shrink.

## 40. Дополнительная детализация: правила приоритетов

Приоритеты внутри history:
1. system/agent instructions,
2. последнее user сообщение,
3. последнее assistant сообщение,
4. summaries,
5. старые user/assistant сообщения.

Приоритеты внутри RAG:
1. сущности из текущего запроса,
2. сущности из последних N сообщений,
3. стабильные ключевые сущности диалога.

## 41. Дополнительная детализация: политика сжатия

Сжатие должно быть:
- предсказуемым,
- детерминированным,
- логируемым.

**Нельзя:**
- удалять последние user сообщения,
- удалять инструкции,
- сжимать всё подряд без приоритетов.

## 42. Рекомендации по логированию

Добавить структурированные события:
- `context.budget`
- `context.history.selection`
- `context.rag.selection`
- `context.total`

**Полезные поля:**
- `modelLimit`, `safeBudget`, `headroom`
- `historyTokens`, `ragTokens`, `instructionTokens`, `totalTokens`
- `liveWindowCount`, `summaryCount`, `ragChunksCount`

## 43. Примеры негативных сценариев и предотвращение

### 43.1 Сценарий: короткий запрос + большой history

**Плохо:** весь history включён.

**Хорошо:** live window + summary, остальное в памяти.

### 43.2 Сценарий: RAG выдаёт 50 chunks

**Плохо:** все chunks в prompt.

**Хорошо:** top‑k + condense.

### 43.3 Сценарий: лимит модели 1M

**Плохо:** «тащим всё».

**Хорошо:** расширяем shares, но фильтруем по релевантности.

## 44. Минимальные критерии приёмки

- Per‑model budgets реализованы и проверяемы по логам.
- Overflow‑retry встречается только на крайних кейсах.
- Короткий запрос не тянет гигантский хвост.
- Дубликаты raw+RAG отсутствуют.

## 45. Дополнительные предложения по будущему развитию

- Автоматическая оценка релевантности history (scoring).
- Лёгкая модель‑фильтр для предварительного отбора history.
- Авто‑подстройка shares по профилю диалога (например, больше RAG для исследовательских запросов).
