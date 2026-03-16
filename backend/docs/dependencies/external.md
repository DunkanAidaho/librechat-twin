# Внешние зависимости backend

Сервис зависит от следующих внешних систем:

- **PostgreSQL + pgvector** — таблица `chunks`, эмбеддинги, keyword search.
  - Используется в [`backend/tools-gateway/services/rag.py`](backend/tools-gateway/services/rag.py:192).
- **Neo4j** — хранение сущностей и отношений.
  - [`backend/tools-gateway/services/neo4j.py`](backend/tools-gateway/services/neo4j.py:20).
- **MongoDB** — сообщения и summary.
  - [`backend/tools-gateway/services/mongo_repository.py`](backend/tools-gateway/services/mongo_repository.py:259).
- **Temporal** — фоновые воркфлоу (Graph/Memory/Summary).
  - [`backend/tools-gateway/services/workflow_launcher.py`](backend/tools-gateway/services/workflow_launcher.py:127).
- **NATS/JetStream** — опциональная очередная обработка задач.
  - [`backend/tools-gateway/services/nats_dispatcher.py`](backend/tools-gateway/services/nats_dispatcher.py:59).
- **TEI (Text Embeddings Inference)** — эмбеддинги.
  - [`backend/tools-gateway/services/embeddings.py`](backend/tools-gateway/services/embeddings.py:304).
- **OpenRouter / Ollama / Vertex** — LLM провайдеры.
  - [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:525).

## Внутренние библиотеки

- FastAPI, Pydantic, httpx, SQLAlchemy, neo4j-driver, motor.
- Temporal SDK (`temporalio`), NATS (`nats-py`).

См. зависимости в [`backend/tools-gateway/requirements.txt`](backend/tools-gateway/requirements.txt).
