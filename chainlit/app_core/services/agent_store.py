"""Agent storage service with JSON backend and structured logging."""
from __future__ import annotations

import asyncio
import json
import os
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional
from uuid import uuid4

from filelock import FileLock, Timeout

from app_core.services.config_service import AgentsConfig, config_service
from app_core.utils.structured_logging import extra_with_context, get_logger, log_exception

__all__ = [
    "AGENT_SCHEMA_VERSION",
    "AgentRecord",
    "AgentStore",
]

AGENT_SCHEMA_VERSION = 1
_REASONING_COST_RANGE = (0.0, 100.0)


@dataclass(frozen=True)
class AgentRecord:
    """Immutable representation of an agent stored in JSON."""

    agent_id: str
    name: str
    system_prompt: str
    model_id: str
    temperature: float
    top_p: float
    frequency_penalty: float
    presence_penalty: float
    reasoning_cost: float
    created_at: str
    updated_at: str
    schema_version: int = AGENT_SCHEMA_VERSION


class AgentStore:
    """Manages CRUD operations for agents with filesystem persistence."""

    def __init__(self, path: Path, lock_timeout: float = 5.0) -> None:
        """Initialises the store and ensures the backing file exists.

        Args:
            path: Path to the JSON file that stores agent entries.
            lock_timeout: Lock acquisition timeout in seconds.
        """
        self._path = path
        self._lock = FileLock(f"{self._path}.lock")
        self._lock_timeout = lock_timeout
        self._logger = get_logger(__name__)
        self._config: AgentsConfig = config_service.get_section("agents")
        self._ensure_storage()

    async def list_agents(self, *, trace_id: Optional[str] = None) -> List[AgentRecord]:
        """Returns all stored agents preserving creation order."""
        return await asyncio.to_thread(self._list_agents_sync, trace_id)

    async def get_agent(self, agent_id: str, *, trace_id: Optional[str] = None) -> Optional[AgentRecord]:
        """Fetches a single agent by identifier."""
        return await asyncio.to_thread(self._get_agent_sync, agent_id, trace_id)

    async def create_agent(
        self,
        payload: Dict[str, object],
        *,
        trace_id: Optional[str] = None,
    ) -> AgentRecord:
        """Creates a new agent record."""
        return await asyncio.to_thread(self._create_agent_sync, payload, trace_id)

    async def update_agent(
        self,
        agent_id: str,
        payload: Dict[str, object],
        *,
        trace_id: Optional[str] = None,
    ) -> AgentRecord:
        """Updates an existing agent."""
        return await asyncio.to_thread(self._update_agent_sync, agent_id, payload, trace_id)

    async def clone_agent(
        self,
        agent_id: str,
        *,
        new_name: Optional[str] = None,
        trace_id: Optional[str] = None,
    ) -> AgentRecord:
        """Creates a copy of an existing agent."""
        return await asyncio.to_thread(self._clone_agent_sync, agent_id, new_name, trace_id)

    async def delete_agent(self, agent_id: str, *, trace_id: Optional[str] = None) -> None:
        """Deletes an agent by identifier."""
        await asyncio.to_thread(self._delete_agent_sync, agent_id, trace_id)

    # ------------------------------------------------------------------ internal

    def _ensure_storage(self) -> None:
        data_dir = self._path.parent
        data_dir.mkdir(parents=True, exist_ok=True)
        self._ensure_permissions(data_dir, 0o700)

        if not self._path.exists():
            initial = {
                "schema_version": AGENT_SCHEMA_VERSION,
                "agents": [],
            }
            self._path.write_text(json.dumps(initial, ensure_ascii=False, indent=2), encoding="utf-8")
            self._ensure_permissions(self._path, 0o600)

    def _ensure_permissions(self, target: Path, mode: int) -> None:
        try:
            os.chmod(target, mode)
        except PermissionError:
            self._logger.warning(
                "Не удалось применить права доступа",
                extra=extra_with_context(
                    operation="chmod",
                    status="permission_denied",
                    path=str(target),
                    trace_id=None,
                ),
            )

    @contextmanager
    def _acquired_lock(self, operation: str, trace_id: Optional[str]):
        acquired = False
        try:
            self._lock.acquire(timeout=self._lock_timeout)
            acquired = True
            yield
        except Timeout as exc:
            log_exception(
                self._logger,
                "Не удалось получить блокировку файла агентов",
                exc,
                **extra_with_context(operation=operation, status="timeout", trace_id=trace_id),
            )
            raise
        finally:
            if acquired and self._lock.is_locked:
                self._lock.release()

    def _load_payload(self, trace_id: Optional[str]) -> Dict[str, object]:
        try:
            raw = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            self._ensure_storage()
            return {"schema_version": AGENT_SCHEMA_VERSION, "agents": []}
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            log_exception(
                self._logger,
                "Некорректный JSON в хранилище агентов",
                exc,
                **extra_with_context(operation="read", status="invalid_json", trace_id=trace_id),
            )
            raise

    def _dump_payload(self, payload: Dict[str, object], trace_id: Optional[str]) -> None:
        self._path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def _list_agents_sync(self, trace_id: Optional[str]) -> List[AgentRecord]:
        with self._acquired_lock("read", trace_id):
            payload = self._load_payload(trace_id)
            return self._deserialize_agents(payload, trace_id)

    def _get_agent_sync(self, agent_id: str, trace_id: Optional[str]) -> Optional[AgentRecord]:
        with self._acquired_lock("read", trace_id):
            payload = self._load_payload(trace_id)
            for record in self._deserialize_agents(payload, trace_id):
                if record.agent_id == agent_id:
                    return record
        return None

    def _create_agent_sync(self, payload: Dict[str, object], trace_id: Optional[str]) -> AgentRecord:
        with self._acquired_lock("create", trace_id):
            store = self._load_payload(trace_id)
            records = self._deserialize_agents(store, trace_id)
            record = self._build_record(payload, trace_id, operation="create")
            records.append(record)
            self._write_records(store, records, trace_id)
            self._logger.info(
                "Создан агент",
                extra=extra_with_context(operation="create", agent_id=record.agent_id, status="ok", trace_id=trace_id),
            )
            return record

    def _update_agent_sync(self, agent_id: str, payload: Dict[str, object], trace_id: Optional[str]) -> AgentRecord:
        with self._acquired_lock("update", trace_id):
            store = self._load_payload(trace_id)
            records = self._deserialize_agents(store, trace_id)
            for index, existing in enumerate(records):
                if existing.agent_id == agent_id:
                    merged = self._merge_record(existing, payload, trace_id, operation="update")
                    records[index] = merged
                    self._write_records(store, records, trace_id)
                    self._logger.info(
                        "Агент обновлён",
                        extra=extra_with_context(operation="update", agent_id=agent_id, status="ok", trace_id=trace_id),
                    )
                    return merged

            self._logger.warning(
                "Агент для обновления не найден",
                extra=extra_with_context(operation="update", agent_id=agent_id, status="not_found", trace_id=trace_id),
            )
            raise KeyError(f"Agent '{agent_id}' not found")

    def _clone_agent_sync(
        self,
        agent_id: str,
        new_name: Optional[str],
        trace_id: Optional[str],
    ) -> AgentRecord:
        with self._acquired_lock("clone", trace_id):
            store = self._load_payload(trace_id)
            records = self._deserialize_agents(store, trace_id)

            original = next((record for record in records if record.agent_id == agent_id), None)
            if original is None:
                self._logger.warning(
                    "Агент для клонирования не найден",
                    extra=extra_with_context(operation="clone", agent_id=agent_id, status="not_found", trace_id=trace_id),
                )
                raise KeyError(f"Agent '{agent_id}' not found")

            clone_payload = asdict(original)
            clone_payload.update(
                {
                    "agent_id": None,
                    "name": new_name or f"{original.name} (clone)",
                    "created_at": None,
                    "updated_at": None,
                }
            )
            clone = self._build_record(clone_payload, trace_id, operation="clone")
            records.append(clone)
            self._write_records(store, records, trace_id)
            self._logger.info(
                "Агент клонирован",
                extra=extra_with_context(operation="clone", agent_id=clone.agent_id, status="ok", trace_id=trace_id),
            )
            return clone

    def _delete_agent_sync(self, agent_id: str, trace_id: Optional[str]) -> None:
        with self._acquired_lock("delete", trace_id):
            store = self._load_payload(trace_id)
            records = self._deserialize_agents(store, trace_id)
            filtered = [record for record in records if record.agent_id != agent_id]

            if len(filtered) == len(records):
                self._logger.warning(
                    "Агент для удаления не найден",
                    extra=extra_with_context(operation="delete", agent_id=agent_id, status="not_found", trace_id=trace_id),
                )
                raise KeyError(f"Agent '{agent_id}' not found")

            self._write_records(store, filtered, trace_id)
            self._logger.info(
                "Агент удалён",
                extra=extra_with_context(operation="delete", agent_id=agent_id, status="ok", trace_id=trace_id),
            )

    def _write_records(
        self,
        store: Dict[str, object],
        records: Iterable[AgentRecord],
        trace_id: Optional[str],
    ) -> None:
        store["schema_version"] = AGENT_SCHEMA_VERSION
        store["agents"] = [asdict(record) for record in records]
        self._dump_payload(store, trace_id)

    def _deserialize_agents(self, payload: Dict[str, object], trace_id: Optional[str]) -> List[AgentRecord]:
        raw_agents = payload.get("agents", [])
        records: List[AgentRecord] = []
        for raw in raw_agents:
            records.append(self._hydrate(raw, trace_id))
        return records

    def _hydrate(self, raw: Dict[str, object], trace_id: Optional[str]) -> AgentRecord:
        try:
            created = str(raw.get("created_at") or datetime.now(timezone.utc).isoformat())
            updated = str(raw.get("updated_at") or created)
            return AgentRecord(
                agent_id=str(raw["agent_id"]),
                name=str(raw.get("name") or "Новый агент"),
                system_prompt=str(raw.get("system_prompt") or ""),
                model_id=str(raw.get("model_id") or ""),
                temperature=float(raw.get("temperature", self._config.defaults.temperature)),
                top_p=float(raw.get("top_p", self._config.defaults.top_p)),
                frequency_penalty=float(raw.get("frequency_penalty", self._config.defaults.frequency_penalty)),
                presence_penalty=float(raw.get("presence_penalty", self._config.defaults.presence_penalty)),
                reasoning_cost=float(raw.get("reasoning_cost", self._config.defaults.reasoning_cost)),
                created_at=created,
                updated_at=updated,
                schema_version=int(raw.get("schema_version") or AGENT_SCHEMA_VERSION),
            )
        except Exception as exc:  # noqa: BLE001
            log_exception(
                self._logger,
                "Ошибка гидратации записи агента",
                exc,
                **extra_with_context(operation="hydrate", status="invalid_record", trace_id=trace_id),
            )
            raise

    def _build_record(
        self,
        payload: Dict[str, object],
        trace_id: Optional[str],
        *,
        operation: str,
    ) -> AgentRecord:
        now = datetime.now(timezone.utc).isoformat()
        defaults = self._config.defaults
        return AgentRecord(
            agent_id=str(payload.get("agent_id") or uuid4()),
            name=self._normalize_string(
                field="name",
                value=payload.get("name"),
                fallback="Новый агент",
                operation=operation,
                trace_id=trace_id,
            ),
            system_prompt=str(payload.get("system_prompt") or (defaults.system_prompt or "")),
            model_id=self._normalize_string(
                field="model_id",
                value=payload.get("model_id"),
                fallback=defaults.model_id or "openrouter/google/gemini-2.5-pro",
                operation=operation,
                trace_id=trace_id,
            ),
            temperature=self._normalize_float(
                field="temperature",
                value=payload.get("temperature"),
                default=defaults.temperature,
                minimum=0.0,
                maximum=2.0,
                operation=operation,
                trace_id=trace_id,
            ),
            top_p=self._normalize_float(
                field="top_p",
                value=payload.get("top_p"),
                default=defaults.top_p,
                minimum=0.0,
                maximum=1.0,
                operation=operation,
                trace_id=trace_id,
            ),
            frequency_penalty=self._normalize_float(
                field="frequency_penalty",
                value=payload.get("frequency_penalty"),
                default=defaults.frequency_penalty,
                minimum=-2.0,
                maximum=2.0,
                operation=operation,
                trace_id=trace_id,
            ),
            presence_penalty=self._normalize_float(
                field="presence_penalty",
                value=payload.get("presence_penalty"),
                default=defaults.presence_penalty,
                minimum=-2.0,
                maximum=2.0,
                operation=operation,
                trace_id=trace_id,
            ),
            reasoning_cost=self._normalize_float(
                field="reasoning_cost",
                value=payload.get("reasoning_cost"),
                default=defaults.reasoning_cost,
                minimum=_REASONING_COST_RANGE[0],
                maximum=_REASONING_COST_RANGE[1],
                operation=operation,
                trace_id=trace_id,
            ),
            created_at=str(payload.get("created_at") or now),
            updated_at=now,
        )

    def _merge_record(
        self,
        original: AgentRecord,
        payload: Dict[str, object],
        trace_id: Optional[str],
        *,
        operation: str,
    ) -> AgentRecord:
        data = asdict(original)
        for key, value in payload.items():
            if value is not None:
                data[key] = value
        now = datetime.now(timezone.utc).isoformat()
        return AgentRecord(
            agent_id=original.agent_id,
            name=self._normalize_string(
                field="name",
                value=data.get("name"),
                fallback=original.name,
                operation=operation,
                trace_id=trace_id,
            ),
            system_prompt=str(data.get("system_prompt", original.system_prompt)),
            model_id=self._normalize_string(
                field="model_id",
                value=data.get("model_id"),
                fallback=original.model_id,
                operation=operation,
                trace_id=trace_id,
            ),
            temperature=self._normalize_float(
                field="temperature",
                value=data.get("temperature"),
                default=original.temperature,
                minimum=0.0,
                maximum=2.0,
                operation=operation,
                trace_id=trace_id,
            ),
            top_p=self._normalize_float(
                field="top_p",
                value=data.get("top_p"),
                default=original.top_p,
                minimum=0.0,
                maximum=1.0,
                operation=operation,
                trace_id=trace_id,
            ),
            frequency_penalty=self._normalize_float(
                field="frequency_penalty",
                value=data.get("frequency_penalty"),
                default=original.frequency_penalty,
                minimum=-2.0,
                maximum=2.0,
                operation=operation,
                trace_id=trace_id,
            ),
            presence_penalty=self._normalize_float(
                field="presence_penalty",
                value=data.get("presence_penalty"),
                default=original.presence_penalty,
                minimum=-2.0,
                maximum=2.0,
                operation=operation,
                trace_id=trace_id,
            ),
            reasoning_cost=self._normalize_float(
                field="reasoning_cost",
                value=data.get("reasoning_cost"),
                default=original.reasoning_cost,
                minimum=_REASONING_COST_RANGE[0],
                maximum=_REASONING_COST_RANGE[1],
                operation=operation,
                trace_id=trace_id,
            ),
            created_at=original.created_at,
            updated_at=now,
            schema_version=original.schema_version,
        )

    def _normalize_string(
        self,
        *,
        field: str,
        value: Optional[object],
        fallback: str,
        operation: str,
        trace_id: Optional[str],
    ) -> str:
        if value is None:
            return fallback
        normalized = str(value).strip()
        if not normalized:
            self._logger.warning(
                "Строковой параметр агента пуст, используется значение по умолчанию",
                extra=extra_with_context(operation=operation, field=field, status="fallback", trace_id=trace_id),
            )
            return fallback
        return normalized

    def _normalize_float(
        self,
        *,
        field: str,
        value: Optional[object],
        default: float,
        minimum: float,
        maximum: float,
        operation: str,
        trace_id: Optional[str],
    ) -> float:
        if value is None:
            return float(default)
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            self._logger.warning(
                "Невозможно преобразовать значение числового параметра агента",
                extra=extra_with_context(operation=operation, field=field, status="invalid", trace_id=trace_id),
            )
            raise ValueError(f"Invalid value for {field}")
        if parsed < minimum or parsed > maximum:
            self._logger.warning(
                "Значение параметра агента вне допустимого диапазона",
                extra=extra_with_context(
                    operation=operation,
                    field=field,
                    status="out_of_range",
                    trace_id=trace_id,
                    minimum=minimum,
                    maximum=maximum,
                ),
            )
            raise ValueError(f"{field} must be between {minimum} and {maximum}")
        return parsed
