# MongoDB repository

Функции:
- чтение сообщений для summary,
- сохранение summary и выборка последней записи,
- удаление summaries.

Файл: [`backend/tools-gateway/services/mongo_repository.py`](backend/tools-gateway/services/mongo_repository.py:259).

Особенности:
- гибкий маппинг полей `conversation_id`, `role`, `content`, `created_at`.
- нормализация ролей.

## Индексы и миграции

- Индексы по `conversation_id` и `created_at`.
- Версии коллекций фиксируются через index migrations.
