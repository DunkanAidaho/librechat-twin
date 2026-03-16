# NATS dispatcher

Диспетчер подписывается на JetStream и запускает воркфлоу.

- Автосоздание стримов.
- Pull-consumer с ack/nak.

## Ingest profiles

- `submit_ingest` может публиковать события в NATS для Summary/Memory.

Файл: [`backend/tools-gateway/services/nats_dispatcher.py`](backend/tools-gateway/services/nats_dispatcher.py:59).
