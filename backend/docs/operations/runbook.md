# Runbook

## Запуск сервиса

1. Настроить env-переменные (см. [`backend/docs/operations/env.md`](backend/docs/operations/env.md)).
2. Запустить FastAPI приложение (см. Dockerfile или uvicorn entrypoint).
3. Проверить `/healthz` и `/metrics`.
4. Протестировать фасадные endpoint `/tool/search_context` и `/tool/submit_ingest`.

## Отладка

- Проверить логи на старте (`[Startup]`).
- Проверить доступность внешних систем.

См. [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:126).
