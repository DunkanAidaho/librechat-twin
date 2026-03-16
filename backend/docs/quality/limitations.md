# Ограничения

- Контекстные сообщения хранятся в памяти процесса.
- Лимиты на payload summary/memory зависят от env.
- Нет встроенного auth.

Код:
- [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:329)
- [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:740)
- [`backend/tools-gateway/app.py`](backend/tools-gateway/app.py:252)
