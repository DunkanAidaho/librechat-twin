from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import httpx
from pydantic import ValidationError

from core.config import settings
from core.rate_limiters import MinuteRateLimiter
from models.pydantic_models import ExtractedEntity
from services.context_manager import context_manager

logger = logging.getLogger("tools-gateway.llm")

# -----------------------------------------------------------------------------
# Общие константы / настройки
# -----------------------------------------------------------------------------
MAX_LLM_ATTEMPTS = settings.MAX_LLM_ATTEMPTS
LLM_RETRY_DELAY_BASE = settings.LLM_RETRY_DELAY_BASE
MAX_CONTEXT_MESSAGES = getattr(settings, "MAX_CONTEXT_MESSAGES", 20) or 20
MAX_CONTEXT_TOKENS = getattr(settings, "MAX_CONTEXT_TOKENS", 200_000) or 200_000

USE_OLLAMA = settings.USE_OLLAMA_FOR_ENTITY_EXTRACTION
OLLAMA_URL = settings.OLLAMA_URL
OLLAMA_MODEL = settings.OLLAMA_ENTITY_EXTRACTION_MODEL_NAME

USE_OPENROUTER = settings.USE_OPENROUTER_FOR_ENTITY_EXTRACTION
OPENROUTER_BASE_URL = settings.OPENROUTER_BASE_URL
OPENROUTER_API_KEY = settings.OPENROUTER_API_KEY
OPENROUTER_MODEL_PRIMARY = settings.OPENROUTER_MODEL_PRIMARY
OPENROUTER_MODEL_FALLBACK = settings.OPENROUTER_MODEL_FALLBACK

FAILED_JSON_BASE_DIR = Path(os.getenv("FAILED_JSON_BASE_DIR", "/tmp/failed_json"))
FAILED_JSON_BASE_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_RELATION_FALLBACK = "RELATED_TO"
RELATION_FALLBACK_TYPE = DEFAULT_RELATION_FALLBACK

json_parse_success_count = 0
json_parse_failure_count = 0
json_parse_errors: List[Dict[str, Any]] = []
original_relation_counter: Dict[str, int] = {}

REASONING_PATTERN = re.compile(
    r"(<think>.*?</think>|Thought:|Reasoning:|Chain of Thought:|Рассуждение:|Мысли:)",
    re.IGNORECASE | re.DOTALL,
)

GLOBAL_PRONOUNS = {
    "I", "YOU", "HE", "SHE", "WE", "THEY", "ME", "HIM", "HER", "US", "THEM",
    "Я", "ТЫ", "ОН", "ОНА", "МЫ", "ОНИ", "МЕНЯ", "МНЕ", "ЕГО", "ЕМУ", "ЕЙ",
    "НАМ", "НАС", "ИХ", "ВАМ", "ВАС", "ICH", "DU", "ER", "SIE", "ES",
    "WIR", "IHR", "MICH", "MIR", "DICH", "JE", "TU", "IL", "ELLE", "NOUS",
    "VOUS", "ILS", "ELLES",
}

PLACEHOLDER_TOKENS = {
    "USER",
    "ASSISTANT",
    "SYSTEM",
    "CONVERSATION",
    "THINK",
    "REASONING",
    "<THINK>",
    "</THINK>",
    "<REASONING>",
    "</REASONING>",
}

VALID_ENTITY_TYPES = {
    "PERSON",
    "ORGANIZATION",
    "LOCATION",
    "EVENT",
    "CONCEPT",
    "OBJECT",
    "PRODUCT",
    "DOCUMENT",
    "LAW",
    "TECHNOLOGY",
    "PROJECT",
    "FINANCIAL_INSTRUMENT",
    "POLICY",
}

ENTITY_TYPE_SYNONYMS = {
    "PERSONA": "PERSON",
    "INDIVIDUAL": "PERSON",
    "HUMAN": "PERSON",
    "COMPANY": "ORGANIZATION",
    "CORPORATION": "ORGANIZATION",
    "PARTY": "ORGANIZATION",
    "GOVERNMENT": "ORGANIZATION",
    "ADMINISTRATION": "ORGANIZATION",
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

VALID_RELATION_TYPES = {
    "AFFILIATION",
    "EMPLOYMENT",
    "OWNERSHIP",
    "ROMANTIC_RELATIONSHIP",
    "SEXUAL_RELATIONSHIP",
    "FRIENDSHIP",
    "FAMILY_RELATIONSHIP",
    "MENTORSHIP",
    "MANIPULATION",
    "ADVERSARIAL",
    "CONFLICT",
    "SUPPORTS",
    "COLLABORATION",
    "COALITION",
    "COMMUNICATION",
    "MENTIONED_IN",
    "AUTHORED",
    "REFERENCES",
    "DERIVED_FROM",
    "USES",
    "FINANCIAL_TRANSACTION",
    "POLICY_ACTION",
    "CODE_CHANGE",
    "BUG_FIX",
    "DISCUSSION",
}

RELATION_TYPE_SYNONYMS = {
    "COLLABORATES_WITH": "COLLABORATION",
    "PARTNERSHIP": "COLLABORATION",
    "COOPERATES_WITH": "COLLABORATION",
    "ALLIANCE": "COALITION",
    "WORKS_FOR": "EMPLOYMENT",
    "EMPLOYED_BY": "EMPLOYMENT",
    "MANAGES": "EMPLOYMENT",
    "SUPERVISES": "MENTORSHIP",
    "MENTORS": "MENTORSHIP",
    "TEACHES": "MENTORSHIP",
    "OWNS": "OWNERSHIP",
    "INVESTED_IN": "OWNERSHIP",
    "FINANCES": "FINANCIAL_TRANSACTION",
    "LOVES": "ROMANTIC_RELATIONSHIP",
    "DATING": "ROMANTIC_RELATIONSHIP",
    "MARRIED_TO": "ROMANTIC_RELATIONSHIP",
    "PARTNERS": "ROMANTIC_RELATIONSHIP",
    "HAS_SEX_WITH": "SEXUAL_RELATIONSHIP",
    "INTIMATE_WITH": "SEXUAL_RELATIONSHIP",
    "CRUSH_ON": "ROMANTIC_RELATIONSHIP",
    "FRIEND_OF": "FRIENDSHIP",
    "SIBLING": "FAMILY_RELATIONSHIP",
    "PARENT": "FAMILY_RELATIONSHIP",
    "CHILD": "FAMILY_RELATIONSHIP",
    "SPOUSE": "FAMILY_RELATIONSHIP",
    "ANTAGONIST_OF": "ADVERSARIAL",
    "CRITICIZES": "CONFLICT",
    "OPPOSES": "CONFLICT",
    "ATTACKS": "CONFLICT",
    "ENDORSES": "SUPPORTS",
    "BACKS": "SUPPORTS",
    "CITES": "REFERENCES",
    "QUOTES": "REFERENCES",
    "MENTIONS": "MENTIONED_IN",
    "DEPENDS_ON": "USES",
    "MERGED_INTO": "CODE_CHANGE",
    "FIXES": "BUG_FIX",
    "PATCHES": "BUG_FIX",
    "COMMUNICATES_WITH": "COMMUNICATION",
    "SUMMONED": "POLICY_ACTION",
    "SANCTIONED": "POLICY_ACTION",
    "ASSESSED": "POLICY_ACTION",
    "DISCUSSING": "DISCUSSION",
    "DEBATES": "DISCUSSION",
    "INFLUENCES": "MANIPULATION",
    "MANIPULATES": "MANIPULATION",
}

CONTEXT_FLAG_KEYWORDS: Dict[str, List[str]] = {
    "relationships": [
        "любов", "отнош", "роман", "ревност", "манипуляц", "психолог",
        "знакомств", "семь", "чувств", "sex", "интим",
    ],
    "politics": [
        "правительств", "парламент", "закон", "санкц", "эконом",
        "инфляц", "бюджет", "президент", "премьер", "госдума",
        "министерств", "политик",
    ],
    "software": [
        "pull request", "commit", "git", "merge", "bug", "ticket",
        "issue", "deploy", "api", "config", "python", "javascript",
        "docker", "temporal", "llm", "prompt", "test", "pytest",
    ],
    "news": [
        "новост", "сообщил", "заявил", "агентство", "breaking",
        "репортаж", "интервью",
    ],
    "finance": [
        "отчёт", "баланс", "доход", "расход", "инвестиция", "кредит",
        "банк", "сделка", "контракт", "финанс",
    ],
}

RELATION_FACT_SUBTYPE_PREFIX = "Subtype: "
DEFAULT_DOMAIN = "general"

GLOBAL_RATE_LIMITER = MinuteRateLimiter(120)


@dataclass
class LLMInvocationResult:
    content: str
    parsed_json: Dict[str, Any]
    model_used: str
    reasoning: Optional[str]


def mask_sensitive_text(text: str) -> str:
    masked = text
    for token in PLACEHOLDER_TOKENS:
        masked = masked.replace(token, "***")
    return masked


def detect_context_flags(text: str, existing: Optional[Iterable[str]] = None) -> List[str]:
    flags: set[str] = set(existing or [])
    lowered = text.lower()
    for flag, keywords in CONTEXT_FLAG_KEYWORDS.items():
        if any(keyword in lowered for keyword in keywords):
            flags.add(flag)
    return list(flags)


def infer_domain(text: str, context_flags: Sequence[str]) -> str:
    lowered = text.lower()
    if "relationships" in context_flags or any(
        key in lowered for key in ["любов", "отнош", "роман", "манипуляц", "психолог", "интим"]
    ):
        return "relationships"
    if "software" in context_flags or any(
        key in lowered for key in ["pull request", "commit", "git", "python", "код", "config", "temporal"]
    ):
        return "software"
    if "politics" in context_flags or any(
        key in lowered for key in ["правительств", "политик", "закон", "санкц", "эконом", "инфляц"]
    ):
        return "politics"
    if "finance" in context_flags or any(
        key in lowered for key in ["финанс", "доход", "расход", "кредит", "банк", "сделка"]
    ):
        return "finance"
    if "news" in context_flags or any(
        key in lowered for key in ["новост", "сообщил", "заявил", "breaking", "агентство"]
    ):
        return "news"
    return DEFAULT_DOMAIN


def extract_reasoning_block(content: str) -> Optional[str]:
    if not content:
        return None
    match = REASONING_PATTERN.search(content)
    return match.group(0) if match else None


def build_system_prompt(domain: str) -> str:
    base = (
        "You are an enterprise knowledge-graph extraction assistant. "
        "Extract entities and relationships from conversational messages. "
        "Use only the allowed entity and relationship types. "
        "Return UTF-8 JSON with keys `entities` and `relationships`. "
        "If nothing relevant found, return empty arrays."
    )
    extra = {
        "relationships": (
            "Focus on psychological dynamics, manipulation patterns, emotions, romantic or sexual context."
        ),
        "politics": (
            "Focus on politicians, parties, institutions, policies, economic indicators, and their actions or statements."
        ),
        "software": (
            "Focus on repositories, pull requests, issues, code fixes, deployments, APIs, testing activities, refactoring."
        ),
        "finance": (
            "Focus on deals, contracts, instruments, investors, funding rounds, financial transactions."
        ),
        "news": (
            "Provide neutral extraction of people, organizations, locations, events and how they relate in the report."
        ),
    }.get(domain, "")
    return f"{base} {extra}" if extra else base


def build_examples_section() -> str:
    return (
        "Examples:\n"
        "1) Relationship dynamics:\n"
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
        "}\n\n"
        "2) Politics/economy:\n"
        "{\n"
        '  "entities": [\n'
        '    {"id": "pm", "name": "Премьер-министр", "entity_type": "PERSON"},\n'
        '    {"id": "budget2026", "name": "Федеральный бюджет 2026", "entity_type": "DOCUMENT"}\n'
        "  ],\n"
        '  "relationships": [\n'
        '    {\n'
        '      "subject_id": "pm",\n'
        '      "object_id": "budget2026",\n'
        '      "relation_type": "POLICY_ACTION",\n'
        '      "facts": ["Subtype: presentation", "Премьер-министр представил проект бюджета в парламенте."],\n'
        '      "evidence": "Премьер-министр заявил, что представил новый бюджет."\n'
        "    }\n"
        "  ]\n"
        "}\n\n"
        "3) Software development:\n"
        "{\n"
        '  "entities": [\n'
        '    {"id": "repo", "name": "payments-service", "entity_type": "TECHNOLOGY"},\n'
        '    {"id": "pr42", "name": "PR-42", "entity_type": "DOCUMENT"}\n'
        "  ],\n"
        '  "relationships": [\n'
        '    {\n'
        '      "subject_id": "pr42",\n'
        '      "object_id": "repo",\n'
        '      "relation_type": "CODE_CHANGE",\n'
        '      "facts": ["Subtype: tax rounding fix", "PR-42 исправляет округление НДС в payments-service."],\n'
        '      "evidence": "В PR-42 обновлён модуль расчёта НДС."\n'
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
        "1. Use only allowed entity types: PERSON, ORGANIZATION, LOCATION, EVENT, CONCEPT, OBJECT, PRODUCT, "
        "DOCUMENT, LAW, TECHNOLOGY, PROJECT, FINANCIAL_INSTRUMENT, POLICY.\n"
        "2. Use only allowed relationship types (see list). If unsure, map to RELATED_TO and describe subtype in facts.\n"
        "3. Each entity must have an `id`, `name`, `entity_type`, optional `attributes` dict.\n"
        "4. Each relationship must specify `subject_id`, `object_id`, `relation_type`, optional `facts`, `evidence`.\n"
        "5. Do not invent IDs. Use stable slugified names or provided IDs.\n"
        "6. Output must be valid JSON. No extra commentary.\n"
    )
    flags_section = f"Context flags: {list(context_flags)}\n" if context_flags else ""
    reasoning_excerpt = f"\nReasoning hint:\n{reasoning}\n" if reasoning else ""
    return (
        f"{instructions}"
        f"{flags_section}"
        f"Conversation ID: {conversation_id}\n"
        f"Message ID: {message_id}\n\n"
        "Text to analyze:\n"
        f"{text}\n"
        f"{reasoning_excerpt}"
        "\nRespond with JSON object {\"entities\": [...], \"relationships\": [...]}."
    )


def _ensure_list(value: Optional[Any]) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def slugify_identifier(name: str) -> str:
    value = name.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "_", value)
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
        logger.debug("[LLM-Graph] Отбрасываем сущность (тип=%s)", original_type, extra={"entity": entity})
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
    normalized_type = RELATION_TYPE_SYNONYMS.get(original_type, original_type)
    facts = _ensure_list(relationship.get("facts"))
    evidence = relationship.get("evidence")

    if normalized_type not in VALID_RELATION_TYPES:
        if original_type:
            facts.append(f"{RELATION_FACT_SUBTYPE_PREFIX}{original_type.title()}")
        normalized_type = DEFAULT_RELATION_FALLBACK

    if evidence and not isinstance(evidence, str):
        evidence = str(evidence)

    relationship.update(
        {
            "relation_type": normalized_type,
            "facts": facts,
            "evidence": evidence,
        }
    )
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
        logger.warning(
            "[LLM-Graph] Ответ LLM сохранён для анализа",
            extra={"path": str(file_name), "reason": reason},
        )
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "[LLM-Graph] Не удалось сохранить невалидный ответ",
            exc_info=exc,
            extra={"path": str(file_name)},
        )


async def _gather_context_snippets(conversation_id: str, limit_messages: int = 5) -> List[str]:
    snippets: List[str] = []
    try:
        context = await context_manager.get_recent_messages(conversation_id=conversation_id, limit=limit_messages)
        for item in context or []:
            role = item.get("role", "assistant")
            content = item.get("content")
            if isinstance(content, list):
                text_parts = [part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text"]
                content = "\n".join(filter(None, text_parts))
            if isinstance(content, str) and content.strip():
                snippets.append(f"[{role}] {content.strip()}")
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[LLM-Graph] Не удалось получить контекст беседы",
            exc_info=exc,
            extra={"conversation_id": conversation_id},
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
    user_prompt = build_user_prompt(
        conversation_id=conversation_id,
        message_id=message_id,
        text=text,
        reasoning=reasoning,
        context_flags=context_flags,
    )

    context_snippets = await _gather_context_snippets(conversation_id)
    if context_snippets:
        user_prompt = (
            f"{user_prompt}\n\nRecent context:\n"
            + "\n".join(context_snippets[:MAX_CONTEXT_MESSAGES])
        )

    return [
        {"role": "system", "content": system_prompt},
        {"role": "system", "content": examples_section},
        {"role": "user", "content": user_prompt},
    ]


async def _call_openrouter(
    messages: List[Dict[str, str]],
    model: str,
    conversation_id: str,
    message_id: str,
    attempt: int = 0,
) -> LLMInvocationResult:
    if not OPENROUTER_API_KEY or not OPENROUTER_BASE_URL:
        raise RuntimeError("OPENROUTER_API_KEY или OPENROUTER_BASE_URL не настроены")

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "X-Title": "LibreChat Graph Extraction",
    }
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.3,
        "top_p": 0.9,
        "max_tokens": 2048,
    }

    async with httpx.AsyncClient(timeout=settings.HTTPX_TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{OPENROUTER_BASE_URL}/chat/completions",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        data = response.json()

    choices = data.get("choices") or []
    if not choices:
        raise ValueError("OpenRouter вернул пустой список choices")

    message_block = choices[0].get("message") or {}
    content = (message_block.get("content") or "").strip()
    if not content:
        raise ValueError("OpenRouter вернул пустой ответ")

    reasoning = extract_reasoning_block(content)
    if reasoning:
        content = content.replace(reasoning, "").strip()

    result_json = json.loads(content)
    return LLMInvocationResult(
        content=content,
        parsed_json=result_json,
        model_used=model,
        reasoning=reasoning,
    )


async def _call_ollama(
    messages: List[Dict[str, str]],
    model: str,
    conversation_id: str,
    message_id: str,
    attempt: int = 0,
) -> LLMInvocationResult:
    headers = {"Content-Type": "application/json"}
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {"temperature": 0.4, "num_ctx": 8192},
    }

    async with httpx.AsyncClient(timeout=settings.HTTPX_TIMEOUT_SECONDS) as client:
        response = await client.post(f"{OLLAMA_URL}/api/chat", headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()

    content = (data.get("message", {}).get("content") or "").strip()
    if not content:
        raise ValueError("Ollama вернул пустой ответ")

    reasoning = extract_reasoning_block(content)
    if reasoning:
        content = content.replace(reasoning, "").strip()

    result_json = json.loads(content)
    return LLMInvocationResult(
        content=content,
        parsed_json=result_json,
        model_used=model,
        reasoning=reasoning,
    )


async def _invoke_llm(
    messages: List[Dict[str, str]],
    conversation_id: str,
    message_id: str,
) -> LLMInvocationResult:
    await GLOBAL_RATE_LIMITER.acquire()
    last_error: Exception | None = None

    providers: List[Tuple[str, str, bool]] = []
    if USE_OPENROUTER:
        if OPENROUTER_MODEL_PRIMARY:
            providers.append(("openrouter", OPENROUTER_MODEL_PRIMARY, False))
        if OPENROUTER_MODEL_FALLBACK:
            providers.append(("openrouter", OPENROUTER_MODEL_FALLBACK, True))
    if USE_OLLAMA and OLLAMA_MODEL:
        providers.append(("ollama", OLLAMA_MODEL, True))

    if not providers:
        raise RuntimeError("Не указана ни одна модель для извлечения сущностей")

    for attempt in range(1, MAX_LLM_ATTEMPTS + 1):
        for provider_name, model_name, is_fallback in providers:
            try:
                logger.info(
                    "[LLM-Graph] Вызов модели",
                    extra={
                        "provider": provider_name,
                        "model": model_name,
                        "attempt": attempt,
                        "conversation_id": conversation_id,
                        "message_id": message_id,
                        "fallback": is_fallback,
                    },
                )
                if provider_name == "openrouter":
                    return await _call_openrouter(messages, model_name, conversation_id, message_id, attempt)
                if provider_name == "ollama":
                    return await _call_ollama(messages, model_name, conversation_id, message_id, attempt)
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                logger.warning(
                    "[LLM-Graph] Ошибка LLM-вызова",
                    exc_info=exc,
                    extra={"model": model_name, "provider": provider_name, "attempt": attempt},
                )
                await asyncio.sleep(LLM_RETRY_DELAY_BASE * attempt)

    raise RuntimeError(f"Не удалось получить корректный ответ от LLM: {last_error}") from last_error


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
            merged_attrs = {**existing_attrs, **new_attrs}
            existing["attributes"] = merged_attrs
        else:
            seen[entity_id] = entity
    return list(seen.values())


def _convert_to_pydantic(entities: List[Dict[str, Any]], relationships: List[Dict[str, Any]]) -> List[ExtractedEntity]:
    grouped: Dict[str, Dict[str, Any]] = {entity["id"]: {**entity, "relationships": []} for entity in entities}
    for relationship in relationships:
        subject_id = relationship.get("subject_id")
        if subject_id in grouped:
            grouped[subject_id].setdefault("relationships", []).append(
                {
                    "object_id": relationship.get("object_id"),
                    "relation_type": relationship.get("relation_type"),
                    "facts": relationship.get("facts", []),
                    "evidence": relationship.get("evidence"),
                }
            )
    result: List[ExtractedEntity] = []
    for entity_data in grouped.values():
        try:
            result.append(ExtractedEntity(**entity_data))
        except ValidationError as exc:
            logger.warning("[LLM-Graph] Ошибка валидации сущности", extra={"entity": entity_data, "error": str(exc)})
    return result


async def call_llm(
    text: str,
    reasoning: Optional[str],
    context_flags: Sequence[str],
    conversation_id: str,
    message_id: str,
    user_id: str,
) -> Tuple[List[ExtractedEntity], Optional[str]]:
    try:
        messages = await _build_messages(
            conversation_id=conversation_id,
            message_id=message_id,
            text=text,
            reasoning=reasoning,
            context_flags=context_flags,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("[LLM-Graph] Ошибка при подготовке сообщений", exc_info=exc)
        return [], f"message_build_failed: {exc}"

    try:
        llm_result = await _invoke_llm(messages, conversation_id, message_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[LLM-Graph] Ошибка вызова LLM", exc_info=exc)
        return [], f"llm_invoke_failed: {exc}"

    raw_content = llm_result.content
    parsed_entities: List[Dict[str, Any]]
    parsed_relationships: List[Dict[str, Any]]

    try:
        parsed_entities, parsed_relationships = _parse_entities(llm_result.parsed_json)
        parsed_entities = _dedupe_entities(parsed_entities)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[LLM-Graph] Ошибка парсинга ответа", exc_info=exc)
        _store_failed_payload(
            conversation_id=conversation_id,
            message_id=message_id,
            model_used=llm_result.model_used,
            raw_content=raw_content,
            reason=f"parse_error: {exc}",
        )
        return [], f"parse_error: {exc}"

    try:
        entities_pydantic = _convert_to_pydantic(parsed_entities, parsed_relationships)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[LLM-Graph] Ошибка конвертации сущностей", exc_info=exc)
        _store_failed_payload(
            conversation_id=conversation_id,
            message_id=message_id,
            model_used=llm_result.model_used,
            raw_content=raw_content,
            reason=f"pydantic_conversion_error: {exc}",
        )
        return [], f"pydantic_conversion_error: {exc}"

    logger.info(
        "[LLM-Graph] Сущности извлечены",
        extra={
            "conversation_id": conversation_id,
            "message_id": message_id,
            "user_id": user_id,
            "model_used": llm_result.model_used,
            "entities_count": len(entities_pydantic),
        },
    )

    return entities_pydantic, None


def get_stats() -> Dict[str, Any]:
    total = json_parse_success_count + json_parse_failure_count
    success_rate = round(json_parse_success_count / total * 100, 2) if total else 0.0
    return {
        "json_parsing": {
            "success": json_parse_success_count,
            "failure": json_parse_failure_count,
            "success_rate_pct": success_rate,
            "errors": json_parse_errors,
        },
        "original_relation_stats": {
            "total": sum(original_relation_counter.values()),
            "unique": len(original_relation_counter),
            "top": sorted(
                (
                    {"original_relation": relation, "count": count}
                    for relation, count in original_relation_counter.items()
                ),
                key=lambda item: item["count"],
                reverse=True,
            )[:20],
        },
    }
