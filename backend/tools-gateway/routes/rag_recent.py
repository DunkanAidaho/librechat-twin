from __future__ import annotations

from typing import Dict, List, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(prefix="/rag", tags=["rag"])


class RagRecentRequest(BaseModel):
    conversation_id: str
    max_chunks: Optional[int] = None
    max_chars: Optional[int] = None


class RagChunk(BaseModel):
    content: str
    metadata: Optional[Dict[str, object]] = None


class RagRecentResponse(BaseModel):
    chunks: List[RagChunk] = Field(default_factory=list)


@router.post("/recent", response_model=RagRecentResponse)
async def rag_recent(_: RagRecentRequest) -> RagRecentResponse:
    return RagRecentResponse()
