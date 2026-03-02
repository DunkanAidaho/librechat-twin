1) Transparent logging (док/контроль качества, SSE)
2) Multi-step RAG + Graph resilience (инцидент 18–20.02.2026)
3) SRP-разнос AgentClient (client.js → utils/config/pricing/memory/prompt/tools/usage)
   - SRP: вынести HistoryManager/RagOrchestrator/ContextBuilder/MessageProcessor/ToolExecutor/UsageTracker
   - Chain of Responsibility для обработки сообщений (OCR → сжатие → RAG → токены)
   - Конфиги через ConfigService (runtime/historyCompression/limits)
   - Изоляция инфраструктуры (queueGateway/axios/Message.updateMany через адаптеры)
   - Оптимизация: кэш intent/graph, async ingest, токенизация, лимиты, логирование
