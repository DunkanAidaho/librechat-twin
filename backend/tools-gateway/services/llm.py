from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import httpx
import httpcore
from pydantic import ValidationError

from core.config import settings
from core.rate_limiters import MinuteRateLimiter
from models.pydantic_models import ExtractedEntity
from services.context_manager import ModelRoutingState, context_manager

logger = logging.getLogger("tools-gateway.llm")

# -----------------------------------------------------------------------------
# Константы конфигурации
# -----------------------------------------------------------------------------
MAX_LLM_ATTEMPTS = settings.MAX_LLM_ATTEMPTS
LLM_RETRY_DELAY_BASE = settings.LLM_RETRY_DELAY_BASE
MAX_CONTEXT_MESSAGES = getattr(settings, "MAX_CONTEXT_MESSAGES", 20) or 20
MAX_CONTEXT_TOKENS = getattr(settings, "MAX_CONTEXT_TOKENS", 200_000) or 200_000
GRAPH_PREMIUM_THRESHOLD_CHARS = getattr(settings, "GRAPH_PREMIUM_THRESHOLD_CHARS", 120_000)
FORCE_ALL_TO_PREMIUM = bool(getattr(settings, "FORCE_ALL_TO_PREMIUM", False))

USE_OLLAMA = settings.USE_OLLAMA_FOR_ENTITY_EXTRACTION
OLLAMA_URL = settings.OLLAMA_URL
OLLAMA_MODEL = settings.OLLAMA_ENTITY_EXTRACTION_MODEL_NAME

USE_OPENROUTER = settings.USE_OPENROUTER_FOR_ENTITY_EXTRACTION
OPENROUTER_BASE_URL = settings.OPENROUTER_BASE_URL
OPENROUTER_API_KEY = settings.OPENROUTER_API_KEY
OPENROUTER_MODEL_PRIMARY = settings.OPENROUTER_MODEL_PRIMARY
OPENROUTER_MODEL_FALLBACK = settings.OPENROUTER_MODEL_FALLBACK
OPENROUTER_MODEL_PREMIUM = settings.OPENROUTER_MODEL_PREMIUM

FAILED_JSON_BASE_DIR = Path(os.getenv("FAILED_JSON_BASE_DIR", "/tmp/failed_json"))
FAILED_JSON_BASE_DIR.mkdir(parents=True, exist_ok=True)

RELATION_FALLBACK_TYPE = "RELATED_TO"
RELATION_FACT_SUBTYPE_PREFIX = "Subtype: "

openrouter_limiter = MinuteRateLimiter(settings.OPENROUTER_MAX_REQUESTS_PER_MIN)
vertex_limiter = MinuteRateLimiter(settings.VERTEX_MAX_REQUESTS_PER_MIN)
GLOBAL_RATE_LIMITER = MinuteRateLimiter(120)

# -----------------------------------------------------------------------------
# Простейшая статистика для мониторинга
# -----------------------------------------------------------------------------
_llm_stats: Dict[str, int] = {
    "successful_invocations": 0,
    "failed_invocations": 0,
    "parse_errors": 0,
    "pydantic_errors": 0,
    "failed_payloads_saved": 0,
    "total_entities": 0,
}


def _bump_stat(key: str, delta: int = 1) -> None:
    _llm_stats[key] = _llm_stats.get(key, 0) + delta


def get_stats() -> Dict[str, int]:
    return dict(_llm_stats)


# -----------------------------------------------------------------------------
# Глобальные состояния клиентов
# -----------------------------------------------------------------------------
_global_http_client: Optional[httpx.AsyncClient] = None
_vertex_model: Optional[Any] = None


def set_http_client(client: httpx.AsyncClient) -> None:
    global _global_http_client
    _global_http_client = client
    logger.info("[LLM] httpx.AsyncClient установлен для LLM-пайплайна.")


def get_http_client() -> httpx.AsyncClient:
    if not _global_http_client:
        raise RuntimeError("httpx.AsyncClient не инициализирован (set_http_client).")
    return _global_http_client


def set_vertex_model(model: Any) -> None:
    global _vertex_model
    _vertex_model = model
    logger.info("[LLM] Vertex AI модель зарегистрирована.")


def get_vertex_model() -> Any:
    if not _vertex_model:
        raise RuntimeError("Vertex AI модель не инициализирована.")
    return _vertex_model


# -----------------------------------------------------------------------------
# Текстовая обработка и вспомогательные функции
# -----------------------------------------------------------------------------
REASONING_PATTERN = re.compile(
    r"(<think>.*?</think>|Thought:|Reasoning:|Chain of Thought:|Рассуждение:|Мысли:)",
    re.IGNORECASE | re.DOTALL,
)

GLOBAL_PRONOUNS = {
    "I", "YOU", "HE", "SHE", "WE", "THEY", "ME", "HIM", "HER", "US", "THEM",
    "Я", "ТЫ", "ОН", "ОНА", "МЫ", "ОНИ", "МЕНЯ", "МНЕ", "ЕГО", "ЕМУ", "ЕЙ",
    "НАМ", "НАС", "ИХ", "ВАМ", "ВАС",
}

PLACEHOLDER_TOKENS = {
    "USER",
    "ASSISTANT",
    "SYSTEM",
    "MODEL",
    "BOT",
    "AI",
    "CONVERSATION",
    "THINK",
    "REASONING",
    "<THINK>",
    "</THINK>",
    "<REASONING>",
    "</REASONING>",
}

VERB_SUFFIXES = ("ING", "ED", "ADO", "TION", "УЕМ", "ЕШЬ", "АТЬ", "ЕТЬ", "ТЬСЯ")
VERB_MARKERS = re.compile(
    r"\b(AM|IS|ARE|WAS|WERE|BE|BEEN|BEING|HAVE|HAS|HAD|DO|DOES|DID|WILL|WOULD|SHOULD|МОЖЕТ|БУДЕТ|ЯВЛЯЕТСЯ|БЫЛ|БЫЛИ|ЕСТЬ|ДЕЛАТЬ)\b",
    re.IGNORECASE,
)

ENTITY_TYPE_SYNONYMS = {
    "PERSONA": "PERSON",
    "INDIVIDUAL": "PERSON",
    "HUMAN": "PERSON",
    "COMPANY": "ORGANIZATION",
    "CORPORATION": "ORGANIZATION",
    "PARTY": "ORGANIZATION",
    "GOVERNMENT": "ORGANIZATION",
    "CITY": "LOCATION",
    "COUNTRY": "LOCATION",
    "REGION": "LOCATION",
    "PLACE": "LOCATION",
    "MEETING": "EVENT",
    "INCIDENT": "EVENT",
    "SUMMIT": "EVENT",
    "PLAN": "EVENT",
    "IDEA": "CONCEPT",
    "THEORY": "CONCEPT",
    "STRATEGY": "CONCEPT",
    "DEVICE": "OBJECT",
    "TOOL": "OBJECT",
    "SOFTWARE": "TECHNOLOGY",
    "CODEBASE": "TECHNOLOGY",
    "REPOSITORY": "TECHNOLOGY",
    "PATCH": "DOCUMENT",
    "PR": "DOCUMENT",
    "DECREE": "LAW",
    "SANCTION": "POLICY",
    "TARIFF": "POLICY",
    "CONTRACT": "DOCUMENT",
    "BOND": "FINANCIAL_INSTRUMENT",
    "STOCK": "FINANCIAL_INSTRUMENT",
    "ETF": "FINANCIAL_INSTRUMENT",
}

VALID_ENTITY_TYPES = {
    "PERSON",
    "ORGANIZATION",
    "LOCATION",
    "EVENT",
    "OBJECT",
    "CONCEPT",
    "PRODUCT",
    "DOCUMENT",
    "LAW",
    "TECHNOLOGY",
    "PROJECT",
    "FINANCIAL_INSTRUMENT",
    "POLICY",
    "REASONING",
}

RELATION_SYNONYMS = {
    "COLLABORATES_WITH": "COOPERATION",
    "PARTNERSHIP": "COOPERATION",
    "COOPERATES_WITH": "COOPERATION",
    "WORKS_FOR": "EMPLOYMENT",
    "EMPLOYED_BY": "EMPLOYMENT",
    "MANAGES": "EMPLOYMENT",
    "SUPERVISES": "MENTORSHIP",
    "MENTORS": "MENTORSHIP",
    "OWNS": "OWNERSHIP",
    "INVESTED_IN": "OWNERSHIP",
    "LOVES": "ROMANTIC_RELATIONSHIP",
    "MARRIED_TO": "FAMILY_RELATIONSHIP",
    "FRIEND_OF": "FRIENDSHIP",
    "HAS_SEX_WITH": "SEXUAL_RELATIONSHIP",
    "CRITICIZES": "CONFLICT",
    "OPPOSES": "CONFLICT",
    "ATTACKS": "CONFLICT",
    "SUPPORTS": "SUPPORTS",
    "ENDORSES": "SUPPORTS",
    "CITES": "REFERENCES",
    "QUOTES": "REFERENCES",
    "MENTIONS": "MENTIONED_IN",
    "DEPENDS_ON": "USES",
    "MERGED_INTO": "CODE_CHANGE",
    "FIXES": "BUG_FIX",
    "SANCTIONED": "POLICY_ACTION",
    "MANIPULATES": "MANIPULATION",
    "SIBLING_OF": "FAMILY_RELATIONSHIP",
    "PARENT_OF": "FAMILY_RELATIONSHIP",
    "CHILD_OF": "FAMILY_RELATIONSHIP",
    "SPOUSE_OF": "FAMILY_RELATIONSHIP",
}

VALID_RELATION_TYPES = {
    "EMPLOYMENT",
    "OWNERSHIP",
    "ROMANTIC_RELATIONSHIP",
    "SEXUAL_RELATIONSHIP",
    "FRIENDSHIP",
    "FAMILY_RELATIONSHIP",
    "MENTORSHIP",
    "MANIPULATION",
    "CONFLICT",
    "SUPPORTS",
    "COOPERATION",
    "MENTIONED_IN",
    "REFERENCES",
    "USES",
    "CODE_CHANGE",
    "BUG_FIX",
    "POLICY_ACTION",
    "DISCUSSION",
    "COMMUNICATION",
    "RELATED_TO",
}

CONTEXT_FLAG_KEYWORDS: Dict[str, List[str]] = {
    "relationships": ["любов", "отнош", "роман", "ревност", "интим", "sex"],
    "politics": ["правительств", "политик", "закон", "санкц", "эконом", "госдума"],
    "software": ["pull request", "commit", "git", "python", "docker", "temporal"],
    "finance": ["финанс", "доход", "расход", "кредит", "банк", "контракт"],
    "news": ["новост", "репортаж", "агентство", "сообщил", "заявил"],
}

# -----------------------------------------------------------------------------
# Служебные функции
# -----------------------------------------------------------------------------
def _is_force_premium_enabled() -> bool:
    return FORCE_ALL_TO_PREMIUM


def detect_context_flags(text: str, existing: Optional[Iterable[str]] = None) -> List[str]:
    flags = set(existing or [])
    lowered = (text or "").lower()
    if re.search(r"\b(USER|ASSISTANT|SYSTEM|MODEL)\s*:", text or "", flags=re.IGNORECASE):
        flags.add("embedded_transcript")
    if REASONING_PATTERN.search(text or ""):
        flags.add("contains_reasoning")
    if len(text or "") > 8_000:
        flags.add("oversized_attachment")
    for flag, keywords in CONTEXT_FLAG_KEYWORDS.items():
        if any(keyword in lowered for keyword in keywords):
            flags.add(flag)
    return list(flags)


def infer_domain(text: str, flags: Sequence[str]) -> str:
    if "relationships" in flags:
        return "relationships"
    if "software" in flags:
        return "software"
    if "politics" in flags:
        return "politics"
    if "finance" in flags:
        return "finance"
    if "news" in flags:
        return "news"
    lowered = text.lower()
    if any(keyword in lowered for keyword in CONTEXT_FLAG_KEYWORDS["relationships"]):
        return "relationships"
    if any(keyword in lowered for keyword in CONTEXT_FLAG_KEYWORDS["software"]):
        return "software"
    if any(keyword in lowered for keyword in CONTEXT_FLAG_KEYWORDS["politics"]):
        return "politics"
    if any(keyword in lowered for keyword in CONTEXT_FLAG_KEYWORDS["finance"]):
        return "finance"
    if any(keyword in lowered for keyword in CONTEXT_FLAG_KEYWORDS["news"]):
        return "news"
    return "general"


def extract_reasoning_block(content: str) -> Optional[str]:
    if not content:
        return None
    match = REASONING_PATTERN.search(content)
    return match.group(0) if match else None


def build_system_prompt(domain: str) -> str:
    base = (
        "You are an assistant extracting knowledge-graph entities and relationships from chat logs. "
        "Return STRICT JSON with keys `entities` and `relationships`. "
        "Do not include explanations."
    )
    extras = {
        "relationships": "Focus on interpersonal dynamics, emotional states, manipulations.",
        "software": "Focus on repositories, pull requests, bugs, code fixes, deployments.",
        "politics": "Focus on politicians, organizations, policies, economic actions.",
        "finance": "Focus on deals, contracts, instruments, investors, funding.",
        "news": "Focus on key facts, actors, and consequences mentioned in the report.",
    }
    if domain in extras:
        base = f"{base} {extras[domain]}"
    return base


def build_examples_section() -> str:
    return (
        "Example output:\n"
        "{\n"
        '  "entities": [\n'
        '    {"id": "alice", "name": "Alice", "entity_type": "PERSON", "attributes": {"role": "psychologist"}},\n'
        '    {"id": "bob", "name": "Bob", "entity_type": "PERSON", "attributes": {"emotion": "confused"}}\n'
        "  ],\n"
        '  "relationships": [\n'
        '    {\n'
        '      "subject_id": "alice",\n'
        '      "object_id": "bob",\n'
        '      "relation_type": "MANIPULATION",\n'
        '      "facts": ["Subtype: guidance", "Alice объяснила Бобу, как распознать манипуляции."],\n'
        '      "evidence": "Alice объяснила Бобу, как распознать манипуляции."\n'
        "    }\n"
        "  ]\n"
        "}\n"
    )


def build_user_prompt(
    conversation_id: str,
    message_id: str,
    text: str,
    reasoning: Optional[str],
    context_flags: Sequence[str],
) -> str:
    instructions = (
        "Rules:\n"
        "1. Use allowed entity types (PERSON, ORGANIZATION, LOCATION, EVENT, OBJECT, CONCEPT, PRODUCT, DOCUMENT, LAW, "
        "TECHNOLOGY, PROJECT, FINANCIAL_INSTRUMENT, POLICY, REASONING).\n"
        "2. Use allowed relationship types; if unsure, use RELATED_TO and specify subtype in facts.\n"
        "3. Each entity: {id, name, entity_type, attributes?}.\n"
        "4. Each relationship: {subject_id, object_id, relation_type, facts?, evidence?}.\n"
        "5. Output ONLY valid JSON object {\"entities\": [...], \"relationships\": [...]}.\n"
    )
    flags_block = f"Context flags: {list(context_flags)}\n" if context_flags else ""
    reasoning_block = f"\nReasoning hint:\n{reasoning}\n" if reasoning else ""
    return (
        f"{instructions}"
        f"{flags_block}"
        f"Conversation ID: {conversation_id}\n"
        f"Message ID: {message_id}\n\n"
        "Text:\n"
        f"{text}\n"
        f"{reasoning_block}"
        "\nRespond strictly with JSON."
    )


def _ensure_list(value: Optional[Any]) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def slugify_identifier(name: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "_", name.strip().lower())
    value = re.sub(r"_+", "_", value).strip("_")
    return value[:64] or f"entity_{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}"


def normalize_entity_type(entity: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    name = (entity.get("name") or "").strip()
    if not name:
        return None
    if name.upper() in GLOBAL_PRONOUNS:
        return None

    original_type = (entity.get("entity_type") or "").upper()
    normalized_type = ENTITY_TYPE_SYNONYMS.get(original_type, original_type)
    if normalized_type not in VALID_ENTITY_TYPES:
        return None

    entity_id = entity.get("id") or slugify_identifier(name)
    attributes = entity.get("attributes") or {}
    if not isinstance(attributes, dict):
        attributes = {}

    entity.update(
        {
            "id": entity_id,
            "entity_type": normalized_type,
            "attributes": attributes,
        }
    )
    return entity


def normalize_relationship(
    relationship: Dict[str, Any],
    valid_entity_ids: Sequence[str],
) -> Optional[Dict[str, Any]]:
    subject_id = relationship.get("subject_id")
    object_id = relationship.get("object_id")
    if not subject_id or not object_id:
        return None
    if subject_id not in valid_entity_ids or object_id not in valid_entity_ids:
        return None

    original_type = (relationship.get("relation_type") or "").upper()
    normalized_type = RELATION_SYNONYMS.get(original_type, original_type)
    if normalized_type not in VALID_RELATION_TYPES:
        facts = _ensure_list(relationship.get("facts"))
        facts.append(f"{RELATION_FACT_SUBTYPE_PREFIX}{original_type or 'unspecified'}")
        relationship["facts"] = facts
        normalized_type = RELATION_FALLBACK_TYPE

    evidence = relationship.get("evidence")
    if evidence and not isinstance(evidence, str):
        relationship["evidence"] = str(evidence)

    relationship["relation_type"] = normalized_type
    relationship["facts"] = _ensure_list(relationship.get("facts"))
    return relationship


def _store_failed_payload(
    conversation_id: str,
    message_id: str,
    model_used: str,
    raw_content: str,
    reason: str,
) -> None:
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
    file_name = FAILED_JSON_BASE_DIR / f"{conversation_id}_{message_id}_{timestamp}.json"
    try:
        payload = {
            "conversation_id": conversation_id,
            "message_id": message_id,
            "model_used": model_used,
            "reason": reason,
            "content": raw_content,
        }
        file_name.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.warning("[LLM] Сохранили проблемный ответ в %s (%s)", file_name, reason)
        _bump_stat("failed_payloads_saved")
    except Exception as exc:  # noqa: BLE001
        logger.error("[LLM] Не удалось сохранить невалидный ответ: %s", exc)


async def _gather_context_snippets(conversation_id: str, limit_messages: int = 5) -> List[str]:
    snippets: List[str] = []
    try:
        context = await context_manager.get_recent_messages(conversation_id=conversation_id, limit=limit_messages)
        for item in context or []:
            role = item.get("role", "assistant")
            content = item.get("content")
            if isinstance(content, list):
                text_parts = [
                    part.get("text", "")
                    for part in content
                    if isinstance(part, dict) and part.get("type") == "text"
                ]
                content = "\n".join(filter(None, text_parts))
            if isinstance(content, str) and content.strip():
                snippets.append(f"[{role}] {content.strip()}")
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[LLM] Не удалось получить последние сообщения (conv=%s): %s",
            conversation_id,
            exc,
        )
    return snippets


async def _build_messages(
    conversation_id: str,
    message_id: str,
    text: str,
    reasoning: Optional[str],
    context_flags: Sequence[str],
) -> List[Dict[str, str]]:
    domain = infer_domain(text, context_flags)
    system_prompt = build_system_prompt(domain)
    examples_section = build_examples_section()
    user_prompt = build_user_prompt(conversation_id, message_id, text, reasoning, context_flags)

    context_snippets = await _gather_context_snippets(conversation_id)
    if context_snippets:
        user_prompt = f"{user_prompt}\n\nRecent context:\n" + "\n".join(context_snippets[:MAX_CONTEXT_MESSAGES])

    return [
        {"role": "system", "content": system_prompt},
        {"role": "system", "content": examples_section},
        {"role": "user", "content": user_prompt},
    ]


# -----------------------------------------------------------------------------
# Вызов OpenRouter / Ollama / Vertex
# -----------------------------------------------------------------------------
async def _post_openrouter_with_remote_retries(
    client: httpx.AsyncClient,
    payload: Dict[str, Any],
    headers: Dict[str, str],
    timeout: float,
    message_id: str,
    model_name: str,
    state: ModelRoutingState,
    attempt: int,
    channel: str,
) -> httpx.Response:
    timeout_value = timeout
    for retry_index in range(3):
        try:
            return await client.post(
                f"{OPENROUTER_BASE_URL}/chat/completions",
                json=payload,
                headers=headers,
                timeout=timeout_value,
            )
        except (httpx.RemoteProtocolError, httpcore.RemoteProtocolError) as exc:
            if retry_index >= 2:
                logger.error(
                    "[LLM] RemoteProtocolError (channel=%s, state=%s, model=%s, message=%s, attempt=%d) — попытки исчерпаны",
                    channel,
                    state.value,
                    model_name,
                    message_id,
                    attempt,
                    exc_info=True,
                )
                raise
            timeout_value += 60.0
            backoff = 1.5 * (retry_index + 1)
            logger.warning(
                "[LLM] RemoteProtocolError (channel=%s, state=%s, model=%s) — увеличиваем timeout до %.1f c, ждём %.1f c",
                channel,
                state.value,
                model_name,
                timeout_value,
                backoff,
                exc_info=True,
            )
            await asyncio.sleep(backoff)


async def _call_openrouter_completion(
    client: httpx.AsyncClient,
    messages: Sequence[Dict[str, str]],
    message_id: str,
    attempt: int,
    channel: str,
    forced_state: Optional[ModelRoutingState] = None,
    allow_fallback_chain: bool = True,
) -> Tuple[str, ModelRoutingState, str]:
    state_to_try = forced_state or await context_manager.get_model_state(channel=channel)
    if state_to_try is None:
        state_to_try = ModelRoutingState.PRIMARY

    visited_states = set()
    while True:
        if state_to_try in visited_states:
            raise RuntimeError("OpenRouter fallback cycle detected.")
        visited_states.add(state_to_try)

        model_name = {
            ModelRoutingState.PRIMARY: OPENROUTER_MODEL_PRIMARY,
            ModelRoutingState.FALLBACK: OPENROUTER_MODEL_FALLBACK,
            ModelRoutingState.PREMIUM: OPENROUTER_MODEL_PREMIUM,
        }.get(state_to_try)
        if not model_name:
            raise RuntimeError(f"No model configured for state {state_to_try.value}")

        await openrouter_limiter.acquire()

        headers = {
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "HTTP-Referer": "https://twin.mentat.su",
            "X-Title": "TwinChat",
        }
        payload = {
            "model": model_name,
            "messages": messages,
            "temperature": 0.2,
            "top_p": 0.9,
            "max_tokens": 4096,
        }

        response = await _post_openrouter_with_remote_retries(
            client=client,
            payload=payload,
            headers=headers,
            timeout=settings.HTTPX_TIMEOUT_SECONDS,
            message_id=message_id,
            model_name=model_name,
            state=state_to_try,
            attempt=attempt,
            channel=channel,
        )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            if status_code in (429, 402) and allow_fallback_chain:
                next_state = {
                    ModelRoutingState.PRIMARY: ModelRoutingState.FALLBACK,
                    ModelRoutingState.FALLBACK: ModelRoutingState.PREMIUM,
                    ModelRoutingState.PREMIUM: None,
                }[state_to_try]
                if next_state:
                    await context_manager.set_model_state(next_state, channel=channel)
                    delay = (LLM_RETRY_DELAY_BASE * 2) if status_code == 402 else LLM_RETRY_DELAY_BASE
                    logger.warning(
                        "[LLM] OpenRouter %s — переключаемся на %s, ждём %.1fs",
                        status_code,
                        next_state.value,
                        delay,
                    )
                    await asyncio.sleep(delay)
                    state_to_try = next_state
                    continue
            raise

        data = response.json()
        choices = data.get("choices") or []
        if not choices:
            raise RuntimeError("OpenRouter returned empty choices")
        content = choices[0]["message"]["content"]
        logger.info(
            "[LLM] OpenRouter response (channel=%s, state=%s, model=%s, message=%s, attempt=%d)",
            channel,
            state_to_try.value,
            model_name,
            message_id,
            attempt,
        )
        return content, state_to_try, model_name


async def _call_openrouter(
    messages: List[Dict[str, str]],
    conversation_id: str,
    message_id: str,
    attempt: int,
) -> Tuple[str, Dict[str, Any], str]:
    client = get_http_client()
    content, used_state, model_name = await _call_openrouter_completion(
        client=client,
        messages=messages,
        message_id=message_id,
        attempt=attempt,
        channel="graph",
    )
    return content, {"state": used_state, "model": model_name}, model_name


async def _call_ollama(
    messages: List[Dict[str, str]],
    conversation_id: str,
    message_id: str,
    attempt: int,
) -> Tuple[str, Dict[str, Any], str]:
    headers = {"Content-Type": "application/json"}
    payload = {
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "options": {"temperature": 0.2, "num_ctx": 8192},
    }
    async with httpx.AsyncClient(timeout=settings.HTTPX_TIMEOUT_SECONDS) as client:
        response = await client.post(f"{OLLAMA_URL}/api/chat", headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
    content = (data.get("message", {}).get("content") or "").strip()
    if not content:
        raise RuntimeError("Ollama returned empty content")
    return content, {"state": "ollama", "model": payload["model"]}, payload["model"]


async def _call_vertex(
    messages: List[Dict[str, str]],
) -> Tuple[str, Dict[str, Any], str]:
    await vertex_limiter.acquire()
    model = get_vertex_model()
    from vertexai.generative_models import Content, GenerationConfig, Part

    cfg = GenerationConfig(temperature=0.2, max_output_tokens=4096, response_mime_type="application/json")
    vertex_messages = []
    for item in messages:
        vertex_messages.append(Content(role=item["role"], parts=[Part.from_text(item["content"])]))
    response = await model.generate_content_async(vertex_messages, generation_config=cfg)
    content = response.candidates[0].content.parts[0].text
    return content, {"state": "vertex", "model": getattr(model, "model_name", "vertex")}, getattr(model, "model_name", "vertex")


# -----------------------------------------------------------------------------
# Парсинг и нормализация результатов LLM
# -----------------------------------------------------------------------------
def _parse_entities(data: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    entities_raw = _ensure_list(data.get("entities"))
    relationships_raw = _ensure_list(data.get("relationships"))

    normalized_entities: List[Dict[str, Any]] = []
    entity_ids: List[str] = []

    for entity in entities_raw:
        if not isinstance(entity, dict):
            continue
        normalized = normalize_entity_type(entity)
        if normalized:
            normalized_entities.append(normalized)
            entity_ids.append(normalized["id"])

    normalized_relationships: List[Dict[str, Any]] = []
    for relationship in relationships_raw:
        if not isinstance(relationship, dict):
            continue
        normalized_rel = normalize_relationship(relationship, entity_ids)
        if normalized_rel:
            normalized_relationships.append(normalized_rel)

    return normalized_entities, normalized_relationships


def _dedupe_entities(entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen: Dict[str, Dict[str, Any]] = {}
    for entity in entities:
        entity_id = entity["id"]
        existing = seen.get(entity_id)
        if existing:
            existing_attrs = existing.get("attributes") or {}
            new_attrs = entity.get("attributes") or {}
            existing["attributes"] = {**existing_attrs, **new_attrs}
        else:
            seen[entity_id] = entity
    return list(seen.values())


def _convert_to_pydantic(
    entities: List[Dict[str, Any]],
    relationships: List[Dict[str, Any]],
) -> List[ExtractedEntity]:
    entity_by_id = {entity["id"]: entity for entity in entities}
    results: List[ExtractedEntity] = []

    for rel in relationships:
        subject_id = rel.get("subject_id")
        object_id = rel.get("object_id")
        if not subject_id or not object_id:
            continue

        subject = entity_by_id.get(subject_id)
        obj = entity_by_id.get(object_id)
        if not subject or not obj:
            continue

        relation_properties = {
            "facts": rel.get("facts") or [],
            "evidence": rel.get("evidence"),
        }
        relation_properties = {
            key: value
            for key, value in relation_properties.items()
            if value and (value if isinstance(value, (str, list, dict)) else True)
        }

        try:
            results.append(
                ExtractedEntity(
                    subject=subject.get("name"),
                    relation=rel.get("relation_type", RELATION_FALLBACK_TYPE),
                    object=obj.get("name"),
                    subject_type=subject.get("entity_type"),
                    object_type=obj.get("entity_type"),
                    relation_properties=relation_properties or None,
                    original_relation=rel.get("original_relation"),
                )
            )
        except ValidationError as exc:
            logger.warning(
                "[LLM] Ошибка валидации сущности: %s",
                exc,
                extra={"subject_id": subject_id, "object_id": object_id},
            )
            _bump_stat("pydantic_errors")

    return results


# -----------------------------------------------------------------------------
# Основной вызов LLM
# -----------------------------------------------------------------------------
@dataclass
class LLMInvocationResult:
    content: str
    parsed_json: Dict[str, Any]
    model_used: str
    metadata: Dict[str, Any]


async def _invoke_llm(
    messages: List[Dict[str, str]],
    conversation_id: str,
    message_id: str,
) -> LLMInvocationResult:
    await GLOBAL_RATE_LIMITER.acquire()
    providers: List[str] = []
    if USE_OPENROUTER and OPENROUTER_API_KEY:
        providers.append("openrouter")
    if USE_OLLAMA and OLLAMA_MODEL:
        providers.append("ollama")
    if not providers:
        providers.append("vertex")

    last_error: Optional[str] = None

    for attempt in range(1, MAX_LLM_ATTEMPTS + 1):
        for provider in providers:
            try:
                if provider == "openrouter":
                    content, meta, model_name = await _call_openrouter(messages, conversation_id, message_id, attempt)
                elif provider == "ollama":
                    content, meta, model_name = await _call_ollama(messages, conversation_id, message_id, attempt)
                else:
                    content, meta, model_name = await _call_vertex(messages)

                reasoning = extract_reasoning_block(content)
                if reasoning:
                    content = content.replace(reasoning, "").strip()
                parsed_json = json.loads(content)
                _bump_stat("successful_invocations")
                return LLMInvocationResult(content=content, parsed_json=parsed_json, model_used=model_name, metadata=meta)
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
                logger.warning(
                    "[LLM] Попытка %d (provider=%s) не удалась: %s",
                    attempt,
                    provider,
                    exc,
                    exc_info=True,
                )
                await asyncio.sleep(LLM_RETRY_DELAY_BASE * attempt)

    _bump_stat("failed_invocations")
    raise RuntimeError(last_error or "LLM invocation failed")


async def call_llm(
    text: str,
    reasoning: Optional[str],
    context_flags: Sequence[str],
    conversation_id: str,
    message_id: str,
    user_id: str,
) -> Tuple[List[ExtractedEntity], Optional[str]]:
    try:
        messages = await _build_messages(conversation_id, message_id, text, reasoning, context_flags)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[LLM] Ошибка подготовки prompt (conv=%s, msg=%s)", conversation_id, message_id)
        return [], f"prompt_build_failed:{exc}"

    try:
        llm_result = await _invoke_llm(messages, conversation_id, message_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[LLM] Ошибка вызова LLM (conv=%s, msg=%s)", conversation_id, message_id)
        return [], f"llm_invoke_failed:{exc}"

    raw_content = llm_result.content
    try:
        parsed_entities, parsed_relationships = _parse_entities(llm_result.parsed_json)
        parsed_entities = _dedupe_entities(parsed_entities)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[LLM] Ошибка парсинга ответа", exc_info=exc)
        _bump_stat("parse_errors")
        _store_failed_payload(
            conversation_id=conversation_id,
            message_id=message_id,
            model_used=llm_result.model_used,
            raw_content=raw_content,
            reason=f"parse_error:{exc}",
        )
        return [], f"parse_error:{exc}"

    try:
        entities_pydantic = _convert_to_pydantic(parsed_entities, parsed_relationships)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[LLM] Ошибка конвертации сущностей", exc_info=exc)
        _store_failed_payload(
            conversation_id=conversation_id,
            message_id=message_id,
            model_used=llm_result.model_used,
            raw_content=raw_content,
            reason=f"pydantic_conversion_error:{exc}",
        )
        return [], f"pydantic_conversion_error:{exc}"

    _bump_stat("total_entities", len(entities_pydantic))

    logger.info(
        "[LLM] Сущности извлечены",
        extra={
            "conversation_id": conversation_id,
            "message_id": message_id,
            "user_id": user_id,
            "model_used": llm_result.model_used,
            "entities_count": len(entities_pydantic),
        },
    )

    return entities_pydantic, None
