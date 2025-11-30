"""High-level agent manager integrating Chainlit session state."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import uuid4

import chainlit as cl

from app_core.services.agent_store import AgentRecord, AgentStore
from app_core.services.config_service import AgentDefaultsConfig, config_service
from app_core.utils.structured_logging import extra_with_context, get_logger, log_exception

__all__ = ["AgentDTO", "AgentManager"]

_LOGGER = get_logger(__name__)
_SESSION_ACTIVE_AGENT = "agent.active_id"


@dataclass(frozen=True)
class AgentDTO:
    """Serializable representation of an agent for UI consumption."""

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
    is_active: bool


class AgentManager:
    """Coordinates AgentStore operations and Chainlit session state."""

    def __init__(self, store: AgentStore) -> None:
        self._store = store
        self._defaults: AgentDefaultsConfig = config_service.get_section("agents").defaults

    async def bootstrap(self) -> None:
        """Ensures at least one agent exists in storage."""
        trace_id = self._generate_trace_id()
        agents = await self._store.list_agents(trace_id=trace_id)
        if agents:
            return
        payload = {
            "name": "Default agent",
            "system_prompt": self._defaults.system_prompt or "You are a helpful assistant.",
            "model_id": self._defaults.model_id or config_service.get("core.default_model_id", "openrouter/google/gemini-2.5-pro"),
            "temperature": self._defaults.temperature,
            "top_p": self._defaults.top_p,
            "frequency_penalty": self._defaults.frequency_penalty,
            "presence_penalty": self._defaults.presence_penalty,
            "reasoning_cost": self._defaults.reasoning_cost,
        }
        try:
            created = await self._store.create_agent(payload, trace_id=trace_id)
            _LOGGER.info(
                "Создан дефолтный агент",
                extra=extra_with_context(operation="bootstrap_agent", status="created", agent_id=created.agent_id, trace_id=trace_id),
            )
            self._set_active_agent_id(created.agent_id)
            _LOGGER.info(
                "Активирован дефолтный агент",
                extra=extra_with_context(operation="bootstrap_agent", status="activated", agent_id=created.agent_id, trace_id=trace_id),
            )
        except Exception as exc:
            log_exception(
                _LOGGER,
                "Не удалось создать дефолтного агента",
                exc,
                operation="bootstrap_agent",
                status="failed",
                trace_id=trace_id,
            )
            raise

    async def list_agents(self) -> List[AgentDTO]:
        """Returns all agents with active flag."""
        session_active = self._get_active_agent_id()
        trace_id = self._generate_trace_id()
        records = await self._store.list_agents(trace_id=trace_id)
        return [self._to_dto(record, session_active) for record in records]

    async def create_agent(self, payload: Dict[str, Any]) -> AgentDTO:
        """Creates a new agent from UI payload."""
        sanitized = self._normalize_payload(payload)
        trace_id = self._generate_trace_id()
        record = await self._store.create_agent(sanitized, trace_id=trace_id)
        dto = self._to_dto(record, self._get_active_agent_id())
        self._set_active_agent_id(dto.agent_id)
        _LOGGER.info(
            "Агент создан",
            extra=extra_with_context(operation="create_agent", status="success", agent_id=dto.agent_id, trace_id=trace_id),
        )
        return dto

    async def update_agent(self, agent_id: str, payload: Dict[str, Any]) -> AgentDTO:
        """Updates an existing agent."""
        sanitized = self._normalize_payload(payload)
        trace_id = self._generate_trace_id()
        try:
            record = await self._store.update_agent(agent_id, sanitized, trace_id=trace_id)
        except KeyError as exc:
            log_exception(
                _LOGGER,
                "Агент для обновления не найден",
                exc,
                operation="update_agent",
                status="not_found",
                agent_id=agent_id,
                trace_id=trace_id,
            )
            raise
        dto = self._to_dto(record, self._get_active_agent_id())
        if dto.is_active:
            self._set_active_agent_id(dto.agent_id)
        _LOGGER.info(
            "Агент обновлён",
            extra=extra_with_context(operation="update_agent", status="success", agent_id=agent_id, trace_id=trace_id),
        )
        return dto

    async def clone_agent(self, agent_id: str, *, name: Optional[str] = None) -> AgentDTO:
        """Duplicates agent configuration under a new identifier."""
        trace_id = self._generate_trace_id()
        try:
            record = await self._store.clone_agent(agent_id, new_name=name, trace_id=trace_id)
        except KeyError as exc:
            log_exception(
                _LOGGER,
                "Агент для клонирования не найден",
                exc,
                operation="clone_agent",
                status="not_found",
                agent_id=agent_id,
                trace_id=trace_id,
            )
            raise
        self._set_active_agent_id(record.agent_id)
        dto = self._to_dto(record, record.agent_id)
        _LOGGER.info(
            "Агент клонирован",
            extra=extra_with_context(operation="clone_agent", status="success", agent_id=record.agent_id, source_agent_id=agent_id, trace_id=trace_id),
        )
        return dto

    async def delete_agent(self, agent_id: str) -> None:
        """Removes an agent; reassigns active agent if necessary."""
        trace_id = self._generate_trace_id()
        try:
            await self._store.delete_agent(agent_id, trace_id=trace_id)
        except KeyError as exc:
            log_exception(
                _LOGGER,
                "Агент для удаления не найден",
                exc,
                operation="delete_agent",
                status="not_found",
                agent_id=agent_id,
                trace_id=trace_id,
            )
            raise
        if self._get_active_agent_id() == agent_id:
            await self._assign_fallback_agent(trace_id=trace_id)
        _LOGGER.info(
            "Агент удалён",
            extra=extra_with_context(operation="delete_agent", status="success", agent_id=agent_id, trace_id=trace_id),
        )

    async def activate_agent(self, agent_id: str) -> AgentDTO:
        """Marks specified agent as active in user session."""
        trace_id = self._generate_trace_id()
        record = await self._store.get_agent(agent_id, trace_id=trace_id)
        if record is None:
            raise KeyError(agent_id)
        self._set_active_agent_id(agent_id)
        dto = self._to_dto(record, agent_id)
        _LOGGER.info(
            "Активирован агент",
            extra=extra_with_context(operation="activate_agent", status="success", agent_id=agent_id, trace_id=trace_id),
        )
        return dto

    async def get_active_agent(self) -> Optional[AgentDTO]:
        """Returns currently active agent or None."""
        active_id = self._get_active_agent_id()
        if not active_id:
            return None
        trace_id = self._generate_trace_id()
        record = await self._store.get_agent(active_id, trace_id=trace_id)
        if record is None:
            await self._assign_fallback_agent(trace_id=trace_id)
            return await self.get_active_agent()
        return self._to_dto(record, active_id)

    async def _assign_fallback_agent(self, *, trace_id: str) -> None:
        records = await self._store.list_agents(trace_id=trace_id)
        if not records:
            await self.bootstrap()
            records = await self._store.list_agents(trace_id=trace_id)
        if records:
            self._set_active_agent_id(records[0].agent_id)
        else:
            self._clear_active_agent_id()

    def _normalize_payload(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "name": str(payload.get("name") or "Unnamed agent"),
            "system_prompt": str(payload.get("system_prompt") or self._defaults.system_prompt or ""),
            "model_id": str(payload.get("model_id") or self._defaults.model_id or ""),
            "temperature": self._safe_float(payload.get("temperature"), self._defaults.temperature),
            "top_p": self._safe_float(payload.get("top_p"), self._defaults.top_p),
            "frequency_penalty": self._safe_float(payload.get("frequency_penalty"), self._defaults.frequency_penalty),
            "presence_penalty": self._safe_float(payload.get("presence_penalty"), self._defaults.presence_penalty),
            "reasoning_cost": self._safe_float(payload.get("reasoning_cost"), self._defaults.reasoning_cost),
        }

    def _to_dto(self, record: AgentRecord, active_id: Optional[str]) -> AgentDTO:
        return AgentDTO(
            agent_id=record.agent_id,
            name=record.name,
            system_prompt=record.system_prompt,
            model_id=record.model_id,
            temperature=record.temperature,
            top_p=record.top_p,
            frequency_penalty=record.frequency_penalty,
            presence_penalty=record.presence_penalty,
            reasoning_cost=record.reasoning_cost,
            created_at=record.created_at,
            updated_at=record.updated_at,
            is_active=record.agent_id == active_id,
        )

    def _get_active_agent_id(self) -> Optional[str]:
        return cl.user_session.get(_SESSION_ACTIVE_AGENT)

    def _set_active_agent_id(self, agent_id: str) -> None:
        cl.user_session.set(_SESSION_ACTIVE_AGENT, agent_id)

    def _clear_active_agent_id(self) -> None:
        try:
            cl.user_session.delete(_SESSION_ACTIVE_AGENT)
        except (AttributeError, KeyError):
            cl.user_session.set(_SESSION_ACTIVE_AGENT, None)

    @staticmethod
    def _safe_float(value: Any, default: float) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _generate_trace_id() -> str:
        return uuid4().hex
