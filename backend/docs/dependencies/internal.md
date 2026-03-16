# Внутренние зависимости (модули)

## core

- `core/config.py` — конфигурация и env-переменные.
- `core/clients.py` — клиенты Postgres, Neo4j, Mongo, httpx.
- `core/logging.py` — базовая конфигурация логов.

Файлы:
- [`backend/tools-gateway/core/config.py`](backend/tools-gateway/core/config.py:1)
- [`backend/tools-gateway/core/clients.py`](backend/tools-gateway/core/clients.py:1)
- [`backend/tools-gateway/core/logging.py`](backend/tools-gateway/core/logging.py:1)

## services

Ключевые сервисы перечислены в [`backend/docs/services/overview.md`](backend/docs/services/overview.md).

## models

Pydantic модели запросов/ответов/DTO.

Файл: [`backend/tools-gateway/models/pydantic_models.py`](backend/tools-gateway/models/pydantic_models.py:8).
