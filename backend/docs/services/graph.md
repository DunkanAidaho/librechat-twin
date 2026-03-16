# Графовый сервис (Neo4j)

## Контекст графа

`fetch_graph_context` формирует сводку последних связей и summary беседы.

Файл: [`backend/tools-gateway/services/neo4j.py`](backend/tools-gateway/services/neo4j.py:155).

## Запись сущностей

`ingest_entities_neo4j` пишет сущности, сообщения, отношения и MENTIONS.

Файл: [`backend/tools-gateway/services/neo4j.py`](backend/tools-gateway/services/neo4j.py:509).

## Ограничения

- Типы сущностей и отношений синхронизируются с LLM нормализатором.
  - [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:398)
