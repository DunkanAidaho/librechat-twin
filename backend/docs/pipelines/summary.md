# Summary pipeline

1. Получение сообщений из MongoDB (`fetch_messages`).
2. Построение prompt + учёт previous summary.
3. Вызов модели (OpenRouter/Ollama/Vertex) по policy.
4. Запись summary в MongoDB (в воркфлоу).
5. Публикация status events через NATS (если включено).

Код:
- [`backend/tools-gateway/services/summary.py`](backend/tools-gateway/services/summary.py:138)
- [`backend/tools-gateway/services/mongo_repository.py`](backend/tools-gateway/services/mongo_repository.py:259)
