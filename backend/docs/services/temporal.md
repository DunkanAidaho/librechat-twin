# Temporal workflows

## GraphWorkflow

Запускается из `ContextManager` и `/temporal/graph/run`.

Код:
- [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:468)
- [`backend/tools-gateway/services/workflow_launcher.py`](backend/tools-gateway/services/workflow_launcher.py:305)

## SummaryWorkflow

Запускается из `ContextManager` и `/temporal/summary/run`.

Код:
- [`backend/tools-gateway/services/context_manager.py`](backend/tools-gateway/services/context_manager.py:665)
- [`backend/tools-gateway/services/workflow_launcher.py`](backend/tools-gateway/services/workflow_launcher.py:189)

## MemoryWorkflow

Запускается из `/temporal/memory/run`, payload может быть разрезан.

Код:
- [`backend/tools-gateway/services/workflow_launcher.py`](backend/tools-gateway/services/workflow_launcher.py:127)
- [`backend/tools-gateway/services/payload_defender.py`](backend/tools-gateway/services/payload_defender.py:158)
