# FIX (best practices)

1. Закрыть доступ к `/cypher` без авторизации или заменить на whitelisted запросы.
   - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:298)
2. Пересмотреть хранение `FAILED_JSON_BASE_DIR` и срок хранения файлов с ошибочными payload.
   - [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:453)
3. Снизить риск утечки PII в логах: выключить debug-лог payload в prod.
   - [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:488)
4. Добавить контроль за размером `query_hint` и текстов в graph-context на стороне клиента.
   - [`backend/tools-gateway/services/neo4j.py`](backend/tools-gateway/services/neo4j.py:124)
5. Формально документировать ограничение payload в Temporal (summary/memory).
   - [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:740)
6. Убрать in-memory контекст, заменить на внешний стор с персистентностью.
   - [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:329)
7. Ввести policy вызовов tools (allowlist, лимиты, audit).
