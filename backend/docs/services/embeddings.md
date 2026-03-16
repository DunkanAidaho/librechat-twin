# Embeddings

Сервис `embeddings` вызывает TEI и управляет разбиением текста.

Особенности:
- token-aware разбиение (`TokenChunker`),
- fallback между MXBAI и E5,
- rate limiting.

## Политика embeddings

- **Primary** модель выбирается на уровне профиля/тенанта.
- **Fallback** используется при ошибках, таймаутах или деградации latency.
- Метрики качества (hit rate / rerank score) фиксируются для отслеживания деградации.

Файл: [`backend/tools-gateway/services/embeddings.py`](backend/tools-gateway/services/embeddings.py:88).
