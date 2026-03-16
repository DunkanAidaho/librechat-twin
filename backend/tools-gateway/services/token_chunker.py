from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Dict, Iterable, List

from transformers import AutoTokenizer, PreTrainedTokenizerBase
from transformers.utils import logging as hf_logging

logger = logging.getLogger("tools-gateway.tokenizer")

hf_logging.set_verbosity_error()

_TOKENIZER_CACHE: Dict[str, PreTrainedTokenizerBase] = {}


def _load_tokenizer(name: str) -> PreTrainedTokenizerBase:
    tokenizer = _TOKENIZER_CACHE.get(name)
    if tokenizer is not None:
        return tokenizer

    logger.info("[TokenChunker] Загрузка токенизатора %s", name)
    tokenizer = AutoTokenizer.from_pretrained(name, use_fast=True)
    _TOKENIZER_CACHE[name] = tokenizer
    return tokenizer


def prewarm_tokenizers(names: Iterable[str]) -> None:
    for name in names:
        if not name:
            continue
        _load_tokenizer(name)


@dataclass
class TokenChunker:
    tokenizer_name: str
    max_tokens: int
    overlap_tokens: int = 0

    def __post_init__(self) -> None:
        if self.max_tokens <= 0:
            raise ValueError("max_tokens must be positive")
        if self.overlap_tokens < 0:
            raise ValueError("overlap_tokens must be non-negative")
        if self.overlap_tokens >= self.max_tokens:
            raise ValueError("overlap_tokens must be less than max_tokens")

    def _tokenizer(self) -> PreTrainedTokenizerBase:
        return _load_tokenizer(self.tokenizer_name)

    def token_count(self, text: str) -> int:
        if not text:
            return 0
        tokenizer = self._tokenizer()
        return len(tokenizer.encode(text, add_special_tokens=False))

    def chunk_text(self, text: str) -> List[str]:
        if not text:
            return []

        tokenizer = self._tokenizer()
        token_ids = tokenizer.encode(text, add_special_tokens=False)

        if len(token_ids) <= self.max_tokens:
            return [text]

        step = self.max_tokens - self.overlap_tokens
        chunks: List[str] = []
        for start in range(0, len(token_ids), step):
            end = min(start + self.max_tokens, len(token_ids))
            chunk_ids = token_ids[start:end]
            chunk_text = tokenizer.decode(chunk_ids, skip_special_tokens=True)
            if chunk_text:
                chunks.append(chunk_text)
        return chunks
