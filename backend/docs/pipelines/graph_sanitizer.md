# Графовый sanitizer (LLM pre-processing)

Перед извлечением сущностей текст может быть очищен для удаления служебных блоков, приветствий и reasoning.

- Используется `sanitize_graph_text`.
- Принудительная смена модели при превышении `GRAPH_PREMIUM_THRESHOLD_CHARS`.

Файл: [`backend/tools-gateway/services/graph_preprocessor.py`](backend/tools-gateway/services/graph_preprocessor.py:68).
