from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Dict, List, Optional, Tuple

import httpx

from core.clients import ensure_http_client
from core.config import settings
from core.rate_limiters import RateLimiter
from services.text_utils import split_text_semantically
from services.token_chunker import TokenChunker

logger = logging.getLogger("tools-gateway")

mxbai_rate_limiter = RateLimiter(30)
e5_rate_limiter = RateLimiter(30)

_TOKEN_CHUNKER_CACHE: Dict[Tuple[str, int, int], TokenChunker] = {}


def _model_family(model: str) -> str:
    model_lower = (model or "").lower()
    if "mxbai" in model_lower or "mixedbread" in model_lower:
        return "mxbai"
    return "e5"


def _get_token_chunker(model: str) -> TokenChunker:
    family = _model_family(model)
    safety_margin = max(0, getattr(settings, "TEI_TOKEN_SAFETY_MARGIN", 24))
    overlap_tokens = max(0, getattr(settings, "TEI_TOKEN_OVERLAP_TOKENS", 0))

    if family == "mxbai":
        tokenizer_name = getattr(settings, "TEI_TOKENIZER_MX", "mixedbread-ai/mxbai-embed-large-v1")
        max_tokens = getattr(settings, "TEI_MAX_TOKENS_MX", 512)
    else:
        tokenizer_name = getattr(settings, "TEI_TOKENIZER_E5", "intfloat/e5-base-v2")
        max_tokens = getattr(settings, "TEI_MAX_TOKENS_E5", 512)

    max_tokens = max(1, max_tokens - safety_margin)
    cache_key = (tokenizer_name, max_tokens, overlap_tokens)
    chunker = _TOKEN_CHUNKER_CACHE.get(cache_key)
    if chunker is None:
        chunker = TokenChunker(tokenizer_name=tokenizer_name, max_tokens=max_tokens, overlap_tokens=overlap_tokens)
        _TOKEN_CHUNKER_CACHE[cache_key] = chunker
    return chunker


def _token_safe_split(text: str, chunker: TokenChunker) -> List[str]:
    semantic_chunks = split_text_semantically(text, settings.TEI_MAX_CHARS_PER_CHUNK)
    token_safe_chunks: List[str] = []
    for semantic_chunk in semantic_chunks:
        if not semantic_chunk:
            continue
        token_safe_chunks.extend(chunker.chunk_text(semantic_chunk))
    return [chunk for chunk in token_safe_chunks if chunk]


def _force_token_split(
    chunker: TokenChunker,
    text: str,
    *,
    min_tokens: int = 64,
    max_rounds: int = 4,
) -> List[str]:
    if not text:
        return []

    current_limit = max(min_tokens, chunker.max_tokens // 2 or min_tokens)
    for _ in range(max_rounds):
        emergency_chunker = TokenChunker(
            tokenizer_name=chunker.tokenizer_name,
            max_tokens=max(current_limit, min_tokens),
            overlap_tokens=0,
        )
        parts = emergency_chunker.chunk_text(text)
        if len(parts) > 1:
            return parts
        current_limit = max(min_tokens, current_limit // 2)

    return [text]


async def embed_once(
    text: str,
    url: str,
    model: str,
    limiter: RateLimiter,
    max_retries: int = 50,
    max_wait_seconds: float = 120.0,
) -> Tuple[Optional[List[float]], bool]:
    if not text:
        return None, False

    last_error: Optional[str] = None
    oversized_detected = False
    http_client = await ensure_http_client()

    start = time.monotonic()
    attempt = 0

    while attempt < max_retries and (time.monotonic() - start) < max_wait_seconds:
        attempt += 1
        await limiter.acquire()

        try:
            response = await http_client.post(url, json={"input": [text], "model": model})
            response.raise_for_status()
            payload = response.json()
            return payload["data"][0]["embedding"], False

        except asyncio.CancelledError:
            logger.warning(
                "Embedding cancelled while calling TEI (model=%s, attempt=%d, elapsed=%.1fs)",
                model,
                attempt,
                time.monotonic() - start,
            )
            raise

        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            body_preview = exc.response.text[:128]

            logger.warning(
                "Embedding HTTP %s (%s) model=%s attempt=%s elapsed=%.1fs",
                status,
                body_preview,
                model,
                attempt,
                time.monotonic() - start,
            )

            if status in (413, 422):
                oversized_detected = True
                logger.warning("Embedding: текст слишком большой для модели %s.", model)
                break

            if status in (429, 502, 503, 504):
                base_delay = min(30.0, 2 ** min(attempt - 1, 5))
                jitter = random.uniform(0, base_delay * 0.2)
                delay = base_delay + jitter
                await asyncio.sleep(delay)
                continue

            last_error = f"HTTP {status}"
            break

        except (
            httpx.ConnectError,
            httpx.ReadTimeout,
            httpx.WriteTimeout,
            httpx.PoolTimeout,
            httpx.RemoteProtocolError,
        ) as exc:
            last_error = str(exc)
            base_delay = min(30.0, 2 ** min(attempt - 1, 5))
            jitter = random.uniform(0, base_delay * 0.2)
            await asyncio.sleep(base_delay + jitter)
            continue

        except Exception as exc:
            last_error = str(exc)
            logger.error("Embedding: неожиданная ошибка %s", exc, exc_info=True)
            break

    if last_error:
        logger.error("Embedding неуспешен: %s (model=%s, waited=%.1fs)", last_error, model, time.monotonic() - start)
    return None, oversized_detected


async def get_embedding(text: str, url: str, model: str, limiter: RateLimiter) -> Optional[List[float]]:
    text = text or ""
    if not text:
        return None

    chunker = _get_token_chunker(model)
    oversized = False

    try:
        token_count = chunker.token_count(text)
    except Exception as exc:
        logger.warning("[Embedding] Не удалось посчитать токены для модели %s: %s", model, exc)
        token_count = chunker.max_tokens + 1

    if token_count <= chunker.max_tokens:
        embedding, chunk_oversized = await embed_once(text, url, model, limiter)
        if embedding is not None:
            return embedding
        oversized = oversized or chunk_oversized
    else:
        oversized = True

    token_safe_chunks = _token_safe_split(text, chunker)
    if not token_safe_chunks:
        logger.warning("[Embedding] Token-aware split дал пустой результат для %s", model)
        return None

    max_chunks_allowed = getattr(settings, "TEI_MAX_CHUNKS_PER_REQUEST", 0)
    if max_chunks_allowed and len(token_safe_chunks) > max_chunks_allowed:
        logger.warning(
            "[Embedding] Слишком много чанков (%d) для модели %s, усечём до %d",
            len(token_safe_chunks),
            model,
            max_chunks_allowed,
        )
        token_safe_chunks = token_safe_chunks[:max_chunks_allowed]

    if len(token_safe_chunks) > 1 or oversized:
        logger.info("[Embedding] token-aware разбиение на %d чанков для %s", len(token_safe_chunks), model)

    semaphore = asyncio.Semaphore(max(1, settings.TEI_EMBED_CONCURRENCY))

    async def embed_chunk(chunk_text: str, idx: int) -> Optional[List[float]]:
        chunk_embedding, chunk_oversized = await embed_once(chunk_text, url, model, limiter)
        if chunk_embedding is not None:
            return chunk_embedding

        if chunk_oversized:
            forced_chunks = _force_token_split(chunker, chunk_text)
            if len(forced_chunks) <= 1:
                logger.error(
                    "[Embedding] Token-forced split не смог разбить chunk=%d для модели %s",
                    idx,
                    model,
                )
                return None

            logger.warning(
                "[Embedding] Token-forced split чанка %d (-> %d частей) для модели %s",
                idx,
                len(forced_chunks),
                model,
            )
            forced_vectors: List[List[float]] = []
            for forced_idx, forced_chunk in enumerate(forced_chunks, start=1):
                forced_embedding, forced_oversized = await embed_once(forced_chunk, url, model, limiter)
                if forced_embedding is not None:
                    forced_vectors.append(forced_embedding)
                elif forced_oversized:
                    logger.error(
                        "[Embedding] Даже token-forced split не помог (chunk=%d.%d, model=%s)",
                        idx,
                        forced_idx,
                        model,
                    )
                    return None
                else:
                    logger.warning(
                        "[Embedding] Не удалось встроить chunk=%d.%d для модели %s",
                        idx,
                        forced_idx,
                        model,
                    )
            if forced_vectors:
                return [sum(col) / len(col) for col in zip(*forced_vectors)]
        else:
            logger.warning("[Embedding] Не удалось встроить chunk=%d для модели %s", idx, model)
        return None

    async def process_chunk(idx: int, chunk_text: str) -> Optional[List[float]]:
        async with semaphore:
            try:
                return await embed_chunk(chunk_text, idx)
            except asyncio.CancelledError:
                logger.warning("[Embedding] Cancelled while processing chunk=%d (model=%s)", idx, model)
                raise
            except Exception as exc:
                logger.error(
                    "[Embedding] Ошибка при обработке chunk=%d для модели %s: %s",
                    idx,
                    model,
                    exc,
                    exc_info=True,
                )
                return None

    tasks = [
        asyncio.create_task(process_chunk(idx, chunk))
        for idx, chunk in enumerate(token_safe_chunks, start=1)
    ]
    try:
        chunk_vectors = await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        logger.warning("[Embedding] Cancelled while waiting for chunk embeddings (model=%s)", model)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise

    vectors = [vec for vec in chunk_vectors if vec]
    if not vectors:
        logger.warning("[Embedding] Ни один чанк не прошёл для модели %s", model)
        return None

    averaged = [sum(col) / len(col) for col in zip(*vectors)]
    return averaged


async def embed_with_fallback(text: str) -> Dict[str, List[float]]:
    try:
        results: Dict[str, List[float]] = {}
        mxbai = await get_embedding(text, settings.TEI_URL_MX, "mixedbread-ai/mxbai-embed-large-v1", mxbai_rate_limiter)
        if mxbai:
            results["mxbai"] = mxbai
        else:
            logger.warning("Embedding: MXBAI не сработал, пробуем E5.")

        e5 = await get_embedding(text, settings.TEI_URL_E5, "intfloat/e5-base-v2", e5_rate_limiter)
        if e5:
            results["e5"] = e5
        else:
            logger.warning("Embedding: E5 тоже не сработал.")

        return results
    except asyncio.CancelledError:
        logger.warning(
            "[Embedding] Cancelled while building embeddings (payload_length=%d)",
            len(text or ""),
        )
        raise
