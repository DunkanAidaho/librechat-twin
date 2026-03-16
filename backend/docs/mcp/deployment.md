# Deployment MCP Adapter

## Environment Variables

### Основные переменные
```bash
# Серверные настройки
MCP_ADAPTER_HOST=0.0.0.0
MCP_ADAPTER_PORT=8000
MCP_ADAPTER_WORKERS=4
MCP_ADAPTER_LOG_LEVEL=INFO

# Аутентификация для входящих MCP вызовов (от LibreChat)
MCP_ADAPTER_ENABLE_AUTH=true  # Для production обязательно true
MCP_ADAPTER_AUTH_TOKEN=your-mcp-auth-token  # Bearer токен для аутентификации входящих MCP вызовов от LibreChat

# Конфигурация tools-gateway (исходящие вызовы)
TOOLS_GATEWAY_BASE_URL=http://tools-gateway:8000
TOOLS_GATEWAY_SERVICE_TOKEN=your-service-token-here

# Настройки HTTP клиента
HTTP_TIMEOUT=30
HTTP_MAX_RETRIES=3
HTTP_RETRY_DELAY=1.0
```

### Secrets Management

Секреты должны храниться в защищенном хранилище (например, Kubernetes secrets, HashiCorp Vault, или environment variables в production).

```bash
# Пример .env файла для разработки
MCP_ADAPTER_HOST=0.0.0.0
MCP_ADAPTER_PORT=8000
MCP_ADAPTER_LOG_LEVEL=DEBUG
MCP_ADAPTER_ENABLE_AUTH=false  # Для разработки может быть отключено, но в production должно быть true

TOOLS_GATEWAY_BASE_URL=http://localhost:8001
TOOLS_GATEWAY_SERVICE_TOKEN=dev-service-token-12345
```

## Docker Configuration

### Dockerfile
```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Установка зависимостей
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Копирование кода
COPY . .

# Создание non-root пользователя
RUN useradd --create-home --shell /bin/bash app && chown -R app:app /app
USER app

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
```

### docker-compose.yml
```yaml
version: '3.8'

services:
  mcp-adapter:
    build: .
    ports:
      - "8000:8000"
    environment:
      - MCP_ADAPTER_HOST=0.0.0.0
      - MCP_ADAPTER_PORT=8000
      - TOOLS_GATEWAY_BASE_URL=http://tools-gateway:8000
      - TOOLS_GATEWAY_SERVICE_TOKEN=${TOOLS_GATEWAY_SERVICE_TOKEN}
      - MCP_ADAPTER_LOG_LEVEL=INFO
      - MCP_ADAPTER_ENABLE_AUTH=true
      - MCP_ADAPTER_AUTH_TOKEN=${MCP_ADAPTER_AUTH_TOKEN}
    depends_on:
      - tools-gateway
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  tools-gateway:
    image: tools-gateway:latest
    environment:
      - PG_CONN=postgresql://user:pass@postgres:5432/db
      - NEO4J_URI=bolt://neo4j:7687
      - TOOLS_GATEWAY_SERVICE_TOKEN=${TOOLS_GATEWAY_SERVICE_TOKEN}
    depends_on:
      - postgres
      - neo4j
```

## Kubernetes Deployment

### deployment.yaml
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-adapter
  labels:
    app: mcp-adapter
spec:
  replicas: 2
  selector:
    matchLabels:
      app: mcp-adapter
  template:
    metadata:
      labels:
        app: mcp-adapter
    spec:
      containers:
      - name: mcp-adapter
        image: mcp-adapter:latest
        ports:
        - containerPort: 8000
        env:
        - name: MCP_ADAPTER_HOST
          value: "0.0.0.0"
        - name: MCP_ADAPTER_PORT
          value: "8000"
        - name: TOOLS_GATEWAY_BASE_URL
          valueFrom:
            secretKeyRef:
              name: mcp-adapter-secrets
              key: tools-gateway-url
        - name: TOOLS_GATEWAY_SERVICE_TOKEN
          valueFrom:
            secretKeyRef:
              name: mcp-adapter-secrets
              key: tools-gateway-token
        - name: MCP_ADAPTER_AUTH_TOKEN
          valueFrom:
            secretKeyRef:
              name: mcp-adapter-secrets
              key: mcp-auth-token
        - name: MCP_ADAPTER_LOG_LEVEL
          value: "INFO"
        - name: MCP_ADAPTER_ENABLE_AUTH
          value: "true"
        readinessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 15
          periodSeconds: 20
---
apiVersion: v1
kind: Service
metadata:
  name: mcp-adapter-service
spec:
  selector:
    app: mcp-adapter
  ports:
    - protocol: TCP
      port: 8000
      targetPort: 8000
  type: ClusterIP
```

### secrets.yaml
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: mcp-adapter-secrets
type: Opaque
data:
  tools-gateway-url: aHR0cDovL3Rvb2xzLWdhdGV3YXk6ODAwMA==  # base64 encoded
  tools-gateway-token: eW91ci1zZXJ2aWNlLXRva2VuLWhlcmU=  # base64 encoded
  mcp-auth-token: eW91ci1tY3AtYXV0aC10b2tlbi1oZXJl  # base64 encoded
```

## Подключение через LibreChat UI

### Шаги регистрации

1. **Открыть LibreChat UI**
   - Перейдите в интерфейс LibreChat
   - Зайдите в настройки пользователя или администратора

2. **Найти раздел MCP**
   - В меню настроек найдите раздел "MCP" или "Model Control Protocol"
   - Выберите "Remote MCP Registration"

3. **Заполнить параметры подключения**
   ```
   MCP Server URL: http://your-mcp-adapter-host:8000
   Auth Token: your-mcp-auth-token (если включена аутентификация)
   ```

4. **Проверить подключение**
   - Нажмите "Test Connection"
   - Должен отобразиться список доступных инструментов:
     - `search_context`
     - `submit_ingest`
     - `ingest_status`

### Пример конфигурации

```json
{
  "mcpServers": [
    {
      "name": "tools-gateway-adapter",
      "url": "http://mcp-adapter:8000",
      "auth": {
        "type": "bearer",
        "token": "your-mcp-auth-token"
      },
      "enabled": true
    }
  ]
}
```

## Health Check и Monitoring

### Health Endpoint
```
GET /health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00Z",
  "version": "1.0.0"
}
```

### Metrics Endpoint
```
GET /metrics
```

Доступные метрики:
- `mcp_requests_total` - общее количество запросов
- `mcp_requests_duration_seconds` - время обработки запросов
- `mcp_errors_total` - количество ошибок
- `tools_gateway_requests_total` - запросы к tools-gateway
- `tools_gateway_errors_total` - ошибки при вызовах tools-gateway

## Логирование

### Уровни логирования
- `DEBUG` - детальная отладочная информация
- `INFO` - общая информация о работе сервиса
- `WARNING` - предупреждения
- `ERROR` - ошибки обработки запросов
- `CRITICAL` - критические ошибки

### Формат логов
```json
{
  "timestamp": "2024-01-01T00:00:00Z",
  "level": "INFO",
  "message": "Request processed",
  "request_id": "uuid-here",
  "tool_name": "search_context",
  "duration_ms": 150
}
```

## Troubleshooting

### Частые проблемы

1. **Connection refused к tools-gateway**
   - Проверьте, запущен ли сервис tools-gateway
   - Проверьте правильность URL в `TOOLS_GATEWAY_BASE_URL`
   - Проверьте сетевую доступность между сервисами

2. **401 Unauthorized**
   - Проверьте правильность `TOOLS_GATEWAY_SERVICE_TOKEN`
   - Убедитесь, что токен настроен в tools-gateway
   - Для входящих MCP вызовов проверьте `MCP_ADAPTER_AUTH_TOKEN`

3. **Timeout errors**
   - Увеличьте `HTTP_TIMEOUT`
   - Проверьте производительность tools-gateway

4. **MCP registration failed**
   - Проверьте доступность MCP adapter endpoint
   - Убедитесь, что CORS настройки корректны
   - Проверьте аутентификацию (если включена)

### Команды диагностики

```bash
# Проверка health endpoint
curl http://localhost:8000/health

# Проверка доступности tools-gateway
curl http://tools-gateway:8000/healthz

# Логи контейнера
docker logs mcp-adapter

# Тестовый вызов инструмента
curl -X POST http://localhost:8000/mcp/tools/search_context \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-mcp-auth-token" \
  -d '{"query": "test", "chat_id": "test-chat"}'