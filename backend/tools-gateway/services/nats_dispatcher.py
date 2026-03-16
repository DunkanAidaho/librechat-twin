from __future__ import annotations

import asyncio
import gzip
import json
import logging
from typing import Any, Awaitable, Callable, Dict, Optional, TYPE_CHECKING

from nats.aio.client import Client as NATS
from nats.js import JetStreamContext
from nats.js.api import (
    AckPolicy,
    ConsumerConfig,
    DeliverPolicy,
    RetentionPolicy,
    StorageType,
    StreamConfig,
)
from nats.errors import (
    ConnectionClosedError,
    NoRespondersError,
    TimeoutError,
)
from pydantic import ValidationError

from core.config import settings
from services.status_store import add_event
from models.pydantic_models import (
    TemporalGraphRequest,
    TemporalMemoryRequest,
    TemporalSummaryRequest,
)
from services.workflow_launcher import (
    start_graph_workflow,
    start_memory_workflow,
    start_summary_workflow,
)

if TYPE_CHECKING:
    from nats.js import JetStreamSubscription
else:
    JetStreamSubscription = Any  # type: ignore[misc,assignment]

logger = logging.getLogger("tools-gateway.nats")
_active_dispatcher: Optional["NatsDispatcher"] = None


def get_active_dispatcher() -> Optional["NatsDispatcher"]:
    return _active_dispatcher


async def publish_status_event(payload: Dict[str, Any]) -> None:
    dispatcher = get_active_dispatcher()
    add_event(payload)
    if dispatcher:
        await dispatcher.publish_status(payload)


class NatsDispatcher:
    def __init__(self) -> None:
        self._nc: Optional[NATS] = None
        self._js: Optional[JetStreamContext] = None
        self._subscriptions: list[Any] = []
        self._closing = False

    async def start(self) -> None:
        global _active_dispatcher
        if not settings.NATS_ENABLED:
            logger.info("[NATS] Dispatcher отключён настройками.")
            return

        servers = [server.strip() for server in settings.NATS_SERVERS.split(",") if server.strip()]
        if not servers:
            raise RuntimeError("NATS_ENABLED=true, но NATS_SERVERS пуст.")

        self._nc = NATS()

        connect_kwargs: Dict[str, Any] = {
            "servers": servers,
            "max_reconnect_attempts": -1,
            "reconnect_time_wait": settings.NATS_RECONNECT_WAIT_SECONDS,
        }
        if settings.NATS_USER:
            connect_kwargs["user"] = settings.NATS_USER
        if settings.NATS_PASSWORD:
            connect_kwargs["password"] = settings.NATS_PASSWORD

        logger.info("[NATS] Подключаемся к серверам: %s", ", ".join(servers))
        try:
            await self._nc.connect(**connect_kwargs)
        except Exception as exc:
            logger.error("[NATS] Не удалось подключиться к серверам %s: %s", servers, exc)
            self._nc = None
            self._js = None
            return
        self._js = self._nc.jetstream()

        if settings.NATS_AUTOCREATE_STREAMS:
            await self._ensure_stream(
                settings.NATS_MEMORY_STREAM,
                settings.NATS_MEMORY_SUBJECT,
            )
            await self._ensure_stream(
                settings.NATS_SUMMARY_STREAM,
                settings.NATS_SUMMARY_SUBJECT,
            )
            await self._ensure_stream(
                settings.NATS_GRAPH_STREAM,
                settings.NATS_GRAPH_SUBJECT,
            )
            await self._ensure_stream(
                settings.NATS_STATUS_STREAM,
                settings.NATS_STATUS_SUBJECT,
            )

        tasks_to_start = []
        if settings.NATS_ENABLE_MEMORY:
            tasks_to_start.append(
                (
                    settings.NATS_MEMORY_STREAM,
                    settings.NATS_MEMORY_SUBJECT,
                    settings.NATS_MEMORY_DURABLE,
                    self._dispatch_memory,
                    "memory",
                )
            )
        if settings.NATS_ENABLE_SUMMARY:
            if settings.SUMMARY_WORKFLOWS_ENABLED:
                tasks_to_start.append(
                    (
                        settings.NATS_SUMMARY_STREAM,
                        settings.NATS_SUMMARY_SUBJECT,
                        settings.NATS_SUMMARY_DURABLE,
                        self._dispatch_summary,
                        "summary",
                    )
                )
            else:
                logger.info("[NATS] SUMMARY_WORKFLOWS_ENABLED=false — очередь summary не будет обрабатываться.")
        if settings.NATS_ENABLE_GRAPH:
            tasks_to_start.append(
                (
                    settings.NATS_GRAPH_STREAM,
                    settings.NATS_GRAPH_SUBJECT,
                    settings.NATS_GRAPH_DURABLE,
                    self._dispatch_graph,
                    "graph",
                )
            )

        for stream, subject, durable, handler, label in tasks_to_start:
            sub = await self._create_pull_subscription(
                stream=stream,
                subject=subject,
                durable=durable,
            )
            self._subscriptions.append(sub)
            asyncio.create_task(self._consume_loop(sub, handler, label))

        _active_dispatcher = self
        logger.info("[NATS] Dispatcher запущен. Активные очереди: %s", ", ".join(l for *_, l in tasks_to_start))

    async def stop(self) -> None:
        global _active_dispatcher
        self._closing = True
        logger.info("[NATS] Останавливаем dispatcher...")

        for sub in self._subscriptions:
            try:
                await sub.unsubscribe()
            except Exception:
                pass

        self._subscriptions.clear()

        if self._nc and self._nc.is_connected:
            try:
                await self._nc.draining()
            except AttributeError:
                await self._nc.drain()
            except Exception as exc:
                logger.warning("[NATS] Ошибка при drain(): %s", exc)

        self._nc = None
        self._js = None
        if _active_dispatcher is self:
            _active_dispatcher = None
        logger.info("[NATS] Dispatcher остановлен.")

    async def _ensure_stream(self, name: str, subject: str) -> None:
        assert self._js is not None

        try:
            await self._js.stream_info(name)
            return
        except Exception:
            logger.info("[NATS] Поток %s не найден, создаём.", name)

        config = StreamConfig(
            name=name,
            subjects=[subject],
            retention=RetentionPolicy.WORK_QUEUE,
            storage=StorageType.FILE,
            max_msgs=-1,
            max_msg_size=settings.NATS_MAX_MSG_SIZE_BYTES,
            num_replicas=settings.NATS_STREAM_REPLICAS,
        )
        await self._js.add_stream(config)
        logger.info("[NATS] Поток %s создан (subjects=%s).", name, subject)

    async def publish_status(self, payload: Dict[str, Any]) -> None:
        if not settings.NATS_ENABLED:
            return
        if not self._nc:
            return
        subject = settings.NATS_STATUS_SUBJECT
        try:
            await self._nc.publish(subject, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        except Exception as exc:
            logger.warning("[NATS] Не удалось опубликовать status событие: %s", exc)

    async def _create_pull_subscription(
        self,
        stream: str,
        subject: str,
        durable: str,
    ) -> Any:
        assert self._js is not None

        consumer_config = ConsumerConfig(
            durable_name=durable,
            deliver_policy=DeliverPolicy.ALL,
            ack_policy=AckPolicy.EXPLICIT,
            ack_wait=settings.NATS_ACK_WAIT_SECONDS,
            max_ack_pending=settings.NATS_MAX_INFLIGHT,
        )

        subscription = await self._js.pull_subscribe(
            subject=subject,
            stream=stream,
            durable=durable,
            config=consumer_config,
        )
        logger.info(
            "[NATS] Подписка оформлена: stream=%s subject=%s durable=%s",
            stream,
            subject,
            durable,
        )
        return subscription

    async def _consume_loop(
        self,
        subscription: JetStreamSubscription,
        handler: Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]],
        label: str,
    ) -> None:
        batch = max(1, settings.NATS_FETCH_BATCH)

        while not self._closing:
            try:
                messages = await subscription.fetch(batch=batch, timeout=1)
            except TimeoutError:
                continue
            except ConnectionClosedError:
                logger.warning("[NATS] Соединение закрыто, прекращаем чтение (%s).", label)
                break
            except NoRespondersError:
                logger.error("[NATS] Нет доступных нод JetStream (%s).", label)
                await asyncio.sleep(2.0)
                continue
            except Exception as exc:
                logger.exception("[NATS] Ошибка при fetch (%s): %s", label, exc)
                await asyncio.sleep(5.0)
                continue

            for msg in messages:
                if self._closing:
                    break
                await self._handle_message(msg, handler, label)

    async def _handle_message(
        self,
        msg,
        handler: Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]],
        label: str,
    ) -> None:
        data = msg.data
        headers = msg.headers or {}
        encoding = headers.get("content-encoding") or headers.get("Content-Encoding")

        if encoding and encoding.lower() == "gzip":
            try:
                data = gzip.decompress(data)
            except OSError as exc:
                logger.error("[NATS] Не удалось распаковать gzip (%s): %s", label, exc)
                await msg.term()
                return

        try:
            payload = json.loads(data.decode("utf-8"))
        except json.JSONDecodeError as exc:
            logger.error(
                "[NATS] Некорректный JSON, сообщение будет отброшено (%s): %s",
                label,
                exc,
            )
            await msg.ack()
            return

        try:
            result = await handler(payload)
        except ValidationError as exc:
            logger.error(
                "[NATS] Payload не прошёл валидацию, ack (stream=%s message=%s): %s",
                label,
                getattr(msg, "sequence", "<unknown>"),
                exc,
            )
            await msg.ack()
            return
        except Exception as exc:
            logger.exception("[NATS] Ошибка при обработке (stream=%s): %s", label, exc)
            await msg.nak()
            return

        status_raw = result.get("status")
        status = (status_raw or "").lower()
        success_statuses = {"started", "already_running", "success", "skipped", "skip"}
        retry_statuses = {"temporal_error", "failure", "error", "transport_error"}

        if status in success_statuses:
            await msg.ack()
        elif status in retry_statuses:
            logger.warning(
                "[NATS] Workflow вернул статус %s — сообщение возвращено в очередь (stream=%s, payload keys=%s)",
                status_raw,
                label,
                list(payload.keys()),
            )
            await msg.nak()
        else:
            logger.warning(
                "[NATS] Неизвестный статус %s (stream=%s, payload keys=%s) — ack для избежания зацикливания",
                status_raw,
                label,
                list(payload.keys()),
            )
            await msg.ack()

    async def _dispatch_memory(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        req = TemporalMemoryRequest(**payload)
        return await start_memory_workflow(req)

    async def _dispatch_summary(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        req = TemporalSummaryRequest(**payload)
        return await start_summary_workflow(req)

    async def _dispatch_graph(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        req = TemporalGraphRequest(**payload)
        return await start_graph_workflow(req)
