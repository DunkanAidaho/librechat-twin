from __future__ import annotations

from collections import deque
from typing import Any, Deque, Dict, List

_MAX_EVENTS = 200
_events: Deque[Dict[str, Any]] = deque(maxlen=_MAX_EVENTS)


def add_event(event: Dict[str, Any]) -> None:
    _events.append(event)


def list_events(limit: int = 100) -> List[Dict[str, Any]]:
    if limit <= 0:
        return []
    return list(_events)[-limit:]


def list_events_for_job(job_id: str, limit: int = 200) -> List[Dict[str, Any]]:
    if limit <= 0:
        return []
    if not job_id:
        return []
    job_id = job_id.strip()
    if not job_id:
        return []
    matched: List[Dict[str, Any]] = []
    for event in reversed(_events):
        if event.get("workflow_id") == job_id:
            matched.append(event)
        if len(matched) >= limit:
            break
    return list(reversed(matched))
