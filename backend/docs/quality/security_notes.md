# Security notes

- `FORBIDDEN_CYPHER_PATTERN` защищает от DDL/DML, но не от сложных обходов.
  - [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:102)
- Отсутствуют rate limits на HTTP-уровне.
  - [`backend/tools-gateway/services/llm.py`](backend/tools-gateway/services/llm.py:52)
- Policy tools вызовов должна включать allowlist, лимиты payload, аудит.
