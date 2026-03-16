# ContextManager

`ContextManager` описан исторически, но in-memory контекст не является целевой архитектурой.

## Новое решение

- In-memory контекст исключается.
- Контекст хранится во внешнем сторе (например, Redis/DB).
- Оркестрация ingestion выполняется через ingest profiles.

## Основные обязанности (legacy)

- хранение последних сообщений (legacy in-memory),
- усечение контекста по лимитам,
- сборка payload для Graph/Summary,
- model routing для OpenRouter.

Файл: [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:329).

## Лимиты

- `MAX_CONTEXT_MESSAGES`, `MAX_CONTEXT_TOKENS` — глобальные лимиты.
- `SUMMARY_TEMPORAL_MAX_*` — лимиты payload суммаризации.

См. [`backend/tools-gateway/core/config.py`](backend/tools-gateway/core/config.py:12).
