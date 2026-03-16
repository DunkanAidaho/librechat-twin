# Сильные и слабые стороны

## Сильные стороны

- **Гибридный поиск (vector + keyword)** с RRF увеличивает полноту выдачи.
  - [`backend/tools-gateway/services/rag.py`](backend/tools-gateway/services/rag.py:163)
- **Надёжная обработка payload** для Summary/Memory (усечения, лимиты).
  - [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:129)
  - [`backend/tools-gateway/services/payload_defender.py`](backend/tools-gateway/services/payload_defender.py:158)
- **Model routing** (primary/fallback/premium) уменьшает риск деградации.
  - [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:322)
- **NATS/JetStream опциональность** — можно работать синхронно без брокера.
  - [`backend/tools-gateway/services/nats_dispatcher.py`](backend/tools-gateway/services/nats_dispatcher.py:68)

## Слабые стороны и риски

- **In-memory контекст** не масштабируется горизонтально без внешнего хранилища.
  - [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:329)
- **Отсутствие схем и миграций БД** в репозитории — риск расхождения индексов.
  - зависимость от внешней настройки Postgres/Neo4j/Mongo.
- **Часть маршрутов не покрыта авторизацией** (доверенная сеть предполагается).
  - см. открытые эндпоинты в [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:252)
- **Риски переполнения логов** при включённых debug-логах payload.
  - [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:488)

## Наблюдаемые технические долги

- `rag_recent` роутер пустой (возвращает empty response).
  - [`backend/tools-gateway/routes/rag_recent.py`](backend/tools-gateway/routes/rag_recent.py:26)
- Валидация запретов Cypher основана на regex и не гарантирует read-only.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:102)
