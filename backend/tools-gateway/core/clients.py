from __future__ import annotations

import asyncio
import logging
from typing import Optional

import httpx
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from neo4j import Driver, GraphDatabase
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from .config import settings

_lock = asyncio.Lock()

_engine: Optional[Engine] = None
_driver: Optional[Driver] = None
_http_client: Optional[httpx.AsyncClient] = None


_mongo_client: Optional[AsyncIOMotorClient] = None

logger = logging.getLogger("tools-gateway.mongo")


async def get_mongo_client() -> AsyncIOMotorClient:
    global _mongo_client
    if _mongo_client is not None:
        return _mongo_client
    if not settings.MONGO_URI:
        raise RuntimeError("MONGO_URI is not configured")

    async with _lock:
        if _mongo_client is None:
            safe_host = settings.MONGO_URI.split("@")[-1] if "@" in settings.MONGO_URI else settings.MONGO_URI
            try:
                _mongo_client = AsyncIOMotorClient(
                    settings.MONGO_URI,
                    serverSelectionTimeoutMS=settings.MONGO_SERVER_SELECTION_TIMEOUT_MS,
                    appname=settings.MONGO_APPNAME,
                    uuidRepresentation="standard",
                )
                logger.info("[Mongo] Клиент инициализирован (host=%s, app=%s)", safe_host, settings.MONGO_APPNAME)
            except Exception:
                logger.exception("[Mongo] Ошибка инициализации клиента (host=%s, app=%s)", safe_host, settings.MONGO_APPNAME)
                raise
    return _mongo_client


async def get_mongo_database() -> AsyncIOMotorDatabase:
    client = await get_mongo_client()
    if not settings.MONGO_DB:
        raise RuntimeError("MONGO_DB is not configured")
    return client[settings.MONGO_DB]


async def shutdown_mongo_client() -> None:
    """Вызывайте из общих хук-процедур graceful shutdown (например, в FastAPI lifespan)."""
    global _mongo_client
    if _mongo_client is not None:
        _mongo_client.close()
        _mongo_client = None


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = create_engine(settings.PG_CONN, pool_pre_ping=True)
    return _engine


def get_neo4j_driver() -> Driver:
    global _driver
    if _driver is None:
        _driver = GraphDatabase.driver(
            settings.NEO4J_URI,
            auth=(settings.NEO4J_USER, settings.NEO4J_PASSWORD),
        )
    return _driver


async def ensure_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is not None:
        return _http_client

    async with _lock:
        if _http_client is None:
            timeout = httpx.Timeout(
                settings.HTTPX_TIMEOUT_SECONDS,
                connect=30.0,
                read=settings.HTTPX_TIMEOUT_SECONDS,
                write=settings.HTTPX_TIMEOUT_SECONDS,
            )
            _http_client = httpx.AsyncClient(timeout=timeout)
    return _http_client


async def shutdown_http_client() -> None:
    global _http_client
    if _http_client is not None:
        await _http_client.aclose()
        _http_client = None


def dispose_engine() -> None:
    global _engine
    if _engine is not None:
        _engine.dispose()
        _engine = None


def close_neo4j_driver() -> None:
    global _driver
    if _driver is not None:
        _driver.close()
        _driver = None
