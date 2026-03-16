from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

from temporalio.client import Client

from core.config import settings

logger = logging.getLogger("tools-gateway.temporal-client")


@dataclass(frozen=True)
class TemporalClientSettings:
    host: str = getattr(settings, "TEMPORAL_HOST", "temporal")
    port: int = getattr(settings, "TEMPORAL_PORT", 7233)
    namespace: str = getattr(settings, "TEMPORAL_NAMESPACE", "default")
    graph_queue: str = getattr(settings, "TEMPORAL_GRAPH_QUEUE", "librechat-graph")
    memory_queue: str = getattr(settings, "TEMPORAL_MEMORY_QUEUE", "librechat-memory")
    summary_queue: str = getattr(settings, "TEMPORAL_SUMMARY_QUEUE", "librechat-summary")


temporal_settings = TemporalClientSettings()

_temporal_client: Optional[Client] = None
_client_lock = asyncio.Lock()


async def get_temporal_client() -> Client:
    global _temporal_client
    if _temporal_client:
        return _temporal_client

    async with _client_lock:
        if _temporal_client is None:
            target = f"{temporal_settings.host}:{temporal_settings.port}"
            try:
                _temporal_client = await Client.connect(
                    target,
                    namespace=temporal_settings.namespace,
                )
                logger.info("[TemporalClient] Успешно подключено к Temporal по адресу %s", target)
            except Exception as e:
                logger.error("[TemporalClient] Ошибка подключения к Temporal по адресу %s: %s", target, e, exc_info=True)
                raise # Перебрасываем исключение, чтобы вызывающий код обработал его

    return _temporal_client


async def shutdown_temporal_client() -> None:
    global _temporal_client
    if _temporal_client:
        try:
            await _temporal_client.close()
            logger.info("[TemporalClient] Клиент Temporal успешно закрыт.")
        except Exception as e:
            logger.error("[TemporalClient] Ошибка при закрытии клиента Temporal: %s", e, exc_info=True)
        finally:
            _temporal_client = None
