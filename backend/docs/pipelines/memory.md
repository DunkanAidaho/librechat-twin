# Memory pipeline

`MemoryWorkflow` получает payload, который может быть автоматически разрезан на чанки по лимиту.

## Вход

- `/tool/submit_ingest` (profile=memory)
- payload нормализуется по профилю и проверяется по лимитам

## Шаги

1. Валидация профиля и схемы.
2. Нормализация payload (trace_id, conversation_id).
3. Payload Defender режет данные по лимитам.
4. Запуск `MemoryWorkflow` через Temporal/NATS.

Файлы:
- [`backend/tools-gateway/services/workflow_launcher.py`](backend/tools-gateway/services/workflow_launcher.py:127)
- [`backend/tools-gateway/services/payload_defender.py`](backend/tools-gateway/services/payload_defender.py:158)
