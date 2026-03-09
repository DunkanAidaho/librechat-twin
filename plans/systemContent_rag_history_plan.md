# План стабилизации systemContent, RAG и истории сообщений

## 1. Диагностика текущего состояния

1. Зафиксировать источники systemContent в [`client.js`](api/server/controllers/agents/client.js) и сопутствующие блоки (`replaceAugmentedBlock`, `replaceOcrBlock`, прямая конкатенация RAG/augmented).
2. Составить карту пайплайна `buildMessages`: очередность live window → history trimmer → RAG context → attachments/OCR → overflow guard → retry compression.
3. Собрать сведения о повторном использовании `replaceRagBlock` в [`BaseClient.buildMessages`](api/app/clients/BaseClient.js) и других клиентах для сравнения.
4. Задокументировать текущие лимиты/отсутствие лимитов для `additional_instructions`, OCR, augmentedPrompt.

## 2. Требования к безопасным вставкам

5. Ввести контракт «один блок — один replace»: RAG, OCR, augmentedPrompt, attachments.
6. Расширить `replaceRagBlock` в [`RagContextManager`](api/server/services/RAG/RagContextManager.js) либо создать эквиваленты для OCR/augmented блоков с обязательной очисткой предыдущих версий.
7. добавление логирования длины и hash каждого блока до и после replace; включить длину блока в `req.ragMetrics`.
8. Ограничить длину `this.augmentedPrompt` (runtimeCfg.limits.promptPerMsgMax) и OCR-блоков, автоматически обрезать и логировать триммирование.

## 3. Управление systemContent и бюджетами

9. Обновить интеграцию `PromptBudgetManager` ([`PromptBudgetManager.js`](api/server/services/agents/PromptBudgetManager.js)): включить фактический `systemContentLength` при расчёте `historyTokenBudget`.
10. Добавить подсчёт `instructionsTokens` после каждого replace, пересчитывать headroom до запуска history trimming/RAG.
11. Ввести лимиты на `additional_instructions` агента: hash+длина, хранить последнюю версию per conversation, избегать повторной конкатенации.
12. Разработать механизм очистки `this.contextHandlers` после `createContext()`, хранить контрольный hash, предотвращать повторное применение при регене.

## 4. История и RAG

13. Жёстко зафиксировать порядок шагов history pipeline: live window (MessageHistoryManager) → history trimmer → ingestion queue → RAG builder → attachments/OCR → overflow guard → retry compression.
14. В [`historyTrimmer`](api/server/services/agents/historyTrimmer.js) и [`MessageHistoryManager`](api/server/services/agents/MessageHistoryManager.js) документировать, какие сообщения становятся доступными RAG и какие считаются ingest-ready.
15. Определить механизм предотвращения повторного condense: флаг «ragCondensed» в `req` и `replaceRagBlock`, проверка перед `applyDeferredCondensation`.
16. Добавить гарантию доставки dropped messages: если Temporal/NATS недоступен, писать в локальный backlog (`MemoryBacklog`), сигнализировать в логах и не удалять сообщения из live window до подтверждения.
17. Обновить overflow guard и `compressMessagesForRetry`, чтобы учитывать уже обработанные RAG блоки и не запускать повторную компрессию тех же сообщений.

## 5. Управление ветвлениями истории

18. Зафиксировать политику messageId/parentId при регенерации: уникальные responseMessageId, возможность reuse userMessageId только с удалением предыдущих assistant child.
19. Обновить [`BaseClient.handleStartMethods`](api/app/clients/BaseClient.js) и [`Message`](api/models/Message.js) для последовательного удаления старых assistant ответов при regen/headless режимах.
20. Добавить вызов `deleteMessagesSince` или эквивалента в `AgentClient` перед повторными прогоном, синхронизировать с frontend.
21. Синхронизировать live window trimming с frontend обновлениями ID: фронт получает события об удалённых/заменённых сообщениях, чтобы не отображать «ветки».
22. В `processDroppedMessages` и ingest очереди фиксировать состояние в `req`/`res`, чтобы UI понимал, что часть истории перемещена в память.

## 6. Multi-step RAG и ragSections

23. Разработать механику повторного использования `ragSections`: хранение hash последнего блока, skip при идентичности, очистка при regen.
24. Обновить `instructionsBuilder.buildRagSections` ([`InstructionsBuilder.js`](api/server/services/agents/InstructionsBuilder.js)) для явного контроля длины и токенов.
25. В `AgentClient.buildMessages` внедрить предикат: если `ragSectionsLength` = 0 и `ragContextLength` > 0, логируем предупреждение, чтобы ловить разрыв контракта.

## 7. Тестирование и документация

26. Сформировать тестовую матрицу: сценарии regen с attachments, большие OCR, multi-step RAG, отключённый Temporal, overflow retry.
27. Обновить документацию (`plans/agents_refactor_plan.md`, [`plans/f2_context_decomposition.md`](plans/f2_context_decomposition.md)) описанием нового пайплайна и контрактов.
28. Создать Mermaid-диаграмму «Context Pipeline v2» с шагами и контрольными точками hash/length/metrics.
29. Подготовить план внедрения по фазам: сначала безопасные replace и логирование, затем бюджетные корректировки, потом работа с ветвлениями.
30. Согласовать итоговый план с командами RAG, History, Frontend, зафиксировать ответственность и ожидаемые артефакты.

