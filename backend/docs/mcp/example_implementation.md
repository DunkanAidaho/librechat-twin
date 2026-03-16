# Пример реализации MCP Adapter (НЕФИНАЛЬНЫЙ SKETCH)

**ВАЖНО**: Этот пример является иллюстративным sketch'ом и **не представляет собой финальную protocol-compatible implementation**.

Данный пример демонстрирует концепцию реализации, но:
- Не использует выбранную MCP Python библиотеку (`mcp`)
- Не реализует настоящий Model Context Protocol
- Является упрощенным REST API вместо MCP

**Для production использования необходимо:**
- Использовать выбранную MCP Python библиотеку (`mcp`) - официальный Model Context Protocol Python SDK
- Реализовать настоящий MCP server с поддержкой `streamable-http`
- Следовать спецификации Model Context Protocol

## Основной файл приложения (app.py) - ИЛЛЮСТРАТИВНЫЙ ПРИМЕР

```python
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import httpx
import os
from typing import Dict, Any

from models.mcp_models import (
    SearchContextRequest, SearchContextResponse,
    SubmitIngestRequest, SubmitIngestResponse
)
from services.http_client import ToolsGatewayClient
from config import settings

app = FastAPI(
    title="MCP Adapter for tools-gateway",
    description="External MCP adapter server for LibreChat integration",
    version="1.0.0"
)

# Инициализация HTTP клиента для tools-gateway
gateway_client = ToolsGatewayClient(
    base_url=settings.TOOLS_GATEWAY_BASE_URL,
    auth_token=settings.TOOLS_GATEWAY_SERVICE_TOKEN
)

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok", "timestamp": "2024-01-01T00:00:00Z"}

@app.get("/tools")
async def list_tools():
    """List available MCP tools"""
    return {
        "tools": [
            {
                "name": "search_context",
                "description": "Поиск контекста для текущей беседы",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "chat_id": {"type": "string"}
                    },
                    "required": ["query", "chat_id"]
                }
            },
            {
                "name": "submit_ingest",
                "description": "Отправка данных для индексации",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "chat_id": {"type": "string"},
                        "content": {"type": "string"}
                    },
                    "required": ["chat_id"]
                }
            },
            {
                "name": "ingest_status",
                "description": "Проверка статуса индексации",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"}
                    },
                    "required": ["job_id"]
                }
            }
        ]
    }

@app.post("/tools/search_context")
async def search_context(request: SearchContextRequest):
    """Search context tool implementation"""
    try:
        # Преобразование запроса в формат tools-gateway
        gateway_request = {
            "query": request.query,
            "chat_id": request.chat_id,
            "message_id": request.message_id,
            "user_id": request.user_id,
            "agent": request.agent,
            "recent_messages": request.recent_messages,
            "model_token_limit": request.model_limit,
            "filters": request.filters,
            "include_graph": request.include_graph
        }
        
        # Вызов tools-gateway
        response = await gateway_client.search_context(gateway_request)
        
        # Преобразование ответа в формат MCP
        return response
        
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Gateway timeout")
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Gateway error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")

@app.post("/tools/submit_ingest")
async def submit_ingest(request: SubmitIngestRequest):
    """Submit ingest tool implementation"""
    try:
        # Преобразование запроса в формат tools-gateway
        gateway_request = {
            "chat_id": request.chat_id,
            "message_id": request.message_id,
            "user_id": request.user_id,
            "agent": request.agent,
            "content": request.content,
            "ingest_profile": request.ingest_profile,
            "metadata": request.metadata,
            "idempotency_key": request.idempotency_key,
            "role": request.role,
            "source_system": request.source_system,
            "source_chat_id": request.source_chat_id,
            "source_message_id": request.source_message_id,
            "source_user_id": request.source_user_id,
            "workspace_id": request.workspace_id
        }
        
        # Вызов tools-gateway
        response = await gateway_client.submit_ingest(gateway_request)
        
        # Преобразование ответа в формат MCP
        return response
        
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Gateway timeout")
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Gateway error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")

@app.get("/tools/ingest_status/{job_id}")
async def ingest_status(job_id: str):
    """Ingest status tool implementation"""
    try:
        # Вызов tools-gateway
        response = await gateway_client.ingest_status(job_id)
        
        # Ответ уже в нужном формате
        return response
        
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Gateway timeout")
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Gateway error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")
```

## Конфигурация (config.py)

```python
from pydantic_settings import BaseSettings
from typing import Optional

class Settings(BaseSettings):
    # Серверные настройки
    MCP_ADAPTER_HOST: str = "0.0.0.0"
    MCP_ADAPTER_PORT: int = 8000
    MCP_ADAPTER_LOG_LEVEL: str = "INFO"
    
    # Аутентификация для входящих MCP вызовов
    MCP_ADAPTER_ENABLE_AUTH: bool = True
    MCP_ADAPTER_AUTH_TOKEN: Optional[str] = None
    
    # Конфигурация tools-gateway
    TOOLS_GATEWAY_BASE_URL: str = "http://localhost:8001"
    TOOLS_GATEWAY_SERVICE_TOKEN: str = ""
    
    # HTTP настройки
    HTTP_TIMEOUT: float = 30.0
    HTTP_MAX_RETRIES: int = 3
    
    class Config:
        env_file = ".env"

settings = Settings()
```

## HTTP клиент (services/http_client.py)

```python
import httpx
from typing import Dict, Any
import asyncio

class ToolsGatewayClient:
    def __init__(self, base_url: str, auth_token: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip('/')
        self.auth_token = auth_token
        self.timeout = timeout
        self.client = httpx.AsyncClient(
            timeout=timeout,
            headers={"Authorization": f"Bearer {auth_token}"}
        )
    
    async def search_context(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Вызов /tool/search_context"""
        response = await self.client.post(
            f"{self.base_url}/tool/search_context",
            json=request
        )
        response.raise_for_status()
        return response.json()
    
    async def submit_ingest(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Вызов /tool/submit_ingest"""
        response = await self.client.post(
            f"{self.base_url}/tool/submit_ingest",
            json=request
        )
        response.raise_for_status()
        return response.json()
    
    async def ingest_status(self, job_id: str) -> Dict[str, Any]:
        """Вызов /tool/ingest_status/{job_id}"""
        response = await self.client.get(
            f"{self.base_url}/tool/ingest_status/{job_id}"
        )
        response.raise_for_status()
        return response.json()
    
    async def close(self):
        """Закрытие HTTP клиента"""
        await self.client.aclose()
```

## Запуск приложения

```bash
# Установка зависимостей
pip install fastapi uvicorn httpx pydantic pydantic-settings

# Запуск сервера
uvicorn app:app --host 0.0.0.0 --port 8000 --workers 4
```

## ВАЖНО: Что нужно изменить для финальной реализации

1. **Использовать выбранную MCP Python библиотеку** (`mcp` - официальный Model Context Protocol Python SDK) вместо FastAPI REST endpoints
2. **Реализовать настоящий MCP server** с поддержкой Model Context Protocol
3. **Использовать streamable-http transport** как основной transport (совместимо с LibreChat)
4. **Следовать спецификации MCP** для tool registration и invocation
5. **Реализовать proper error handling** в соответствии с MCP стандартом

Этот пример демонстрирует только базовую структуру и **не является финальной protocol-compatible implementation**.

**Финальная реализация должна:**
- Использовать `mcp` библиотеку для реализации настоящего MCP сервера
- Поддерживать `streamable-http` transport как основной (рекомендуемый LibreChat)
- Быть совместимой с LibreChat remote MCP registration через UI
- Не требовать изменений в коде LibreChat