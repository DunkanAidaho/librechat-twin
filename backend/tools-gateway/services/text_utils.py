from __future__ import annotations

import re
from typing import List

PARAGRAPH_SPLIT_REGEX = re.compile(r"\n{2,}")
INLINE_BREAK_REGEX = re.compile(r"(?:\s*[•\-\–\—]\s+|\s{2,})")
CONTENT_DATE_REGEX = re.compile(
    r"(?P<ddmmyyyy>\b\d{2}\.\d{2}\.\d{4}\b)|(?P<yyyymmdd>\b\d{4}-\d{2}-\d{2}\b)"
)


def _tokenize_sentences(paragraph: str) -> List[str]:
    paragraph = paragraph.strip()
    if not paragraph:
        return []

    sentences: List[str] = []
    last_end = 0
    for match in re.finditer(r"[\.!\?…]+(?:\s+|$)", paragraph):
        end = match.end()
        sentence = paragraph[last_end:end].strip()
        if sentence:
            sentences.append(sentence)
        last_end = end

    tail = paragraph[last_end:].strip()
    if tail:
        sentences.append(tail)
    return sentences or [paragraph]


def _split_inline(sentence: str) -> List[str]:
    parts = [part.strip() for part in INLINE_BREAK_REGEX.split(sentence) if part.strip()]
    return parts or [sentence.strip()]


def force_split_chunk(text: str, max_chars: int) -> List[str]:
    chunks: List[str] = []
    length = len(text)
    start = 0

    while start < length:
        end = min(start + max_chars, length)

        if end < length:
            newline_pos = text.rfind("\n", start, end)
            space_pos = text.rfind(" ", start, end)
            split_pos = max(newline_pos, space_pos)

            if split_pos <= start:
                split_pos = end
            else:
                end = split_pos

        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = end
        while start < length and text[start].isspace():
            start += 1

    if not chunks and text.strip():
        chunks.append(text.strip())
    return chunks or [text.strip()]


def split_text_semantically(text: str, max_chars: int) -> List[str]:
    raw = (text or "").strip()
    if not raw:
        return []

    paragraphs = [p.strip() for p in PARAGRAPH_SPLIT_REGEX.split(raw) if p.strip()]
    if not paragraphs:
        paragraphs = [raw]

    units: List[str] = []
    for paragraph in paragraphs:
        sentences = _tokenize_sentences(paragraph)
        for sentence in sentences:
            for piece in _split_inline(sentence):
                if piece:
                    units.append(piece)

    if not units:
        units = [raw]

    chunks: List[str] = []
    current: List[str] = []
    current_len = 0

    for unit in units:
        unit_len = len(unit)
        if unit_len > max_chars:
            if current:
                chunks.append(" ".join(current).strip())
                current = []
                current_len = 0
            forced = force_split_chunk(unit, max_chars)
            chunks.extend(forced)
            continue

        separator = 1 if current else 0
        if current_len + separator + unit_len > max_chars:
            chunks.append(" ".join(current).strip())
            current = []
            current_len = 0

        current.append(unit)
        current_len += (separator + unit_len)

    if current:
        chunks.append(" ".join(current).strip())

    return chunks or [raw]


def extract_content_dates(text: str) -> List[str]:
    if not text:
        return []
    matches = []
    for match in CONTENT_DATE_REGEX.finditer(text):
        if match.group("ddmmyyyy"):
            day, month, year = match.group("ddmmyyyy").split(".")
            matches.append(f"{year}-{month}-{day}")
        elif match.group("yyyymmdd"):
            matches.append(match.group("yyyymmdd"))
    return sorted(set(matches))
