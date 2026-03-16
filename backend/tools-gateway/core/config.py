# tools-gateway/core/config.py
from functools import lru_cache
from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env",), env_prefix="", case_sensitive=False)
    MAX_CONTEXT_MESSAGES: Optional[int] = Field(default=None)
    MAX_CONTEXT_TOKENS: Optional[int] = Field(default=None)

    # Логирование
    TOOLS_GATEWAY_LOG_LEVEL: str = Field("INFO", env="TOOLS_GATEWAY_LOG_LEVEL")
    TOOLS_GATEWAY_ENV: str = Field("dev", env="TOOLS_GATEWAY_ENV")
    TOOLS_GATEWAY_AUTH_BYPASS_IN_DEV: bool = Field(False, env="TOOLS_GATEWAY_AUTH_BYPASS_IN_DEV")
    ENABLE_DEBUG_PAYLOAD_LOGGING: bool = Field(False, env="ENABLE_DEBUG_PAYLOAD_LOGGING")

    # Security / perimeter
    TOOLS_GATEWAY_SERVICE_TOKEN: Optional[str] = Field(None, env="TOOLS_GATEWAY_SERVICE_TOKEN")
    ENABLE_CYPHER_DEBUG: bool = Field(False, env="ENABLE_CYPHER_DEBUG")
    TOOLS_GATEWAY_TOOL_RATE_LIMIT_PER_MINUTE: int = Field(60, env="TOOLS_GATEWAY_TOOL_RATE_LIMIT_PER_MINUTE")

    # HTTP-клиент
    HTTPX_TIMEOUT_SECONDS: float = Field(420.0, env="HTTPX_TIMEOUT_SECONDS")
    TEI_REQUEST_TIMEOUT: Optional[float] = Field(None, env="TEI_REQUEST_TIMEOUT")

    # Попытки LLM
    MAX_LLM_ATTEMPTS: int = Field(4, env="MAX_LLM_ATTEMPTS")
    LLM_RETRY_DELAY_BASE: float = Field(2.0, env="LLM_RETRY_DELAY_BASE")
    LLM_MAX_CONCURRENCY: int = Field(4, env="LLM_MAX_CONCURRENCY")

    # TEI
    TEI_URL_MX: str = Field("http://10.10.23.2:8081/v1/embeddings", env="TEI_URL_MX")
    TEI_URL_E5: str = Field("http://10.10.23.2:8083/v1/embeddings", env="TEI_URL_E5")
    TEI_MAX_CHARS_PER_CHUNK: int = Field(400, env="TEI_MAX_CHARS_PER_CHUNK")
    TEI_EMBED_CONCURRENCY: int = Field(6, env="TEI_EMBED_CONCURRENCY")

    # Хранилища
    PG_CONN: str = Field(..., env="PG_CONN")
    # MongoDB (опционально)
    MONGO_URI: Optional[str] = Field(None, env="MONGO_URI")
    MONGO_DB: str = Field("LibreChat", env="MONGO_DB")
    NEO4J_URI: str = Field(..., env="NEO4J_URI")
    NEO4J_USER: str = Field(..., env="NEO4J_USER")
    NEO4J_PASSWORD: str = Field(..., env="NEO4J_PASSWORD")

    # LLM-варианты
    USE_OLLAMA_FOR_ENTITY_EXTRACTION: bool = Field(False, env="USE_OLLAMA_FOR_ENTITY_EXTRACTION")
    OLLAMA_URL: str = Field("http://172.16.15.219:11434", env="OLLAMA_URL")
    OLLAMA_ENTITY_EXTRACTION_MODEL_NAME: str = Field("gemma:7b-instruct", env="OLLAMA_ENTITY_EXTRACTION_MODEL_NAME")

    USE_OPENROUTER_FOR_ENTITY_EXTRACTION: bool = Field(True, env="USE_OPENROUTER_FOR_ENTITY_EXTRACTION")
    OPENROUTER_API_KEY: Optional[str] = Field(None, env="OPENROUTER_API_KEY")
    # Параметры суммаризации и MongoDB -------------------------------------
    SUMMARY_WORKFLOWS_ENABLED: bool = Field(True, env="SUMMARY_WORKFLOWS_ENABLED")
    SUMMARY_MESSAGE_BATCH_SIZE: int = Field(8, env="SUMMARY_MESSAGE_BATCH_SIZE")
    SUMMARY_MAX_BUFFER_MESSAGES: int = Field(32, env="SUMMARY_MAX_BUFFER_MESSAGES")
    SUMMARY_OPENROUTER_MODEL: str = Field("google/gemini-2.5-flash", env="SUMMARY_OPENROUTER_MODEL")
    SUMMARY_REQUEST_TIMEOUT_SECONDS: float = Field(120.0, env="SUMMARY_REQUEST_TIMEOUT_SECONDS")
    SUMMARY_RETRY_ATTEMPTS: int = Field(3, env="SUMMARY_RETRY_ATTEMPTS")
    SUMMARY_TEMPORAL_MAX_MESSAGE_CHARS: int = Field(512, env="SUMMARY_TEMPORAL_MAX_MESSAGE_CHARS")
    SUMMARY_TEMPORAL_MAX_MESSAGES: int = Field(0, env="SUMMARY_TEMPORAL_MAX_MESSAGES")
    SUMMARY_TEMPORAL_MAX_MESSAGES_BYTES: int = Field(450_000, env="SUMMARY_TEMPORAL_MAX_MESSAGES_BYTES")
    SUMMARY_TEMPORAL_MAX_PAYLOAD_BYTES: int = Field(800_000, env="SUMMARY_TEMPORAL_MAX_PAYLOAD_BYTES")
    SUMMARY_TEMPORAL_MAX_METADATA_BYTES: int = Field(64_000, env="SUMMARY_TEMPORAL_MAX_METADATA_BYTES")
    SUMMARY_MESSAGES_CONVERSATION_FIELD: str = Field("conversation_id", env="SUMMARY_MESSAGES_CONVERSATION_FIELD")
    SUMMARY_MESSAGES_ID_FIELD: str = Field("message_id", env="SUMMARY_MESSAGES_ID_FIELD")
    SUMMARY_MESSAGES_ROLE_FIELD: str = Field("role", env="SUMMARY_MESSAGES_ROLE_FIELD")
    SUMMARY_MESSAGES_CONTENT_FIELD: str = Field("content", env="SUMMARY_MESSAGES_CONTENT_FIELD")
    SUMMARY_MESSAGES_CREATED_AT_FIELD: str = Field("created_at", env="SUMMARY_MESSAGES_CREATED_AT_FIELD")
    MONGO_MESSAGES_COLLECTION: str = Field("messages", env="MONGO_MESSAGES_COLLECTION")
    ENABLE_CONTENT_DATES_BACKFILL: bool = Field(
        False,
        env="ENABLE_CONTENT_DATES_BACKFILL",
        description="Run startup backfill to populate content_dates from chunk content.",
    )
    MONGO_SUMMARIES_COLLECTION: str = Field("conversation_summaries", env="MONGO_SUMMARIES_COLLECTION")
    SUMMARY_OPENROUTER_MODEL_PRIMARY: str = Field(
        "mistralai/mistral-small-3.2-24b-instruct:free",
        env="SUMMARY_OPENROUTER_MODEL_PRIMARY",
    )
    SUMMARY_OPENROUTER_MODEL_FALLBACK: str = Field(
        "deepseek/deepseek-chat-v3.1",
        env="SUMMARY_OPENROUTER_MODEL_FALLBACK",
    )
    SUMMARY_OPENROUTER_MODEL_PREMIUM: str = Field(
        "openai/gpt-4o-mini",
        env="SUMMARY_OPENROUTER_MODEL_PREMIUM",
    )
    GRAPH_PREMIUM_THRESHOLD_CHARS: int = Field(120_000, env="GRAPH_PREMIUM_THRESHOLD_CHARS")
    SUMMARY_PREMIUM_THRESHOLD_CHARS: int = Field(80_000, env="SUMMARY_PREMIUM_THRESHOLD_CHARS")
    FORCE_ALL_TO_PREMIUM: bool = Field(False, env="FORCE_ALL_TO_PREMIUM")
    MONGO_SERVER_SELECTION_TIMEOUT_MS: int = Field(5000, env="MONGO_SERVER_SELECTION_TIMEOUT_MS")
    MONGO_APPNAME: str = Field("tools-gateway", env="MONGO_APPNAME")
    OPENROUTER_BASE_URL: str = Field("https://openrouter.ai/api", env="OPENROUTER_BASE_URL")
    OPENROUTER_MODEL_PRIMARY: str = Field("mistralai/mistral-nemo:free", env="OPENROUTER_MODEL_PRIMARY")
    OPENROUTER_MODEL_FALLBACK: str = Field("qwen/qwen3-14b", env="OPENROUTER_MODEL_FALLBACK")
    OPENROUTER_MODEL_PREMIUM: str = Field("openai/gpt-4o-mini", env="OPENROUTER_MODEL_PREMIUM")
    OPENROUTER_MAX_REQUESTS_PER_MIN: int = Field(10, env="OPENROUTER_MAX_REQUESTS_PER_MIN")

    # NATS / JetStream
    NATS_ENABLED: bool = Field(False, env="NATS_ENABLED")
    NATS_SERVERS: str = Field("nats://localhost:4222", env="NATS_SERVERS")
    NATS_USER: Optional[str] = Field(None, env="NATS_USER")
    NATS_PASSWORD: Optional[str] = Field(None, env="NATS_PASSWORD")
    NATS_RECONNECT_WAIT_SECONDS: float = Field(2.0, env="NATS_RECONNECT_WAIT_SECONDS")
    NATS_ACK_WAIT_SECONDS: float = Field(60.0, env="NATS_ACK_WAIT_SECONDS")
    NATS_MAX_INFLIGHT: int = Field(16, env="NATS_MAX_INFLIGHT")
    NATS_FETCH_BATCH: int = Field(4, env="NATS_FETCH_BATCH")
    NATS_AUTOCREATE_STREAMS: bool = Field(True, env="NATS_AUTOCREATE_STREAMS")
    NATS_STREAM_REPLICAS: int = Field(3, env="NATS_STREAM_REPLICAS")
    NATS_MAX_MSG_SIZE_BYTES: int = Field(64_000_000, env="NATS_MAX_MSG_SIZE_BYTES")
    NATS_ENABLE_MEMORY: bool = Field(True, env="NATS_ENABLE_MEMORY")
    NATS_ENABLE_SUMMARY: bool = Field(True, env="NATS_ENABLE_SUMMARY")
    NATS_ENABLE_GRAPH: bool = Field(True, env="NATS_ENABLE_GRAPH")
    NATS_MEMORY_STREAM: str = Field("memory", env="NATS_MEMORY_STREAM")
    NATS_MEMORY_SUBJECT: str = Field("tasks.memory", env="NATS_MEMORY_SUBJECT")
    NATS_MEMORY_DURABLE: str = Field("memory-dispatcher", env="NATS_MEMORY_DURABLE")
    NATS_SUMMARY_STREAM: str = Field("summary", env="NATS_SUMMARY_STREAM")
    NATS_SUMMARY_SUBJECT: str = Field("tasks.summary", env="NATS_SUMMARY_SUBJECT")
    NATS_SUMMARY_DURABLE: str = Field("summary-dispatcher", env="NATS_SUMMARY_DURABLE")
    NATS_GRAPH_STREAM: str = Field("graph", env="NATS_GRAPH_STREAM")
    NATS_GRAPH_SUBJECT: str = Field("tasks.graph", env="NATS_GRAPH_SUBJECT")
    NATS_GRAPH_DURABLE: str = Field("graph-dispatcher", env="NATS_GRAPH_DURABLE")
    NATS_STATUS_STREAM: str = Field("status", env="NATS_STATUS_STREAM")
    NATS_STATUS_SUBJECT: str = Field("status.summary", env="NATS_STATUS_SUBJECT")
    # Vertex AI
    GCP_PROJECT_ID: Optional[str] = Field(None, env="GCP_PROJECT_ID")
    GCP_LOCATION: Optional[str] = Field(None, env="GCP_LOCATION")
    ENTITY_EXTRACTION_MODEL_NAME: str = Field("gemini-2.5-flash", env="ENTITY_EXTRACTION_MODEL_NAME")
    VERTEX_MAX_REQUESTS_PER_MIN: int = Field(4, env="VERTEX_MAX_REQUESTS_PER_MIN")

    # Графовый контекст
    GRAPH_CONTEXT_RELATION_LIMIT: int = Field(40, env="GRAPH_CONTEXT_RELATION_LIMIT")
    GRAPH_CONTEXT_LINE_LIMIT: int = Field(20, env="GRAPH_CONTEXT_LINE_LIMIT")
    GRAPH_CONTEXT_HINT_MAX_CHARS: int = Field(2000, env="GRAPH_CONTEXT_HINT_MAX_CHARS")

    # Путь для хранения некорректных JSON
    FAILED_JSON_BASE_DIR: Path = Path("/app/logs/failed_json")

    # Ограничение payload для MemoryWorkflow
    MEMORY_TEMPORAL_MAX_PAYLOAD_BYTES: int = Field(524_288, env="MEMORY_TEMPORAL_MAX_PAYLOAD_BYTES")


@lru_cache()
def get_settings() -> Settings:
    settings = Settings()

    # Если TEI_REQUEST_TIMEOUT не задан, используем базовый таймаут
    if settings.TEI_REQUEST_TIMEOUT is None:
        settings.TEI_REQUEST_TIMEOUT = settings.HTTPX_TIMEOUT_SECONDS

    return settings


def is_production() -> bool:
    return settings.TOOLS_GATEWAY_ENV.strip().lower() in {"prod", "production"}


settings = get_settings()
