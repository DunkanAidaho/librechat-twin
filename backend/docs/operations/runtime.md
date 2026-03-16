# Runtime и жизненный цикл

## Startup

- Инициализация httpx клиента, NATS dispatcher, фоновые задачи.
- Инициализация policy вызовов tools (allowlist, лимиты, audit).
- Опциональный backfill `content_dates` в Postgres.

Файл: [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:126).

## Shutdown

- Остановка NATS dispatcher.
- Закрытие httpx, Neo4j, SQLAlchemy, Temporal.

Файл: [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:210).
