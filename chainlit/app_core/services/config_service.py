"""Configuration service for the Chainlit runtime.

This module mirrors the critical capabilities of the LibreChat ConfigService so
the Python side can operate on the same environment-driven settings.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

__all__ = [
    "CoreConfig",
    "FeaturesConfig",
    "ToolsGatewayConfig",
    "GraphContextConfig",
    "VectorContextConfig",
    "SummarizationConfig",
    "RagHistoryConfig",
    "RagConfig",
    "MemoryQueueConfig",
    "MemoryConfig",
    "TokenLimits",
    "LimitsConfig",
    "LoggingConfig",
    "PricingConfig",
    "AgentOperationConfig",
    "AgentOperationsConfig",
    "AgentsThresholds",
    "AgentsConfig",
    "AgentDefaultsConfig",
    "QueuesSubjects",
    "QueuesConfig",
    "DatastoresConfig",
    "LocalStoresConfig",
    "ConfigService",
    "config_service",
]

_TRUE_VALUES = {"1", "true", "yes", "on", "y", "t"}
_FALSE_VALUES = {"0", "false", "no", "off", "n", "f"}


def _sanitize_string(value: Optional[str]) -> Optional[str]:
    """Converts raw strings into trimmed values or ``None``."""
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _parse_bool(value: Any, default: bool = False) -> bool:
    """Parses truthy/falsy inputs in a predictable way."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in _TRUE_VALUES:
            return True
        if lowered in _FALSE_VALUES:
            return False
    return default


def _parse_int(value: Any, default: int = 0) -> int:
    """Safely parses integers, falling back to ``default`` when necessary."""
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _parse_float(value: Any, default: float = 0.0) -> float:
    """Safely parses floats, falling back to ``default`` when necessary."""
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def _parse_float_range(value: Any, default: float, minimum: float, maximum: float) -> float:
    """Parses floats and clamps the result to the specified range."""
    parsed = _parse_float(value, default)
    if parsed < minimum:
        return minimum
    if parsed > maximum:
        return maximum
    return parsed


def _camel_to_snake(name: str) -> str:
    """Converts camelCase keys into snake_case to match dataclass attributes."""
    if not name:
        return name
    buffer = []
    for char in name:
        if char.isupper():
            if buffer:
                buffer.append("_")
            buffer.append(char.lower())
        else:
            buffer.append(char)
    return "".join(buffer).replace("-", "_")


@dataclass(frozen=True)
class CoreConfig:
    """Core application parameters."""
    environment: str
    log_level: str
    server_domain: Optional[str]
    public_server_domain: Optional[str]


@dataclass(frozen=True)
class FeaturesConfig:
    """Feature toggles exposed to the Python runtime."""
    use_conversation_memory: bool
    headless_stream: bool
    debug_condense: bool
    branch_logging: bool
    use_ollama_for_titles: bool
    google_chain_buffer: str
    gemini_chain_window: int


@dataclass(frozen=True)
class ToolsGatewayConfig:
    """HTTP gateway config for tools/RAG services."""
    url: Optional[str]
    timeout_ms: int


@dataclass(frozen=True)
class GraphContextConfig:
    """Graph-context shaping limits."""
    max_lines: int
    max_line_chars: int
    request_timeout_ms: int
    summary_line_limit: int
    summary_hint_max_chars: int


@dataclass(frozen=True)
class VectorContextConfig:
    """Vector-context shaping limits."""
    max_chunks: int
    max_chars: int
    top_k: int
    embedding_model: str


@dataclass(frozen=True)
class SummarizationConfig:
    """RAG summarization parameters."""
    enabled: bool
    budget_chars: int
    chunk_chars: int
    provider: Optional[str]


@dataclass(frozen=True)
class RagHistoryConfig:
    """RAG history thresholds."""
    hist_long_user_to_rag: int
    assist_long_to_rag: int
    assist_snippet_chars: int
    ocr_to_rag_threshold: int
    wait_for_ingest_ms: int


@dataclass(frozen=True)
class RagConfig:
    """Aggregated RAG configuration."""
    cache_ttl: int
    gateway: ToolsGatewayConfig
    query_max_chars: int
    graph: GraphContextConfig
    vector: VectorContextConfig
    summarization: SummarizationConfig
    history: RagHistoryConfig


@dataclass(frozen=True)
class MemoryQueueConfig:
    """Memory queue tuning."""
    task_timeout_ms: int
    history_sync_batch_size: int


@dataclass(frozen=True)
class MemoryConfig:
    """Conversation memory configuration."""
    use_conversation_memory: bool
    enable_memory_cache: bool
    activation_threshold: int
    history_token_budget: int
    dont_shrink_last_n: int
    queue: MemoryQueueConfig
    graph_context: GraphContextConfig
    rag_query_max_chars: int


@dataclass(frozen=True)
class TokenLimits:
    """Token-limit parameters derived from env."""
    max_message_tokens: int
    truncate_long_messages: bool
    prompt_per_msg_max: int
    max_user_msg_chars: int
    dont_shrink_last_n: int


@dataclass(frozen=True)
class LimitsConfig:
    """Top-level limits, including per-request overrides."""
    request: Dict[str, int] = field(default_factory=dict)
    token: TokenLimits = field(default_factory=lambda: TokenLimits(0, True, 0, 0, 0))


@dataclass(frozen=True)
class LoggingConfig:
    """Logging-related switches."""
    level: str
    debug_sse: bool
    trace_pipeline: bool
    token_usage_report_mode: str
    token_breakdown_enabled: bool
    token_breakdown_level: str
    branch_enabled: bool
    branch_level: str


@dataclass(frozen=True)
class PricingConfig:
    """Remote pricing configuration (OpenRouter-based)."""
    api_key: Optional[str]
    url: str
    refresh_interval_sec: int
    cache_path: str


@dataclass(frozen=True)
class AgentOperationConfig:
    """Timeouts and retries for a specific agent operation."""
    timeout_ms: int
    retries: int


@dataclass(frozen=True)
class AgentOperationsConfig:
    """Group of configurable agent operations."""
    initialize_client: AgentOperationConfig
    send_message: AgentOperationConfig
    memory_queue: AgentOperationConfig
    summary_enqueue: AgentOperationConfig
    graph_enqueue: AgentOperationConfig
    save_convo: AgentOperationConfig


@dataclass(frozen=True)
class AgentsThresholds:
    """Agent-specific thresholds."""
    max_user_message_chars: int
    google_no_stream_threshold: int


@dataclass(frozen=True)
class AgentDefaultsConfig:
    """Default LLM parameters applied when creating a new agent."""
    model_id: Optional[str]
    system_prompt: Optional[str]
    temperature: float
    top_p: float
    frequency_penalty: float
    presence_penalty: float
    reasoning_cost: float


@dataclass(frozen=True)
class AgentsConfig:
    """Aggregated agent configuration."""
    retry_min_delay_ms: int
    retry_max_delay_ms: int
    retry_backoff_factor: float
    retry_jitter: float
    operations: AgentOperationsConfig
    thresholds: AgentsThresholds
    default_tokenizer_encoding: str
    titles_enabled: bool
    defaults: AgentDefaultsConfig


@dataclass(frozen=True)
class QueuesSubjects:
    """NATS/queue subjects used by downstream workers."""
    memory: Optional[str]
    graph: Optional[str]
    summary: Optional[str]
    delete: Optional[str]


@dataclass(frozen=True)
class DatastoresConfig:
    """External datastore configuration (Mongo, etc.)."""
    mongo_uri: str
    mongo_db: str

@dataclass(frozen=True)
class QueuesConfig:
    """Queue-related configuration."""
    tools_gateway_url: Optional[str]
    http_timeout_ms: int
    subjects: QueuesSubjects


@dataclass(frozen=True)
class LocalStoresConfig:
    """Filesystem locations for local JSON storage."""
    data_dir: Path
    agents_path: Path
    history_path: Path


class ConfigService:
    """Loads, caches and serves structured configuration sections."""

    def __init__(self, env_path: Optional[str] = None) -> None:
        self._env_path = Path(env_path or ".env")
        self._lock = threading.RLock()
        self._env: Dict[str, str] = {}
        self._sections: Dict[str, Any] = {}
        self.reload()

    def reload(self) -> None:
        """Reloads environment variables and rebuilds all sections."""
        with self._lock:
            self._env = self._load_env()
            self._sections = {
                "core": self._build_core(),
                "features": self._build_features(),
                "rag": self._build_rag(),
                "memory": self._build_memory(),
                "limits": self._build_limits(),
                "logging": self._build_logging(),
                "pricing": self._build_pricing(),
                "agents": self._build_agents(),
                "queues": self._build_queues(),
                "datastores": self._build_datastores(),
            }

    def get_section(self, name: str) -> Any:
        """Returns the requested section or raises ``KeyError``."""
        with self._lock:
            if name not in self._sections:
                raise KeyError(f"Unknown config section '{name}'")
            return self._sections[name]

    def list_sections(self) -> Dict[str, Any].keys:
        """Lists all available section names."""
        with self._lock:
            return self._sections.keys()

    def get(self, path: str, default: Any = None) -> Any:
        """Fetches a dotted-path value (e.g. ``'logging.debug_sse'``)."""
        if not path:
            return default
        section_name, *rest = path.split(".")
        try:
            value = self.get_section(section_name)
        except KeyError:
            return default
        for key in rest:
            if value is None:
                return default
            candidate = self._extract_value(value, key)
            value = candidate
        return default if value is None else value

    def get_boolean(self, path: str, default: bool = False) -> bool:
        """Convenience boolean getter."""
        return _parse_bool(self.get(path, default), default)

    def get_number(self, path: str, default: Optional[float] = None) -> Optional[float]:
        """Convenience numeric getter."""
        value = self.get(path, default)
        if isinstance(value, (int, float)):
            return value
        return _parse_float(value, default if default is not None else 0.0)

    # --- internal helpers -------------------------------------------------

    def _load_env(self) -> Dict[str, str]:
        """Loads process env merged with ``.env`` file (file values do not override)."""
        env = dict(os.environ)
        if self._env_path.exists():
            for line in self._env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                if key and key not in env:
                    env[key] = value.strip().strip('"').strip("'")
        return env

    def _env_str(self, key: str, default: Optional[str] = None) -> Optional[str]:
        return self._env.get(key, default)

    def _build_core(self) -> CoreConfig:
        return CoreConfig(
            environment=self._env_str("NODE_ENV", "development"),
            log_level=self._env_str("LOG_LEVEL", "info"),
            server_domain=_sanitize_string(self._env_str("SERVER_DOMAIN")),
            public_server_domain=_sanitize_string(self._env_str("PUBLIC_SERVER_DOMAIN")),
        )

    def _build_features(self) -> FeaturesConfig:
        return FeaturesConfig(
            use_conversation_memory=_parse_bool(self._env_str("USE_CONVERSATION_MEMORY"), False),
            headless_stream=_parse_bool(self._env_str("HEADLESS_STREAM"), False),
            debug_condense=_parse_bool(self._env_str("DEBUG_CONDENSE"), False),
            branch_logging=_parse_bool(self._env_str("ENABLE_BRANCH_LOGGING"), False),
            use_ollama_for_titles=_parse_bool(self._env_str("USE_OLLAMA_FOR_TITLES"), False),
            google_chain_buffer=(self._env_str("GOOGLE_CHAIN_BUFFER", "off") or "off").lower(),
            gemini_chain_window=_parse_int(self._env_str("GEMINI_CHAIN_WINDOW"), 5),
        )

    def _build_rag(self) -> RagConfig:
        graph_limit = _parse_int(self._env_str("GRAPH_CONTEXT_LINE_LIMIT"), 8)
        graph_summary_limit = _parse_int(self._env_str("GRAPH_CONTEXT_SUMMARY_LINE_LIMIT"), min(graph_limit, 8))
        gateway = ToolsGatewayConfig(
            url=_sanitize_string(self._env_str("TOOLS_GATEWAY_URL")),
            timeout_ms=_parse_int(self._env_str("TOOLS_GATEWAY_TIMEOUT_MS"), 20000),
        )
        graph = GraphContextConfig(
            max_lines=graph_limit,
            max_line_chars=_parse_int(self._env_str("GRAPH_CONTEXT_MAX_LINE_CHARS"), 200),
            request_timeout_ms=_parse_int(self._env_str("GRAPH_REQUEST_TIMEOUT_MS"), 10000),
            summary_line_limit=graph_summary_limit,
            summary_hint_max_chars=_parse_int(self._env_str("GRAPH_CONTEXT_SUMMARY_HINT_MAX_CHARS"), 2000),
        )
        vector = VectorContextConfig(
            max_chunks=_parse_int(self._env_str("RAG_VECTOR_MAX_CHUNKS"), 3),
            max_chars=_parse_int(self._env_str("RAG_VECTOR_MAX_CHARS"), 2000),
            top_k=_parse_int(self._env_str("RAG_CONTEXT_TOPK"), 12),
            embedding_model=_sanitize_string(self._env_str("RAG_SEARCH_MODEL")) or "mxbai",
        )
        summarization = SummarizationConfig(
            enabled=_parse_bool(self._env_str("RAG_SUMMARIZE_IF_OVER"), True),
            budget_chars=_parse_int(self._env_str("RAG_SUMMARY_BUDGET"), 12000),
            chunk_chars=_parse_int(self._env_str("RAG_CHUNK_CHARS"), 20000),
            provider=_sanitize_string(self._env_str("RAG_VECTOR_SUMMARY_PROVIDER")),
        )
        history = RagHistoryConfig(
            hist_long_user_to_rag=_parse_int(self._env_str("HIST_LONG_USER_TO_RAG"), 20000),
            assist_long_to_rag=_parse_int(self._env_str("ASSIST_LONG_TO_RAG"), 15000),
            assist_snippet_chars=_parse_int(self._env_str("ASSIST_SNIPPET_CHARS"), 1500),
            ocr_to_rag_threshold=_parse_int(self._env_str("OCR_TO_RAG_THRESHOLD"), 15000),
            wait_for_ingest_ms=_parse_int(self._env_str("WAIT_FOR_RAG_INGEST_MS"), 0),
        )
        return RagConfig(
            cache_ttl=_parse_int(self._env_str("RAG_CACHE_TTL"), 900),
            gateway=gateway,
            query_max_chars=_parse_int(self._env_str("RAG_QUERY_MAX_CHARS"), 6000),
            graph=graph,
            vector=vector,
            summarization=summarization,
            history=history,
        )

    def _build_memory(self) -> MemoryConfig:
        graph = self._build_rag().graph
        queue = MemoryQueueConfig(
            task_timeout_ms=_parse_int(self._env_str("MEMORY_TASK_TIMEOUT_MS"), 30000),
            history_sync_batch_size=_parse_int(self._env_str("HISTORY_SYNC_BATCH_SIZE"), 20),
        )
        dont_shrink_last_n = _parse_int(self._env_str("DONT_SHRINK_LAST_N"), 4)
        return MemoryConfig(
            use_conversation_memory=_parse_bool(self._env_str("USE_CONVERSATION_MEMORY"), True),
            enable_memory_cache=_parse_bool(self._env_str("ENABLE_MEMORY_CACHE"), True),
            activation_threshold=_parse_int(self._env_str("MEMORY_ACTIVATION_THRESHOLD"), 6),
            history_token_budget=_parse_int(self._env_str("HISTORY_TOKEN_BUDGET"), 8000),
            dont_shrink_last_n=dont_shrink_last_n,
            queue=queue,
            graph_context=graph,
            rag_query_max_chars=_parse_int(self._env_str("RAG_QUERY_MAX_CHARS"), 6000),
        )

    def _build_limits(self) -> LimitsConfig:
        request_limits: Dict[str, int] = {}
        for key, value in self._env.items():
            if key.startswith("LIMITS_REQUEST_"):
                limit_name = key.replace("LIMITS_REQUEST_", "", 1)
                parsed = _parse_int(value, None)
                if parsed and parsed > 0:
                    request_limits[limit_name] = parsed
        token_limits = TokenLimits(
            max_message_tokens=_parse_int(self._env_str("MAX_MESSAGE_TOKENS"), 0),
            truncate_long_messages=_parse_bool(self._env_str("TRUNCATE_LONG_MESSAGES"), True),
            prompt_per_msg_max=_parse_int(self._env_str("PROMPT_PER_MSG_MAX"), 0),
            max_user_msg_chars=_parse_int(self._env_str("MAX_USER_MSG_TO_MODEL_CHARS"), 0),
            dont_shrink_last_n=_parse_int(self._env_str("DONT_SHRINK_LAST_N"), 4),
        )
        return LimitsConfig(request=request_limits, token=token_limits)

    def _build_logging(self) -> LoggingConfig:
        return LoggingConfig(
            level=self._env_str("LOG_LEVEL", "info"),
            debug_sse=_parse_bool(self._env_str("DEBUG_SSE"), False),
            trace_pipeline=_parse_bool(self._env_str("TRACE_PIPELINE"), False),
            token_usage_report_mode=(self._env_str("TOKEN_USAGE_REPORT_MODE", "json") or "json").lower(),
            token_breakdown_enabled=_parse_bool(self._env_str("TOKEN_BREAKDOWN_ENABLED"), True),
            token_breakdown_level=self._env_str("TOKEN_BREAKDOWN_LEVEL", "info"),
            branch_enabled=_parse_bool(self._env_str("ENABLE_BRANCH_LOGGING"), False),
            branch_level=self._env_str("BRANCH_LOG_LEVEL", "info"),
        )

    def _build_pricing(self) -> PricingConfig:
        base_url = _sanitize_string(self._env_str("OPENROUTER_BASE_URL")) or "https://openrouter.ai/api/v1"
        normalized = base_url.rstrip("/")
        url = _sanitize_string(self._env_str("OPENROUTER_PRICING_URL")) or f"{normalized}/models/user"
        return PricingConfig(
            api_key=_sanitize_string(self._env_str("OPENROUTER_PRICING_API_KEY")),
            url=url,
            refresh_interval_sec=_parse_int(self._env_str("OPENROUTER_PRICING_REFRESH_SEC"), 86400),
            cache_path=_sanitize_string(self._env_str("OPENROUTER_PRICING_CACHE_PATH")) or "./api/cache/openrouter_pricing.json",
        )

    def _build_agents(self) -> AgentsConfig:
        def op(name: str, timeout_default: int, retries_default: int) -> AgentOperationConfig:
            return AgentOperationConfig(
                timeout_ms=_parse_int(self._env_str(f"AGENT_{name.upper()}_TIMEOUT_MS"), timeout_default),
                retries=_parse_int(
                    self._env_str(f"AGENT_{name.upper()}_RETRIES"),
                    _parse_int(self._env_str("AGENT_RETRY_ATTEMPTS"), retries_default),
                ),
            )

        operations = AgentOperationsConfig(
            initialize_client=op("init_client", 15000, 2),
            send_message=op("send_message", 120000, 1),
            memory_queue=op("memory_queue", 15000, 2),
            summary_enqueue=op("summary_en_queue", 15000, 2),
            graph_enqueue=op("graph_enqueue", 15000, 2),
            save_convo=op("save_convo", 10000, 1),
        )
        thresholds = AgentsThresholds(
            max_user_message_chars=_parse_int(self._env_str("MAX_USER_MSG_TO_MODEL_CHARS"), 200000),
            google_no_stream_threshold=_parse_int(self._env_str("GOOGLE_NOSTREAM_THRESHOLD"), 120000),
        )
        defaults = AgentDefaultsConfig(
            model_id=_sanitize_string(self._env_str("AGENT_DEFAULT_MODEL_ID")),
            system_prompt=_sanitize_string(self._env_str("AGENT_DEFAULT_SYSTEM_PROMPT")),
            temperature=_parse_float(self._env_str("AGENT_DEFAULT_TEMPERATURE"), 1.0),
            top_p=_parse_float(self._env_str("AGENT_DEFAULT_TOP_P"), 1.0),
            frequency_penalty=_parse_float(self._env_str("AGENT_DEFAULT_FREQUENCY_PENALTY"), 0.0),
            presence_penalty=_parse_float(self._env_str("AGENT_DEFAULT_PRESENCE_PENALTY"), 0.0),
            reasoning_cost=_parse_float_range(
                self._env_str("AGENT_DEFAULT_REASONING_COST"),
                0.0,
                0.0,
                100.0,
            ),
        )
        return AgentsConfig(
            retry_min_delay_ms=_parse_int(self._env_str("AGENT_RETRY_MIN_DELAY_MS"), 200),
            retry_max_delay_ms=_parse_int(self._env_str("AGENT_RETRY_MAX_DELAY_MS"), 2000),
            retry_backoff_factor=_parse_float(self._env_str("AGENT_RETRY_BACKOFF_FACTOR"), 2.0),
            retry_jitter=_parse_float(self._env_str("AGENT_RETRY_JITTER"), 0.2),
            operations=operations,
            thresholds=thresholds,
            default_tokenizer_encoding=_sanitize_string(self._env_str("DEFAULT_TOKENIZER_ENCODING")) or "o200k_base",
            titles_enabled=_parse_bool(self._env_str("TITLE_CONVO"), True),
            defaults=defaults,
        )


    def _build_datastores(self) -> DatastoresConfig:
        uri = self._env_str("MONGO_URI")
        if not uri:
            raise ValueError("MONGO_URI must be configured for datastores.mongo_uri")
        db_name = self._env_str("MONGO_DB") or "LibreChat"
        return DatastoresConfig(mongo_uri=uri, mongo_db=db_name)

    def _build_storage(self) -> LocalStoresConfig:
        """Builds configuration for local JSON storage paths."""
        data_dir = Path(self._env_str("CHAINLIT_DATA_DIR") or "/app/data").expanduser()

        def _resolve_path(raw: Optional[str], default_name: str) -> Path:
            if raw:
                candidate = Path(raw).expanduser()
                if not candidate.is_absolute():
                    return data_dir / candidate
                return candidate
            return data_dir / default_name

        agents_path = _resolve_path(self._env_str("AGENTS_STORE_PATH"), "agents.json")
        history_path = _resolve_path(self._env_str("CHAT_HISTORY_STORE_PATH"), "chat_history.json")
        return LocalStoresConfig(
            data_dir=data_dir,
            agents_path=agents_path,
            history_path=history_path,
        )

    def _build_queues(self) -> QueuesConfig:
        subjects = QueuesSubjects(
            memory=_sanitize_string(self._env_str("NATS_MEMORY_SUBJECT")),
            graph=_sanitize_string(self._env_str("NATS_GRAPH_SUBJECT")),
            summary=_sanitize_string(self._env_str("NATS_SUMMARY_SUBJECT")),
            delete=_sanitize_string(self._env_str("NATS_DELETE_SUBJECT")),
        )
        return QueuesConfig(
            tools_gateway_url=_sanitize_string(self._env_str("TOOLS_GATEWAY_URL")),
            http_timeout_ms=_parse_int(self._env_str("TOOLS_GATEWAY_TIMEOUT_MS"), 15000),
            subjects=subjects,
        )

    def _extract_value(self, obj: Any, key: str) -> Any:
        """Resolves nested attributes/dict keys with camelCase fallback."""
        if obj is None:
            return None
        if isinstance(obj, Mapping):
            return obj.get(key)
        normalized = _camel_to_snake(key)
        if hasattr(obj, key):
            return getattr(obj, key)
        if hasattr(obj, normalized):
            return getattr(obj, normalized)
        return None


config_service = ConfigService()
