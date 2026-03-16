# Сервисы tools-gateway

## Ingest profiles

Формализованные профили для ingestion (`message`, `summary`, `graph`, `memory`) и фасадный endpoint `/tool/submit_ingest`.

## ContextManager (legacy)

In-memory контекст и оркестрация ingestion (legacy). Поддерживает:
- хранение последних сообщений,
- лимиты по количеству сообщений,
- маршрутизацию моделей (primary/fallback/premium),
- запуск Temporal воркфлоу.

Файл: [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:329).

## LLM сервис

Пайплайн извлечения сущностей и отношений:
- строит промпт,
- вызывает OpenRouter/Ollama/Vertex,
- нормализует сущности и связи,
- пишет проблемные ответы в `FAILED_JSON_BASE_DIR`.

Файл: [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:875).

## RAG сервис

Гибридный поиск по чанкам в Postgres (vector + keyword) и RRF, опционально обогащает графом.

Файл: [`backend/tools-gateway/services/rag.py`](backend/tools-gateway/services/rag.py:192).

## Embeddings

Получает эмбеддинги через TEI. Умеет нарезать текст на токены и делать fallback.

Файл: [`backend/tools-gateway/services/embeddings.py`](backend/tools-gateway/services/embeddings.py:304).

## Graph/Neo4j

Формирует графовый контекст, пишет сущности и summary.

Файл: [`backend/tools-gateway/services/neo4j.py`](backend/tools-gateway/services/neo4j.py:20).

## Summary

Генерация суммаризаций с fallback-моделями, загрузка сообщений из MongoDB.

Файл: [`backend/tools-gateway/services/summary.py`](backend/tools-gateway/services/summary.py:138).

## MCP adapter

Адаптация MCP tools и единая политика вызовов.

## Temporal / NATS

Запуск воркфлоу и диспетчеризация задач через JetStream.

Файлы:
- [`backend/tools-gateway/services/workflow_launcher.py`](backend/tools-gateway/services/workflow_launcher.py:127)
- [`backend/tools-gateway/services/nats_dispatcher.py`](backend/tools-gateway/services/nats_dispatcher.py:59)
