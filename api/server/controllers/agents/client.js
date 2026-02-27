// /opt/open-webui/client.js - Финальная версия с исправленной логикой индексации и RAG через tools-gateway
require('events').EventEmitter.defaultMaxListeners = 100;
const { getLogger } = require('~/utils/logger');
const configService = require('~/server/services/Config/ConfigService');
const axios = require('axios');
const { condenseContext: ragCondenseContext, getCondenseProvidersPreview } = require('~/server/services/RAG/condense');
const { DynamicStructuredTool } = require('@langchain/core/tools');
const { getBufferString, HumanMessage, SystemMessage } = require('@langchain/core/messages');
const {
  sendEvent,
  createRun,
  Tokenizer,
  checkAccess,
  logAxiosError,
  resolveHeaders,
  getBalanceConfig,
  memoryInstructions,
  formatContentStrings,
  getTransactionsConfig,
  createMemoryProcessor,
} = require('@librechat/api');
const {
  Callback,
  Providers,
  GraphEvents,
  TitleMethod,
  formatMessage,
  formatAgentMessages,
  getTokenCountForMessage,
  createMetadataAggregator,
} = require('@librechat/agents');
const {
  Constants,
  Permissions,
  VisionModes,
  ContentTypes,
  EModelEndpoint,
  PermissionTypes,
  isAgentsEndpoint,
  AgentCapabilities,
  bedrockInputSchema,
  removeNullishValues,
} = require('librechat-data-provider');
const { addCacheControl, createContextHandlers } = require('~/app/clients/prompts');
const { initializeAgent } = require('~/server/services/Endpoints/agents/agent');
const { spendTokens, spendStructuredTokens } = require('~/models/spendTokens');
const { getFormattedMemories, deleteMemory, setMemory } = require('~/models');
const { encodeAndFormat } = require('~/server/services/Files/images/encode');
const { getProviderConfig } = require('~/server/services/Endpoints');
const { checkCapability } = require('~/server/services/Config');
const BaseClient = require('~/app/clients/BaseClient');
const { getRoleByName } = require('~/models/Role');
const { loadAgent } = require('~/models/Agent');
const { getMCPManager } = require('~/config');
const runtimeMemoryConfig = require('~/utils/memoryConfig');
const MessageHistoryManager = require('~/server/services/agents/MessageHistoryManager');
const { HistoryTrimmer } = require('~/server/services/agents/historyTrimmer');
const { ContextCompressor, MessageCompressorBridge } = require('~/server/services/agents/ContextCompressor');
const { analyzeIntent } = require('~/server/services/RAG/intentAnalyzer');
const { runMultiStepRag } = require('~/server/services/RAG/multiStepOrchestrator');
const {
  buildRagBlock,
  replaceRagBlock,
  setDeferredContext,
  getDeferredContext,
  clearDeferredContext,
} = require('~/server/services/RAG/RagContextManager');
const { sanitizeInput } = require('~/utils/security');
const {
  observeSegmentTokens,
  observeCache,
  observeCost,
  setContextLength,
} = require('~/utils/ragMetrics');
const crypto = require('crypto');
const { enqueueMemoryTasks } = require('~/server/services/RAG/memoryQueue');
const { writeTokenReport } = require('~/utils/tokenReport');
const { updateMessage } = require('~/models');

const {
  computePromptTokenBreakdown: computePromptTokenBreakdown,
  logPromptTokenBreakdown: logPromptTokenBreakdown
} = require("~/server/utils/tokenBreakdown");

/** @type {Map<string, { expiresAt: number, payload: object }>} */
const ragCache = new Map();

/** @type {number} */
let ragCacheTtlMs = runtimeMemoryConfig.getMemoryConfig().ragCacheTtl * 1000;

/**
 * Очищает истёкшие записи RAG-кэша.
 */
function pruneExpiredRagCache(now = Date.now()) {
  for (const [key, entry] of ragCache.entries()) {
    if (!entry?.expiresAt || entry.expiresAt <= now) {
      ragCache.delete(key);
    }
  }
}

/**
 * Хэширует произвольные данные в SHA1.
 */
function hashPayload(payload) {
  const normalized =
    typeof payload === 'string'
      ? payload
      : JSON.stringify(
          payload ?? '',
          (_, value) => (typeof value === 'bigint' ? value.toString() : value),
        );

  return crypto.createHash('sha1').update(normalized ?? '').digest('hex');
}

/**
 * Формирует ключ для RAG-кэша.
 */
function createCacheKey({ conversationId, endpoint, model, queryHash, configHash }) {
  return hashPayload({
    conversationId,
    endpoint,
    model,
    queryHash,
    configHash,
  });
}

/**
 * Обрезает и нормализует граф-контекст по лимитам.
 */
function sanitizeGraphContext(lines, config) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return [];
  }

  const limited = lines.slice(0, config.maxLines);
  return limited
    .map((line) => (typeof line === 'string' ? line.trim() : ''))
    .filter(Boolean)
    .map((line) => {
      if (line.length <= config.maxLineChars) {
        return line;
      }
      return `${line.slice(0, config.maxLineChars)}…`;
    });
}

/**
 * Ограничивает массив фрагментов (vector context).
 */
function sanitizeVectorChunks(chunks, config) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return [];
  }

  const limited = chunks.slice(0, config.maxChunks);
  return limited.map((chunk) => {
    if (typeof chunk !== 'string') {
      return '';
    }
    const trimmed = chunk.trim();
    if (trimmed.length <= config.maxChars) {
      return trimmed;
    }
    return `${trimmed.slice(0, config.maxChars)}…`;
  });
}


/**
 * Безопасно приводит значение к тарифу (USD за 1000 токенов).
 */
function parseUsdRate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Определяет тарифы (prompt/completion) для расчёта стоимости токенов.
 */
function resolvePricingRates(modelName, overrideConfig) {
  const sources = new Set();
  let promptUsdPer1k = null;
  let completionUsdPer1k = null;

  if (overrideConfig && typeof overrideConfig === 'object') {
    const modelsConfig = overrideConfig.models;
    if (modelsConfig && typeof modelsConfig === 'object') {
      const modelPricing = modelsConfig[modelName] || modelsConfig.default;
      if (modelPricing && typeof modelPricing === 'object') {
        const promptCandidate = parseUsdRate(
          modelPricing.prompt ?? modelPricing.input ?? modelPricing.promptUsdPer1k,
        );
        if (promptCandidate != null) {
          promptUsdPer1k = promptCandidate;
          sources.add('request.models.prompt');
        }

        const completionCandidate = parseUsdRate(
          modelPricing.completion ?? modelPricing.output ?? modelPricing.completionUsdPer1k,
        );
        if (completionCandidate != null) {
          completionUsdPer1k = completionCandidate;
          sources.add('request.models.completion');
        }
      }
    }

    const rootPrompt = parseUsdRate(overrideConfig.promptUsdPer1k);
    if (promptUsdPer1k == null && rootPrompt != null) {
      promptUsdPer1k = rootPrompt;
      sources.add('request.promptUsdPer1k');
    }

    const rootCompletion = parseUsdRate(overrideConfig.completionUsdPer1k);
    if (completionUsdPer1k == null && rootCompletion != null) {
      completionUsdPer1k = rootCompletion;
      sources.add('request.completionUsdPer1k');
    }
  }

  const globalConfig = pricingConfig && typeof pricingConfig === 'object' ? pricingConfig : {};
  const globalModels = globalConfig.models;
  if (globalModels && typeof globalModels === 'object' && (promptUsdPer1k == null || completionUsdPer1k == null)) {
    const modelPricing = globalModels[modelName] || globalModels.default;
    if (modelPricing && typeof modelPricing === 'object') {
      if (promptUsdPer1k == null) {
        const promptCandidate = parseUsdRate(
          modelPricing.prompt ?? modelPricing.input ?? modelPricing.promptUsdPer1k,
        );
        if (promptCandidate != null) {
          promptUsdPer1k = promptCandidate;
          sources.add('config.models.prompt');
        }
      }

      if (completionUsdPer1k == null) {
        const completionCandidate = parseUsdRate(
          modelPricing.completion ?? modelPricing.output ?? modelPricing.completionUsdPer1k,
        );
        if (completionCandidate != null) {
          completionUsdPer1k = completionCandidate;
          sources.add('config.models.completion');
        }
      }
    }
  }

  if (promptUsdPer1k == null) {
    const rootPrompt = parseUsdRate(globalConfig.promptUsdPer1k);
    if (rootPrompt != null) {
      promptUsdPer1k = rootPrompt;
      sources.add('config.promptUsdPer1k');
    }
  }

  if (completionUsdPer1k == null) {
    const rootCompletion = parseUsdRate(globalConfig.completionUsdPer1k);
    if (rootCompletion != null) {
      completionUsdPer1k = rootCompletion;
      sources.add('config.completionUsdPer1k');
    }
  }

  if (promptUsdPer1k == null) {
    const envPrompt = parseUsdRate(process.env.DEFAULT_PROMPT_USD_PER_1K);
    if (envPrompt != null) {
      promptUsdPer1k = envPrompt;
      sources.add('env.DEFAULT_PROMPT_USD_PER_1K');
    }
  }

  if (completionUsdPer1k == null) {
    const envCompletion = parseUsdRate(process.env.DEFAULT_COMPLETION_USD_PER_1K);
    if (envCompletion != null) {
      completionUsdPer1k = envCompletion;
      sources.add('env.DEFAULT_COMPLETION_USD_PER_1K');
    }
  }

  const source = sources.size ? Array.from(sources).join(',') : 'unknown';
  return { promptUsdPer1k, completionUsdPer1k, source };
}

/**
 * Fetches graph context from tools-gateway for RAG enhancement in agent conversations.
 */
async function fetchGraphContext({ conversationId, toolsGatewayUrl, limit = GRAPH_RELATIONS_LIMIT, timeoutMs = GRAPH_REQUEST_TIMEOUT_MS, entity = null, relationHints = [], passIndex = null, signal = null }) {
  if (!USE_GRAPH_CONTEXT || !conversationId) {
    logger.debug('[rag.graph] Graph context skipped', {
      useGraphContext: USE_GRAPH_CONTEXT,
      conversationId,
    });
    return null;
  }

  const url = `${toolsGatewayUrl}/neo4j/graph_context`;
  const requestPayload = {
    conversation_id: conversationId,
    limit,
    entity: entity?.name || entity || null,
    relation_hints: Array.isArray(relationHints) ? relationHints : undefined,
    pass_index: passIndex,
  };
  if (requestPayload.relation_hints == null) {
    delete requestPayload.relation_hints;
  }
  if (requestPayload.pass_index == null) {
    delete requestPayload.pass_index;
  }

  if (entity?.type) {
    requestPayload.entity_type = entity.type;
  }

  if (typeof requestPayload.entity === 'string' && requestPayload.entity.trim().length === 0) {
    requestPayload.entity = null;
  }

  logger.debug('[rag.graph] Fetching graph context', {
    conversationId,
    toolsGatewayUrl,
    limit,
  });

  try {
    const response = await axios.post(url, requestPayload, { timeout: timeoutMs });

    const lines = Array.isArray(response?.data?.lines) ? response.data.lines : [];
    const queryHint = response?.data?.query_hint ? String(response.data.query_hint) : '';

    logger.debug('[rag.graph] Graph context response', {
      conversationId,
      url,
      linesCount: lines.length,
      hasHint: Boolean(queryHint),
    });

    if (!lines.length && !queryHint) {
      return null;
    }

    return {
      lines: lines.slice(0, limit),
      queryHint,
    };
  } catch (error) {
    const serializedError = {
      message: error?.message,
      code: error?.code,
      stack: error?.stack,
      responseStatus: error?.response?.status,
      responseData: error?.response?.data,
      requestConfig: error?.config
        ? {
            url: error.config.url,
            method: error.config.method,
            timeout: error.config.timeout,
            data: error.config.data,
          }
        : null,
    };

    logger.error('[rag.graph] Failed to fetch graph context', serializedError);

    try {
      if (typeof error?.toJSON === 'function') {
        logger.error('[rag.graph] Axios error JSON', error.toJSON());
      }
    } catch (jsonErr) {
        logger.warn('[rag.graph] Failed to serialize axios error', {
          message: jsonErr?.message,
          stack: jsonErr?.stack,
        });
      }

    return null;
  }
}

/**
 * Вычисляет адаптивный таймаут для суммаризации на основе размера контекста.
 */
function calculateAdaptiveTimeout(contextLength, baseTimeoutMs) {
  const BASE_CONTEXT_SIZE = 50000;
  
  if (contextLength <= BASE_CONTEXT_SIZE) {
    return baseTimeoutMs;
  }

  const extraChunks = Math.ceil((contextLength - BASE_CONTEXT_SIZE) / BASE_CONTEXT_SIZE);
  const additionalTimeout = extraChunks * 20000;
  
  const MAX_TIMEOUT = 300000;
  const adaptiveTimeout = Math.min(baseTimeoutMs + additionalTimeout, MAX_TIMEOUT);
  
  logger.debug('[rag.timeout.adaptive]', {
    contextLength,
    baseTimeoutMs,
    adaptiveTimeout,
    extraChunks,
    additionalTimeout,
  });
  
  return adaptiveTimeout;
}

/**
 * Performs map-reduce condensation on context text for RAG using configured providers.
 */
async function mapReduceContext({
  req,
  res,
  endpointOption,
  contextText,
  userQuery,
  graphContext = null,
  summarizationConfig = null,
}) {
  const providersPreview = getCondenseProvidersPreview();
  logger.info('[rag.context.summarize.start]', {
    contextLength: contextText.length,
    providersPreview,
  });

  const defaults = {
    budgetChars: 50000,
    chunkChars: 30000,
    timeoutMs: 125000,
  };

  const {
    budgetChars: cfgBudget,
    chunkChars: cfgChunk,
    provider: cfgProvider,
    timeoutMs: cfgTimeout,
  } = summarizationConfig ?? defaults;

  const budgetChars =
    Number.isFinite(cfgBudget) && cfgBudget > 0 ? Number(cfgBudget) : defaults.budgetChars;
  const chunkChars =
    Number.isFinite(cfgChunk) && cfgChunk > 0 ? Number(cfgChunk) : defaults.chunkChars;
  const provider = cfgProvider && typeof cfgProvider === 'string' ? cfgProvider : undefined;
  
  const baseTimeout = Number.isFinite(cfgTimeout) && cfgTimeout > 0 ? Number(cfgTimeout) : defaults.timeoutMs;
  const adaptiveTimeout = calculateAdaptiveTimeout(contextText.length, baseTimeout);

  try {
    const finalContext = await ragCondenseContext({
      req,
      res,
      endpointOption,
      contextText,
      userQuery,
      graphContext,
      budgetChars,
      chunkChars,
      provider,
      timeoutMs: adaptiveTimeout,
    });

    logger.info('[rag.context.summarize.complete]', {
      initialLength: contextText.length,
      finalLength: finalContext.length,
      budgetChars,
      chunkChars,
      provider,
      timeoutMs: adaptiveTimeout,
    });

    return finalContext;
  } catch (error) {
    logger.error('[rag.context.summarize.error]', {
      message: error?.message,
      stack: error?.stack,
      contextLength: contextText.length,
      timeoutMs: adaptiveTimeout,
    });

    return contextText;
  }
}

const omitTitleOptions = new Set([
  'stream',
  'thinking',
  'streaming',
  'clientOptions',
  'thinkingConfig',
  'thinkingBudget',
  'includeThoughts',
  'maxOutputTokens',
  'additionalModelRequestFields',
]);

const featuresConfig = configService.getSection('features');
const memoryStaticConfig = configService.getSection('memory');
const agentsConfig = configService.getSection('agents');
const pricingConfig = configService.getSection('pricing');

const getBoolean = (path, fallback) => configService.getBoolean(path, fallback);
const getNumber = (path, fallback) => configService.getNumber(path, fallback);
const getString = (path, fallback) => {
  const value = configService.get(path, fallback);
  return value == null ? fallback : value;
};

const DEBUG_SSE = configService.getBoolean('logging.debugSse', false);

const IngestedHistory = new Set();

const HIST_LONG_USER_TO_RAG = configService.getNumber('rag.history.histLongUserToRag', 20000);
const OCR_TO_RAG_THRESHOLD = configService.getNumber('rag.history.ocrToRagThreshold', 15000);
const WAIT_FOR_RAG_INGEST_MS = configService.getNumber('rag.history.waitForIngestMs', 0);
const ASSIST_LONG_TO_RAG = configService.getNumber('rag.history.assistLongToRag', 15000);
const ASSIST_SNIPPET_CHARS = configService.getNumber('rag.history.assistSnippetChars', 1500);

const GOOGLE_CHAIN_BUFFER = (configService.get('features.googleChainBuffer', 'off') || 'off').toLowerCase();
const GEMINI_CHAIN_WINDOW = configService.getNumber('features.geminiChainWindow', 5);

const USE_GRAPH_CONTEXT = typeof memoryStaticConfig.useGraphContext === 'boolean'
  ? memoryStaticConfig.useGraphContext
  : configService.getBoolean('features.useGraphContext', true);

const GRAPH_RELATIONS_LIMIT = configService.getNumber('memory.graphContext.maxLines', 40);
const GRAPH_CONTEXT_LINE_LIMIT = configService.getNumber('memory.graphContext.maxLines', 40);
const GRAPH_CONTEXT_MAX_LINE_CHARS = configService.getNumber('memory.graphContext.maxLineChars', 200);
const GRAPH_REQUEST_TIMEOUT_MS = configService.getNumber('memory.graphContext.requestTimeoutMs', 10000);
const GRAPH_QUERY_HINT_MAX_CHARS = configService.getNumber('memory.graphContext.summaryHintMaxChars', 2000);
const RAG_QUERY_MAX_CHARS = configService.getNumber('memory.ragQuery.maxChars', 6000);

const MEMORY_TASK_TIMEOUT_MS = configService.getNumber('memory.queue.taskTimeoutMs', 30000);
const DEFAULT_ENCODING = getString('agents.encoding.defaultTokenizerEncoding', 'o200k_base');
const DEFAULT_SYSTEM_PROMPT = 'Ты самый полезный ИИ-помощник. Всегда в приоритете используй русский язык для ответов.';

const logger = getLogger('agents.client');

/**
 * Provides safe logger methods with environment-aware fallbacks.
 */
const createSafeLogger = () => ({
  info: (...args) => logger.info(...args),
  warn: (...args) => logger.warn(...args),
  error: (...args) => logger.error(...args),
});

const { info: safeInfo, warn: safeWarn, error: safeError } = createSafeLogger();

/**
 * Wraps a promise with a timeout.
 */
function withTimeout(promise, timeoutMs, timeoutMessage = 'Operation timed out') {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${timeoutMessage} after ${timeoutMs} ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Normalizes instruction payload into a consistent object format.
 */
function normalizeInstructionsPayload(rawInstructions, getEncoding, logPrefix = '[AgentClient]') {
  const resolveEncoding = () => {
    if (typeof getEncoding === 'function') {
      try {
        const resolved = getEncoding();
        if (resolved) {
          return resolved;
        }
      } catch (error) {
        safeWarn(`${logPrefix} Failed to resolve encoding via function: ${error.message}`);
      }
    } else if (typeof getEncoding === 'string' && getEncoding.length > 0) {
      return getEncoding;
    }
    return DEFAULT_ENCODING;
  };

  const encoding = resolveEncoding();

  const computeTokens = (text) => {
    if (!text) {
      return 0;
    }
    if (Tokenizer?.getTokenCount) {
      try {
        return Tokenizer.getTokenCount(text, encoding);
      } catch (error) {
        safeWarn(`${logPrefix} Failed to count tokens: ${error.message}`);
      }
    } else {
      safeWarn(`${logPrefix} Tokenizer unavailable, using string length as estimate.`);
    }
    return text.length;
  };

  if (rawInstructions == null) {
    return { content: '', tokenCount: 0 };
  }

  if (typeof rawInstructions === 'object') {
    if (rawInstructions.content == null || typeof rawInstructions.content !== 'string') {
      safeWarn(`${logPrefix} Instructions object missing valid content property.`);
      return { content: '', tokenCount: 0 };
    }

    const tokenCount = computeTokens(rawInstructions.content);
    if (rawInstructions.tokenCount !== tokenCount) {
      safeInfo(
        `${logPrefix} Recomputed instruction tokens. Length: ${rawInstructions.content.length}, Tokens: ${tokenCount}`,
      );
    }
    return {
      content: rawInstructions.content,
      tokenCount,
    };
  }

  if (typeof rawInstructions !== 'string') {
    safeWarn(`${logPrefix} Unsupported instructions type: ${typeof rawInstructions}`);
    return { content: '', tokenCount: 0 };
  }

  const tokenCount = computeTokens(rawInstructions);
  safeInfo(
    `${logPrefix} Converted string instructions. Length: ${rawInstructions.length}, Tokens: ${tokenCount}`,
  );
  return {
    content: rawInstructions,
    tokenCount,
  };
}

/**
 * Extracts text content from a message object.
 */
function extractMessageText(message, logPrefix = '[AgentClient]', options = {}) {
  const { silent = false } = options ?? {};
  const warn = (...args) => {
    if (!silent) {
      safeWarn(...args);
    }
  };

  if (!message) {
    warn(`${logPrefix} extractMessageText received null/undefined message`);
    return '';
  }

  if (typeof message.text === 'string') {
    const trimmedText = message.text.trim();
    if (trimmedText.length > 0) {
      return message.text;
    }
  }

  if (typeof message.content === 'string') {
    const trimmedContent = message.content.trim();
    if (trimmedContent.length > 0) {
      return message.content;
    }
  }

  if (message.content && typeof message.content === 'object' && !Array.isArray(message.content)) {
    warn(`${logPrefix} message.content is an object, not string/array. Returning empty string.`);
    return '';
  }

  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part && part.type === 'text' && part.text != null && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }

  return '';
}

/**
 * Normalizes and cleans memory text for RAG processing.
 */
function normalizeMemoryText(text, logPrefix = '[history->RAG]') {
  if (text == null) {
    return '';
  }
  if (typeof text !== 'string') {
    safeWarn(`${logPrefix} Ожидалась строка для нормализации, получено: ${typeof text}`);
    return '';
  }
  let normalized = text;
  try {
    normalized = text.normalize('NFC');
  } catch (error) {
    safeWarn(`${logPrefix} Не удалось нормализовать текст`, { message: error?.message });
  }
  const cleaned = normalized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return cleaned.trim();
}

/**
 * Generates a unique ingest key for deduplication in RAG.
 */
function makeIngestKey(convId, msgId, raw) {
  if (msgId) return `ing:${convId}:${msgId}`;
  const hash = crypto.createHash('md5').update(String(raw || '')).digest('hex');
  return `ing:${convId}:${hash}`;
}

/**
 * Condenses RAG query text by deduplicating and truncating.
 */
function condenseRagQuery(text, limit = RAG_QUERY_MAX_CHARS) {
  if (!text) {
    return '';
  }

  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) {
    return '';
  }

  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const deduped = [];
  const seen = new Set();
  for (const line of lines) {
    if (!seen.has(line)) {
      deduped.push(line);
      seen.add(line);
    }
  }

  let condensed = deduped.join('\n').trim();
  if (condensed.length <= limit) {
    return condensed;
  }

  const half = Math.max(1, Math.floor(limit / 2));
  const head = condensed.slice(0, half);
  const tail = condensed.slice(-half);
  return `${head}\n...\n${tail}`;
}

/**
 * Checks if the agent uses a Google/Gemini model.
 */
function isGoogleModel(agent) {
  const model = agent?.model_parameters?.model || agent?.model || '';
  return agent?.provider === Providers.GOOGLE || /gemini/i.test(model);
}

/**
 * Parses model parameters based on endpoint type.
 */
const payloadParser = ({ req, agent, endpoint }) => {
  if (isAgentsEndpoint(endpoint)) {
    return { model: undefined };
  } else if (endpoint === EModelEndpoint.bedrock) {
    const parsedValues = bedrockInputSchema.parse(agent.model_parameters);
    if (parsedValues.thinking == null) {
      parsedValues.thinking = false;
    }
    return parsedValues;
  }
  return req.body.endpointOption.model_parameters;
};

const noSystemModelRegex = [/\b(o1-preview|o1-mini|amazon\.titan-text)\b/gi];

/**
 * Creates a token counter function for messages.
 */
function createTokenCounter(encoding) {
  return function (message) {
    const countTokens = (text) => Tokenizer.getTokenCount(text, encoding);
    return getTokenCountForMessage(message, countTokens);
  };
}

/**
 * Logs tool errors with structured details.
 */
function logToolError(graph, error, toolId) {
  logAxiosError({
    error,
    message: `[api/server/controllers/agents/client.js #chatCompletion] Tool Error "${toolId}"`,
  });
}

/**
 * Detects if error is context overflow (400 with token limit message).
 */
function detectContextOverflow(error) {
  if (!error) {
    return false;
  }

  const status = error?.status || error?.response?.status || error?.code;
  if (status !== 400 && status !== '400') {
    return false;
  }

  const message = error?.message || error?.response?.data?.message || '';
  const lowerMessage = String(message).toLowerCase();

  return (
    lowerMessage.includes('context length') ||
    lowerMessage.includes('maximum context') ||
    lowerMessage.includes('token') && (lowerMessage.includes('exceed') || lowerMessage.includes('limit'))
  );
}

/**
 * Aggressively compresses messages for retry after context overflow.
 */
function compressMessagesForRetry(messages, targetReduction = 0.5) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const compressed = [];
  const keepSystemMessage = messages.find(m => m._getType && m._getType() === 'system');
  
  if (keepSystemMessage) {
    const systemContent = typeof keepSystemMessage.content === 'string' 
      ? keepSystemMessage.content 
      : JSON.stringify(keepSystemMessage.content);
    
    const maxSystemLength = Math.floor(systemContent.length * (1 - targetReduction));
    const truncatedSystem = systemContent.slice(0, maxSystemLength);
    
    compressed.push(new SystemMessage({ 
      content: truncatedSystem + '\n[...system message truncated due to context limit...]' 
    }));
  }

  const nonSystemMessages = messages.filter(m => !m._getType || m._getType() !== 'system');
  const keepCount = Math.max(3, Math.floor(nonSystemMessages.length * (1 - targetReduction)));
  const recentMessages = nonSystemMessages.slice(-keepCount);

  for (const msg of recentMessages) {
    const messageType = msg._getType ? msg._getType() : 'unknown';
    let content = msg.content;

    if (typeof content === 'string') {
      const maxLength = Math.floor(content.length * (1 - targetReduction));
      if (content.length > maxLength) {
        content = content.slice(0, maxLength) + '\n[...truncated...]';
      }
    } else if (Array.isArray(content)) {
      content = content
        .filter(part => part.type === 'text')
        .map(part => {
          const text = part.text || '';
          const maxLength = Math.floor(text.length * (1 - targetReduction));
          return {
            type: 'text',
            text: text.length > maxLength ? text.slice(0, maxLength) + '\n[...truncated...]' : text
          };
        });
    }

    if (messageType === 'human') {
      compressed.push(new HumanMessage({ content }));
    } else {
      compressed.push(msg.constructor ? new msg.constructor({ content }) : { ...msg, content });
    }
  }

  return compressed;
}

/**
 * Marks messages as stored in memory (bulk update)
 * @param {Object} req - Request object
 * @param {Array<string>} messageIds - Array of message IDs to mark
 * @returns {Promise<void>}
 */
async function markMessagesAsStored(req, messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return;
  }

  try {
    const Message = require('~/db/models').Message;
    const result = await Message.updateMany(
      {
        messageId: { $in: messageIds },
        user: req.user.id,
      },
      {
        $set: { isMemoryStored: true },
      },
    );

    logger.debug('[markMessagesAsStored] Marked messages as stored', {
      messageIds,
      modifiedCount: result?.modifiedCount,
    });
  } catch (error) {
    logger.error('[markMessagesAsStored] Failed to mark messages', {
      messageIds,
      error: error?.message,
    });
  }
}

/**
 * Agent client for handling AI agent interactions, RAG, and tool integrations.
 */
class AgentClient extends BaseClient {
  constructor(options = {}) {
    super(null, options);
    this.clientName = EModelEndpoint.agents;
    this.contextStrategy = 'discard';
    this.isChatCompletion = true;
    this.run;

    const {
      agentConfigs,
      contentParts,
      collectedUsage,
      artifactPromises,
      maxContextTokens,
      ...clientOptions
    } = options;

    this.agentConfigs = agentConfigs;
    this.maxContextTokens = maxContextTokens;
    if (!this.maxContextTokens) this.maxContextTokens = 32000;
    this.contentParts = contentParts;
    this.collectedUsage = collectedUsage;
    this.artifactPromises = artifactPromises;
    this.options = Object.assign({ endpoint: options.endpoint }, clientOptions);
    this.model = this.options.agent.model_parameters.model;
    this.inputTokensKey = 'input_tokens';
    this.outputTokensKey = 'output_tokens';
    this.usage;
    this.indexTokenCountMap = {};
    this.processMemory;
    this.historyManager = new MessageHistoryManager({
      ingestedHistory: IngestedHistory,
      get config() {
        return runtimeMemoryConfig.getMemoryConfig();
      },
      memoryTaskTimeout: MEMORY_TASK_TIMEOUT_MS,
    });

    const TRACE_PIPELINE = configService.getBoolean('logging.tracePipeline', false);
    this.trace = (label, data = {}) => {
      try {
        if (!TRACE_PIPELINE) {
          return;
        }
        const meta = {
          label,
          cid: this.conversationId,
          rid: this.responseMessageId,
          pid: process.pid,
        };
        const safe = (v) => {
          try {
            if (typeof v === 'string' && v.length > 500) {
              return `${v.slice(0, 250)} … ${v.slice(-150)}`;
            }
            return v;
          } catch {
            return v;
          }
        };
        const cleaned = {};
        for (const [k, v] of Object.entries(data || {})) {
          cleaned[k] = safe(v);
        }
        logger.info('[trace]', { ...meta, ...cleaned });
      } catch (error) {
        logger.warn(
          `[trace] failed to emit trace log: ${error?.message || error}`,
        );
      }
    };
  }

  getContentParts() {
    return this.contentParts;
  }

  setOptions(options) {
    logger.debug('[AgentClient] setOptions', options);
  }

  checkVisionRequest() {}

  getSaveOptions() {
    let runOptions = {};
    try {
      runOptions = payloadParser(this.options);
    } catch (error) {
      logger.error(
        '[api/server/controllers/agents/client.js #getSaveOptions] Error parsing options',
        error,
      );
    }

    return removeNullishValues(
      Object.assign(
        {
          endpoint: this.options.endpoint,
          agent_id: this.options.agent.id,
          modelLabel: this.options.modelLabel,
          maxContextTokens: this.options.maxContextTokens,
          resendFiles: this.options.resendFiles,
          imageDetail: this.options.imageDetail,
          spec: this.options.spec,
          iconURL: this.options.iconURL,
        },
        runOptions,
      ),
    );
  }

  getBuildMessagesOptions() {
    return {
      instructions: this.options.agent.instructions,
      additional_instructions: this.options.agent.additional_instructions,
    };
  }

  async addImageURLs(message, attachments) {
    const { files, text: ocrText, image_urls } = await encodeAndFormat(
      this.options.req,
      attachments,
      this.options.agent.provider,
      VisionModes.agents,
    );

    const convId = this.options.req.body.conversationId;
    const userId = this.options.req.user.id;

    const isTextFile = files && files.length > 0 && files[0].type && files[0].type.startsWith('text/');
    const isLargeEnough = ocrText && ocrText.length > (OCR_TO_RAG_THRESHOLD ?? 15000);

    if (isTextFile && isLargeEnough && convId && userId) {
      const file = files[0];
      const dedupeKey = makeIngestKey(convId, file.file_id, ocrText);
      if (IngestedHistory.has(dedupeKey)) {
        logger.info(`[file-ingest][dedup] файл ${file.file_id} уже в работе.`);
      } else {
        IngestedHistory.add(dedupeKey);
        const task = {
          type: 'index_file',
          payload: {
            user_id: userId,
            conversation_id: convId,
            file_id: file.file_id,
            text_content: ocrText,
            source_filename: file.originalname || file.filename || null,
            mime_type: file.type || null,
            file_size: file.size || null,
          },
        };

        try {
          const result = await withTimeout(
            enqueueMemoryTasks(
              [task],
              {
                reason: 'index_file',
                conversationId: convId,
                userId,
                fileId: file.file_id,
                textLength: ocrText.length,
              },
            ),
            Math.min(MEMORY_TASK_TIMEOUT_MS, 10000),
            'Memory indexing timed out',
          );
            
          if (this.options?.req && result?.status === 'queued') {
            this.options.req.didEnqueueIngest = true;
          }
        } catch (queueError) {
          safeError('[file-ingest] Failed to enqueue memory task', {
            conversationId: convId,
            fileId: file.file_id,
            message: queueError?.message,
          });
        }
      }
    } else if (image_urls && image_urls.length > 0) {
      message.image_urls = image_urls;
    }

    return files;
  }


  async buildRagContext({
    orderedMessages,
    systemContent,
    runtimeCfg,
    req,
    res,
    endpointOption,
  }) {
    ragCacheTtlMs = Math.max(Number(runtimeCfg.ragCacheTtl) * 1000, 0);
    const conversationId = this.conversationId;
    const userMessage = orderedMessages.slice(-1)[0];
    const userQuery = userMessage?.text ?? '';
    const encoding = this.getEncoding ? this.getEncoding() : 'o200k_base';
    const multiStepEnabled = Boolean(runtimeCfg?.multiStepRag?.enabled);

    if (req) {
      setDeferredContext(req, null);
    }

    if (!runtimeCfg.useConversationMemory || !conversationId || !userQuery) {
      logger.debug('[rag.context.skip]', {
        conversationId,
        reason: 'disabled_or_empty_query',
        enableMemoryCache: runtimeCfg.enableMemoryCache,
      });
      return {
        patchedSystemContent: systemContent,
        contextLength: 0,
        cacheStatus: 'skipped',
        metrics: {},
      };
    }

    pruneExpiredRagCache();

    const queryMaxChars = runtimeCfg?.ragQuery?.maxChars || 6000;
    if (userQuery.length > queryMaxChars) {
      logger.debug(
        `[rag.context.limit] conversation=${conversationId} param=memory.ragQuery.maxChars limit=${queryMaxChars} original=${userQuery.length}`
      );
    }

    const normalizedQuery = userQuery.slice(0, queryMaxChars);
    if (req) {
      req.ragUserQuery = normalizedQuery;
    }
    const queryTokenCount = Tokenizer.getTokenCount(normalizedQuery, encoding);
    logger.debug(
      `[rag.context.query.tokens] conversation=${conversationId} length=${normalizedQuery.length} tokens=${queryTokenCount}`
    );

    const queryHash = hashPayload(normalizedQuery);
    const configHash = hashPayload({
      graph: runtimeCfg.graphContext,
      vector: runtimeCfg.vectorContext,
      summarization: runtimeCfg.summarization,
    });

    const cacheKey = createCacheKey({
      conversationId,
      endpoint: endpointOption?.endpoint || this.options?.endpoint,
      model: endpointOption?.model || this.options?.model,
      queryHash,
      configHash,
    });

    const metrics = {
      graphTokens: 0,
      vectorTokens: 0,
      contextTokens: 0,
      graphLines: 0,
      vectorChunks: 0,
      queryTokens: queryTokenCount,
    };

    let contextLength = 0;
    let finalSystemContent = systemContent;
    const now = Date.now();
    let cacheStatus = 'skipped';

    if (runtimeCfg.enableMemoryCache) {
      const cached = ragCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        cacheStatus = 'hit';
        observeCache('hit');
        const cachedMetrics = cached.metrics || {};
        logger.info(
          `[rag.context.cache.hit] conversation=${conversationId} cacheKey=${cacheKey} contextTokens=${cachedMetrics.contextTokens ?? 0} graphTokens=${cachedMetrics.graphTokens ?? 0} vectorTokens=${cachedMetrics.vectorTokens ?? 0} queryTokens=${cachedMetrics.queryTokens ?? 0}`
        );
        if (req) {
          req.cachedGraphContext = {
            graphLines: cached.graphLines || [],
            graphQueryHint: cached.graphQueryHint || '',
          };
        }
        return {
          patchedSystemContent: cached.systemContent,
          contextLength: cached.contextLength,
          cacheStatus,
          metrics: cachedMetrics,
        };
      }

      cacheStatus = 'miss';
      observeCache('miss');
      logger.debug(
        `[rag.context.cache.miss] conversation=${conversationId} cacheKey=${cacheKey}`
      );
    } else {
      logger.debug('[rag.context.cache.skip]', {
        conversationId,
        cacheKey,
        reason: 'cache_disabled',
      });
    }

    const toolsGatewayUrl = runtimeCfg?.toolsGateway?.url || '';
    const toolsGatewayTimeout = runtimeCfg?.toolsGateway?.timeoutMs || 20000;
    const graphLimits = runtimeCfg.graphContext || {};
    const vectorLimits = runtimeCfg.vectorContext || {};

    const graphMaxLines = Number(graphLimits.maxLines ?? 40);
    const graphMaxLineChars = Number(graphLimits.maxLineChars ?? 200);
    const graphSummaryHintMaxChars = Number(graphLimits.summaryHintMaxChars ?? 2000);

    const vectorMaxChunks = Number(vectorLimits.maxChunks ?? 4);
    const vectorMaxChars = Number(vectorLimits.maxChars ?? 70000);
    const vectorTopK = Number(vectorLimits.topK ?? 12);
    const embeddingModel = vectorLimits.embeddingModel;
    const recentTurns = Number(vectorLimits.recentTurns ?? 6);

    let graphContextLines = [];
    let graphQueryHint = '';
    let rawGraphLinesCount = 0;

    if (toolsGatewayUrl) {
      try {
        const graphContext = await fetchGraphContext({
          conversationId,
          toolsGatewayUrl,
          limit: graphMaxLines,
          timeoutMs: toolsGatewayTimeout,
        });

        rawGraphLinesCount = Array.isArray(graphContext?.lines) ? graphContext.lines.length : 0;

        if (graphContext?.lines?.length) {
          graphContextLines = sanitizeGraphContext(graphContext.lines, {
            maxLines: graphMaxLines,
            maxLineChars: graphMaxLineChars,
          });

          if (rawGraphLinesCount > graphContextLines.length && graphMaxLines) {
            logger.debug(
              `[rag.context.limit] conversation=${conversationId} param=memory.graphContext.maxLines limit=${graphMaxLines} original=${rawGraphLinesCount}`
            );
          }

          if (
            graphContextLines.some((line) => line.endsWith('…')) &&
            graphMaxLineChars
          ) {
            logger.debug(
              `[rag.context.limit] conversation=${conversationId} param=memory.graphContext.maxLineChars limit=${graphMaxLineChars}`
            );
          }
        }

        logger.debug(
          `[rag.context.graph.raw] conversation=${conversationId} rawLines=${rawGraphLinesCount} sanitizedLines=${graphContextLines.length}`
        );

        if (typeof graphContext?.queryHint === 'string') {
          const trimmedHint = graphContext.queryHint.trim();
          if (trimmedHint) {
            if (
              graphSummaryHintMaxChars &&
              trimmedHint.length > graphSummaryHintMaxChars
            ) {
              logger.debug(
                `[rag.context.limit] conversation=${conversationId} param=memory.graphContext.summaryHintMaxChars limit=${graphSummaryHintMaxChars} original=${trimmedHint.length}`
              );
            }
            graphQueryHint = trimmedHint.slice(
              0,
              graphSummaryHintMaxChars || trimmedHint.length,
            );
          }
        }
      } catch (error) {
        logger.error('[rag.context.graph.error]', {
          conversationId,
          message: error?.message,
          stack: error?.stack,
        });
      }
    } else {
      logger.debug('[rag.context.graph.skip]', {
        conversationId,
        reason: 'tools_gateway_missing',
      });
    }

    metrics.graphLines = graphContextLines.length;

    let ragSearchQuery = normalizedQuery;
    if (graphQueryHint) {
      ragSearchQuery = `${normalizedQuery}

Graph hints: ${graphQueryHint}`;
    }

    const condensedQuery = condenseRagQuery(ragSearchQuery, queryMaxChars);
    if (condensedQuery.length < ragSearchQuery.length) {
      logger.debug('[rag.context.query.condensed]', {
        conversationId,
        originalLength: ragSearchQuery.length,
        condensedLength: condensedQuery.length,
      });
    }
    ragSearchQuery = condensedQuery;

    let vectorChunks = [];
    let recentChunks = [];
    let rawVectorResults = 0;

    if (toolsGatewayUrl) {
      try {
        const response = await axios.post(
          `${toolsGatewayUrl}/rag/search`,
          {
            query: ragSearchQuery,
            top_k: vectorTopK,
            embedding_model: embeddingModel,
            conversation_id: conversationId,
            user_id: req?.user?.id,
          },
          { timeout: toolsGatewayTimeout },
        );

        const rawChunks = Array.isArray(response?.data?.results)
          ? response.data.results.map((item) => item?.content ?? '').filter(Boolean)
          : [];

        rawVectorResults = rawChunks.length;

        vectorChunks = sanitizeVectorChunks(rawChunks, {
          maxChunks: vectorMaxChunks,
          maxChars: vectorMaxChars,
        });

        logger.debug(
          `[rag.context.vector.raw] conversation=${conversationId} rawResults=${rawVectorResults} sanitizedChunks=${vectorChunks.length} topK=${vectorTopK}`
        );
        logger.debug('[rag.context.vector.limits]', { 
          conversationId, 
          maxChunks: vectorMaxChunks, 
          recentTurns, 
          topK: vectorTopK 
        });
      } catch (error) {
        logger.error('[rag.context.vector.error]', {
          conversationId,
          message: error?.message,
          stack: error?.stack,
        });
      }

      if (recentTurns > 0) {
        try {
          const recentResp = await axios.post(
            `${toolsGatewayUrl}/rag/recent`,
            { 
              conversation_id: conversationId, 
              limit: recentTurns, 
              user_id: req?.user?.id 
            },
            { timeout: toolsGatewayTimeout },
          );

          const rawRecent = Array.isArray(recentResp?.data?.results)
            ? recentResp.data.results.map(r => r?.content ?? '').filter(Boolean)
            : [];

          recentChunks = sanitizeVectorChunks(rawRecent, {
            maxChunks: recentTurns,
            maxChars: vectorMaxChars,
          });

          logger.debug('[rag.context.recent]', { 
            conversationId, 
            recentTurns, 
            got: recentChunks.length 
          });
        } catch (e) {
          const status = e?.response?.status;
          if (status === 404 || status === 501) {
            logger.debug('[rag.context.recent.unavailable]', { conversationId, status });
          } else {
            logger.warn('[rag.context.recent.skip]', { 
              conversationId, 
              reason: e?.message, 
              status 
            });
          }
        }
      }

      const merged = [];
      const seen = new Set();

      for (const c of [...recentChunks, ...vectorChunks]) {
        const key = c.trim();
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(c);
      }

      vectorChunks = merged.slice(0, vectorMaxChunks);

      if (rawVectorResults > vectorChunks.length && vectorMaxChunks) {
        logger.debug(
          `[rag.context.limit] conversation=${conversationId} param=memory.vectorContext.maxChunks limit=${vectorMaxChunks} original=${rawVectorResults}`
        );
      }

      if (
        vectorChunks.some((chunk) => chunk.endsWith('…')) &&
        vectorMaxChars
      ) {
        logger.debug(
          `[rag.context.limit] conversation=${conversationId} param=memory.vectorContext.maxChars limit=${vectorMaxChars}`
        );
      }
    } else {
      logger.debug('[rag.context.vector.skip]', {
        conversationId,
        reason: 'tools_gateway_missing',
      });
    }

    metrics.vectorChunks = vectorChunks.length;

    const hasGraph = graphContextLines.length > 0;
    const hasVector = vectorChunks.length > 0;
    const policyIntro =
      'Ниже предоставлен внутренний контекст для твоего сведения: граф знаний и выдержки из беседы. ' +
      'Используй эти данные для формирования точного и полного ответа. ' +
      'Категорически запрещается цитировать или пересказывать этот контекст, особенно строки, содержащие "-->". ' +
      'Эта информация предназначена только для твоего внутреннего анализа.\n\n';

    if (!hasGraph && !hasVector) {
      logger.debug(
        `[rag.context.tokens] conversation=${conversationId} graphTokens=0 vectorTokens=0 contextTokens=0`
      );
    } else {
      const summarizationCfg = runtimeCfg.summarization || {};
      const defaults = { 
        budgetChars: 12000, 
        chunkChars: 20000,
        timeoutMs: 125000,
      };
      const budgetChars =
        Number.isFinite(summarizationCfg?.budgetChars) && summarizationCfg.budgetChars > 0
          ? summarizationCfg.budgetChars
          : defaults.budgetChars;
      const chunkChars =
        Number.isFinite(summarizationCfg?.chunkChars) && summarizationCfg.chunkChars > 0
          ? summarizationCfg.chunkChars
          : defaults.chunkChars;
      const baseTimeoutMs = Number.isFinite(summarizationCfg?.timeoutMs) && summarizationCfg.timeoutMs > 0
        ? summarizationCfg.timeoutMs
        : defaults.timeoutMs;

      let vectorText = vectorChunks.join('\n\n');
      const rawVectorTextLength = vectorText.length;
      const shouldSummarize =
        !multiStepEnabled &&
        summarizationCfg.enabled !== false &&
        vectorText.length > budgetChars;

      if (shouldSummarize) {
        logger.debug(
          `[rag.context.limit] conversation=${conversationId} param=memory.summarization.budgetChars limit=${budgetChars} original=${rawVectorTextLength}`
        );
        try {
          const adaptiveTimeoutMs = calculateAdaptiveTimeout(rawVectorTextLength, baseTimeoutMs);
          
          logger.debug('[rag.context.summarize.timeout]', {
            conversationId,
            contextLength: rawVectorTextLength,
            baseTimeoutMs,
            adaptiveTimeoutMs,
            configuredTimeout: summarizationCfg?.timeoutMs,
          });
          
          vectorText = await withTimeout(
            mapReduceContext({
              req,
              res,
              endpointOption,
              contextText: vectorText,
              userQuery: normalizedQuery,
              graphContext: hasGraph
                ? { lines: graphContextLines, queryHint: graphQueryHint }
                : null,
              summarizationConfig: {
                budgetChars,
                chunkChars,
                provider: summarizationCfg.provider,
                timeoutMs: adaptiveTimeoutMs,
              },
            }),
            adaptiveTimeoutMs,
            'RAG summarization timed out'
          );
        } catch (summarizeError) {
          logger.error('[rag.context.vector.summarize.error]', {
            message: summarizeError?.message,
            stack: summarizeError?.stack,
            timeout: summarizeError?.message?.includes('timed out'),
            contextLength: rawVectorTextLength,
          });
          
          if (summarizeError?.message?.includes('timed out')) {
            const fallbackLength = Math.min(vectorText.length, budgetChars);
            vectorText = vectorText.slice(0, fallbackLength);
            logger.warn(
              `[rag.context.vector.summarize.fallback] Using truncated text (${fallbackLength} chars) due to timeout`
            );
          }
        }
      }

      const ragBlock = buildRagBlock({
        policyIntro,
        graphLines: hasGraph ? graphContextLines : [],
        vectorText,
      });

      let sanitizedBlock = ragBlock;
      try {
        sanitizedBlock = sanitizeInput(ragBlock);
      } catch (sanitizeError) {
        logger.error('[rag.context.sanitize.error]', {
          message: sanitizeError?.message,
          stack: sanitizeError?.stack,
        });
      }

      finalSystemContent = sanitizedBlock + systemContent;
      contextLength = sanitizedBlock.length;

      if (hasGraph) {
        const graphText = graphContextLines.join('\n');
        metrics.graphTokens = graphText
          ? Tokenizer.getTokenCount(graphText, encoding)
          : 0;

        if (metrics.graphTokens) {
          observeSegmentTokens({
            segment: 'rag_graph',
            tokens: metrics.graphTokens,
            endpoint: endpointOption?.endpoint || this.options?.endpoint,
            model: endpointOption?.model || this.options?.model,
          });
          setContextLength({
            segment: 'rag_graph',
            length: graphText.length,
            endpoint: endpointOption?.endpoint || this.options?.endpoint,
            model: endpointOption?.model || this.options?.model,
          });
        }

        logger.info(
          `[rag.context.graph.stats] conversation=${conversationId} lines=${graphContextLines.length} tokens=${metrics.graphTokens}`
        );
      }

      if (vectorText.length) {
        metrics.vectorTokens = Tokenizer.getTokenCount(vectorText, encoding);

        if (metrics.vectorTokens) {
          observeSegmentTokens({
            segment: 'rag_vector',
            tokens: metrics.vectorTokens,
            endpoint: endpointOption?.endpoint || this.options?.endpoint,
            model: endpointOption?.model || this.options?.model,
          });
          setContextLength({
            segment: 'rag_vector',
            length: vectorText.length,
            endpoint: endpointOption?.endpoint || this.options?.endpoint,
            model: endpointOption?.model || this.options?.model,
          });
        }

        logger.info(
          `[rag.context.vector.stats] conversation=${conversationId} chunks=${metrics.vectorChunks} tokens=${metrics.vectorTokens}`
        );
      }

      metrics.contextTokens = sanitizedBlock
        ? Tokenizer.getTokenCount(sanitizedBlock, encoding)
        : metrics.graphTokens + metrics.vectorTokens;

      if (multiStepEnabled && req) {
        logger.info('[rag.context.summarize.deferred]', {
          conversationId,
          graphLines: graphContextLines.length,
          vectorChunks: vectorChunks.length,
        });
        setDeferredContext(req, {
          policyIntro,
          graphLines: graphContextLines,
          graphQueryHint,
          vectorText,
          vectorChunks,
          summarizationConfig: {
            budgetChars,
            chunkChars,
            provider: summarizationCfg.provider,
            timeoutMs: baseTimeoutMs,
            enabled: summarizationCfg.enabled !== false,
          },
          metrics: {
            graphTokens: metrics.graphTokens,
            vectorTokens: metrics.vectorTokens,
            contextTokens: metrics.contextTokens,
          },
        });
      }

      logger.info(
        `[rag.context.tokens] conversation=${conversationId} graphTokens=${metrics.graphTokens} vectorTokens=${metrics.vectorTokens} contextTokens=${metrics.contextTokens}`
      );
    }

    const cachedGraphSnapshot = {
      graphLines: graphContextLines,
      graphQueryHint,
    };

    if (runtimeCfg.enableMemoryCache) {
      ragCache.set(cacheKey, {
        systemContent: finalSystemContent,
        contextLength,
        metrics,
        expiresAt: now + ragCacheTtlMs,
        ...cachedGraphSnapshot,
      });
      logger.debug(
        `[rag.context.cache.store] conversation=${conversationId} cacheKey=${cacheKey} contextTokens=${metrics.contextTokens} graphTokens=${metrics.graphTokens} vectorTokens=${metrics.vectorTokens} queryTokens=${metrics.queryTokens}`
      );
    }

    if (req) {
      req.ragCacheStatus = cacheStatus;
      req.ragMetrics = Object.assign({}, req.ragMetrics, metrics);
      req.ragContextTokens = metrics.contextTokens;
      req.cachedGraphContext = cachedGraphSnapshot;
    }

    return {
      patchedSystemContent: finalSystemContent,
      contextLength,
      cacheStatus,
      metrics,
    };
  }

  async buildMessages(
    messages,
    parentMessageId,
    { instructions = null, additional_instructions = null },
    opts,
  ) {
    const runtimeCfg = runtimeMemoryConfig.getMemoryConfig();
    let orderedMessages = this.constructor.getMessagesForConversation({
      messages,
      parentMessageId,
      summary: this.shouldSummarize,
    });

    orderedMessages = orderedMessages.filter((message) => {
      if (typeof message?.text === 'string' && message.text.startsWith('[[moved_to_memory')) {
        logger.warn('[rag.history.legacy_stub]', {
          conversationId: this.conversationId,
          messageId: message?.messageId,
        });
        return false;
      }
      return true;
    });

    const historyCompressionCfg = runtimeCfg?.historyCompression ?? {};
    const historyCfg = runtimeCfg?.history ?? {};
    const dontShrinkLastN = Number.isFinite(historyCfg?.dontShrinkLastN)
      ? Math.max(historyCfg.dontShrinkLastN, 0)
      : 0;
    const MAX_MESSAGES_TO_PROCESS = historyCompressionCfg?.enabled ? Infinity : 25;
    const conversationId = this.conversationId || this.options?.req?.body?.conversationId;
    const requestUserId = this.options?.req?.user?.id || null;

    let systemMessage = orderedMessages.find(m => m.role === 'system');
    let otherMessages = orderedMessages.filter(m => m.role !== 'system');
    let droppedMessages = [];

    if (otherMessages.length > MAX_MESSAGES_TO_PROCESS) {
      const keptMessages = otherMessages.slice(-MAX_MESSAGES_TO_PROCESS);
      droppedMessages = otherMessages.slice(0, otherMessages.length - MAX_MESSAGES_TO_PROCESS);

      orderedMessages = systemMessage ? [systemMessage, ...keptMessages] : keptMessages;

      logger.warn(`[PROMPT-LIMIT] Принудительно усекаем историю с ${otherMessages.length} до ${MAX_MESSAGES_TO_PROCESS} сообщений. Dropped: ${droppedMessages.length}`);
      
      if (conversationId && requestUserId && droppedMessages.length) {
        setImmediate(() =>
          this.historyManager.processDroppedMessages({
            droppedMessages,
            conversationId,
            userId: requestUserId,
          }),
        );
      }
    }
    logger.debug({
      msg: '[config.history]',
      conversationId: this.conversationId,
      dontShrinkLastN: runtimeCfg?.history?.dontShrinkLastN,
      historyTokenBudget: runtimeCfg?.history?.tokenBudget ?? configService.getNumber('memory.history.tokenBudget', 0),
    });
    ragCacheTtlMs = Math.max(Number(runtimeCfg?.ragCacheTtl) * 1000, 0);
    const shouldCompressHistory = Boolean(historyCompressionCfg?.enabled);
    const endpointOption = this.options?.req?.body?.endpointOption ?? this.options?.endpointOption ?? {};
    logger.debug({
      msg: '[AgentClient.buildMessages] start',
      conversationId: this.conversationId,
      orderedMessagesCount: orderedMessages.length,
    });
    try { this.trace('trace:build.start', {
      total: orderedMessages.length,
      lastIds: orderedMessages.slice(-3).map(m => m && m.messageId).join(',')
    }); } catch {}

    const computeImportanceScore = (message = {}) => {
      if (message.isCreatedByUser || message.role === 'user') {
        return 2;
      }
      if (message.role === 'assistant') {
        return 1;
      }
      return 0;
    };

    const tokenize = (text = '') => {
      try {
        return Tokenizer.getTokenCount(text, this.getEncoding());
      } catch (err) {
        logger.warn('[history->budget] failed to count tokens, fallback to length', {
          message: err?.message,
        });
        return text.length;
      }
    };

    let systemContent = [instructions ?? '', additional_instructions ?? '']
      .filter(Boolean)
      .join('\n')
      .trim();

    if (orderedMessages.length === 0 && systemContent.length === 0) {
        systemContent = DEFAULT_SYSTEM_PROMPT;
        logger.debug('[AgentClient] Applied default system prompt for new chat');
    }
    logger.debug(`[AgentClient] Initial systemContent: ${systemContent.length} chars`);

    let historyTrimmer = null;
    let historyTokenBudget = 0;
    const headroom = Number(historyCompressionCfg?.contextHeadroom) || 0;
    const ragTokens = Number(this.options?.req?.ragContextTokens) || 0;
    const instructionsTokensEstimate = tokenize(systemContent);
    const maxContextTokens =
      this.maxContextTokens ||
      Number(historyCfg?.tokenBudget) ||
      Number(runtimeCfg?.tokenLimits?.maxMessageTokens) ||
      0;

    if (historyCompressionCfg?.enabled) {
      historyTokenBudget =
        maxContextTokens - ragTokens - instructionsTokensEstimate;

      const availableBudget = historyTokenBudget - headroom;

      if (availableBudget > 0) {
        historyTrimmer = new HistoryTrimmer({
          tokenizerEncoding: this.getEncoding(),
          keepLastN: dontShrinkLastN || 6,
          layer1Ratio: historyCompressionCfg.layer1Ratio,
          layer2Ratio: historyCompressionCfg.layer2Ratio,
          contextHeadroom: headroom,
          importanceScorer: computeImportanceScore,
          compressor: new MessageCompressorBridge({ reduction: historyCompressionCfg.layer2Ratio ?? 0.25 }),
        });
        logger.info('[contextCompression.enabled]', {
          conversationId: this.conversationId,
          budgetTokens: availableBudget,
          headroom,
        });
      } else {
        logger.warn('[contextCompression.disabled.budget]', {
          conversationId: this.conversationId,
          budgetTokens: availableBudget,
          ragTokens,
          instructionsTokens: instructionsTokensEstimate,
          headroom,
          maxContextTokens,
        });
      }
    }

    try {
      const {
        toIngest = [],
        modifiedMessages,
        liveWindowStats,
      } = await this.historyManager.processMessageHistory({
        orderedMessages,
        conversationId,
        userId: requestUserId,
        histLongUserToRag: HIST_LONG_USER_TO_RAG,
        assistLongToRag: ASSIST_LONG_TO_RAG,
        assistSnippetChars: ASSIST_SNIPPET_CHARS,
        dontShrinkLastN,
        trimmer: historyTrimmer,
        tokenBudget: historyTokenBudget,
        contextHeadroom: headroom,
      });

      orderedMessages = modifiedMessages;

      if (liveWindowStats) {
        logger.info('[history.live_window.applied]', {
          conversationId: this.conversationId,
          mode: liveWindowStats.mode,
          requestedSize: runtimeCfg?.history?.liveWindow?.size,
          kept: liveWindowStats.kept,
          dropped: liveWindowStats.dropped,
        });
      }

      if (toIngest.length && conversationId) {
        setImmediate(() =>
          this.historyManager.enqueueMemoryTasks({
            toIngest,
            conversationId,
            userId: requestUserId,
            reason: 'history_sync',
          }),
        );
      }
    } catch (error) {
      logger.error('[history->RAG] failed', error);
    }

    let intentWindow = [];
    if (orderedMessages.length) {
      const WINDOW_SIZE = Number(runtimeCfg?.multiStepRag?.intentWindowSize) || 6;
      const rawSlice = orderedMessages.slice(-WINDOW_SIZE);
      intentWindow = rawSlice
        .filter((msg) => msg?.role === 'user' || msg?.role === 'assistant')
        .map((msg) => ({
          role: msg.role,
          text: extractMessageText(msg, '[rag.intent.window]', { silent: true }) || '',
        }))
        .filter((entry) => entry.text);
    }

    const intentAnalysis = runtimeCfg?.multiStepRag?.enabled
      ? await analyzeIntent({
          message: orderedMessages[orderedMessages.length - 1],
          context: intentWindow,
          signal: this.options?.req?.abortController?.signal,
          timeoutMs: runtimeCfg.multiStepRag?.intentTimeoutMs || 2000,
        })
      : { entities: [], needsFollowUps: false };

    const collectFallbackEntities = ({ graphHint, graphLines, vectorChunks, userMessage }) => {
      const candidates = [];
      const rawUserText = extractMessageText(userMessage, '[rag.intent.fallback]', { silent: true }) || '';
      const trimmedUser = rawUserText.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (trimmedUser) {
        candidates.push({ name: trimmedUser, source: 'user' });
      }

      const appendGraphParts = (text, source = 'graph') => {
        if (!text) return;
        const parts = text.split(/-->/).map((part) => part.trim()).filter(Boolean);
        for (const part of parts) {
          if (part.length > 2) {
            candidates.push({ name: part, source });
          }
        }
      };

      if (graphHint?.trim()) {
        appendGraphParts(graphHint.trim(), 'graph');
      }

      for (const line of graphLines || []) {
        appendGraphParts(line, 'graph');
      }

      for (const chunk of vectorChunks || []) {
        const summary = chunk.replace(/\s+/g, ' ').trim().slice(0, 60);
        if (summary.length > 5) {
          candidates.push({ name: summary, source: 'vector' });
        }
      }

      const unique = new Map();
      for (const entry of candidates) {
        const key = entry.name.toLowerCase();
        if (!unique.has(key)) {
          unique.set(key, entry);
        }
      }

      return Array.from(unique.values())
        .slice(0, Number(runtimeCfg?.multiStepRag?.maxFallbackEntities) || 3)
        .map((entry) => ({
          name: entry.name,
          type: 'fallback',
          confidence: 0.4,
          hints: [entry.source],
        }));
    };

    const graphSnapshot = req?.cachedGraphContext || {
      graphLines: graphContextLines,
      graphQueryHint,
    };

    const fallbackEntities = collectFallbackEntities({
      graphHint: graphSnapshot.graphQueryHint,
      graphLines: graphSnapshot.graphLines,
      vectorChunks,
      userMessage: orderedMessages[orderedMessages.length - 1],
    });
    if (!Array.isArray(intentAnalysis?.entities) || intentAnalysis.entities.length === 0) {
      if (fallbackEntities.length) {
        for (const entity of fallbackEntities) {
          logger.info('rag.multiStep.fallback_entity', {
            conversationId: this.conversationId,
            source: entity.hints?.[0],
            name: entity.name.slice(0, 80),
          });
        }
        intentAnalysis = { ...(intentAnalysis || {}), entities: fallbackEntities };
      }
    }

    if (this.options?.req) {
      this.options.req.intentAnalysis = intentAnalysis;
    }

    let ragContextLength = 0;
    let ragCacheStatus = 'skipped';
    const req = this.options?.req;
    const res = this.options?.res;

    if (req) {
      req.ragCacheStatus = ragCacheStatus;
    }

    const waitMsRaw = Number(runtimeCfg?.rag?.history?.waitForIngestMs ?? runtimeCfg?.history?.waitForIngestMs ?? 0);
    const waitMs = Math.min(Math.max(waitMsRaw, 0), 3000);
    const didIngest = Boolean(req?.didEnqueueIngest);
    
    if (didIngest && waitMs > 0) {
      logger.debug('[history->RAG] waiting before rag/search', { 
        conversationId: this.conversationId, 
        waitMs,
        reqDidEnqueueIngest: req?.didEnqueueIngest
      });
      await new Promise((r) => setTimeout(r, waitMs));
    }

    try {
      const ragResult = await this.buildRagContext({
        orderedMessages,
        systemContent,
        runtimeCfg,
        req,
        res,
        endpointOption,
      });

      if (ragResult && typeof ragResult === 'object') {
        systemContent = ragResult.patchedSystemContent ?? systemContent;
        const contextLengthCandidate = Number(ragResult.contextLength);
        ragContextLength = Number.isFinite(contextLengthCandidate) ? contextLengthCandidate : 0;
        ragCacheStatus = ragResult.cacheStatus ?? ragCacheStatus;

        if (req) {
          req.ragCacheStatus = ragCacheStatus;
          if (ragResult.metrics && typeof ragResult.metrics === 'object') {
            req.ragMetrics = Object.assign({}, req.ragMetrics, ragResult.metrics);
          }
        }
      }

      if (ragContextLength > 0) {
        logger.info('[rag.context.applied]', {
          conversationId: this.conversationId,
          cacheStatus: ragCacheStatus,
          contextLength: ragContextLength,
          contextTokens: ragResult?.metrics?.contextTokens ?? 0,
          graphTokens: ragResult?.metrics?.graphTokens ?? 0,
          vectorTokens: ragResult?.metrics?.vectorTokens ?? 0,
        });
      }
    } catch (ragError) {
      logger.error('[rag.context.error]', {
        conversationId: this.conversationId,
        message: ragError?.message,
        stack: ragError?.stack,
      });
      if (req) {
        req.ragCacheStatus = 'error';
      }
    }

    if (this.options?.req) {
      this.options.req.ragContextLength = ragContextLength;
    }

    try {
      const toolsGatewayUrl = runtimeCfg?.toolsGateway?.url || this.options?.req?.config?.queues?.toolsGatewayUrl;

      const fetchGraphLinesForEntity = async ({ entity, relationHints, limit, signal, passIndex }) => {
        const entityName = typeof entity === 'string' ? entity : entity?.name;
        if (!toolsGatewayUrl || !entityName) {
          return { lines: [], status: 'skipped' };
        }

        const hints = Array.isArray(relationHints)
          ? relationHints.filter(Boolean)
          : Array.isArray(entity?.hints)
            ? entity.hints.filter(Boolean)
            : [];

        try {
          const graphContext = await fetchGraphContext({
            conversationId: this.conversationId,
            toolsGatewayUrl,
            limit: limit ?? runtimeCfg?.graphContext?.maxLines ?? GRAPH_RELATIONS_LIMIT,
            timeoutMs: runtimeCfg?.graphContext?.requestTimeoutMs ?? GRAPH_REQUEST_TIMEOUT_MS,
            entity: typeof entity === 'string' ? { name: entity } : entity,
            relationHints: hints,
            passIndex,
            signal,
          });

          if (!graphContext?.lines?.length) {
            return { lines: [], status: 'empty' };
          }

          return { lines: graphContext.lines, status: 'ok' };
        } catch (error) {
          logger.error('[rag.followup.graph.fetch.error]', {
            conversationId: this.conversationId,
            entity: entityName,
            message: error?.message,
          });
          return { lines: [], status: 'failed' };
        }
      };

      const multiStepResult = runtimeCfg?.multiStepRag?.enabled
        ? await runMultiStepRag({
            intentAnalysis,
            runtimeCfg,
            baseContext: systemContent,
            fetchGraphContext: fetchGraphLinesForEntity,
            enqueueMemoryTasks,
            conversationId: this.conversationId,
            userId: requestUserId,
            endpoint: this.options?.endpoint,
            model: this.model,
            signal: this.options?.req?.abortController?.signal,
            graphContextLines: graphSnapshot.graphLines,
            graphQueryHint: graphSnapshot.graphQueryHint,
          })
        : { globalContext: systemContent, entities: [], passesUsed: 0, queueStatus: {} };

      systemContent = multiStepResult.globalContext || systemContent;
      const deferred = getDeferredContext(req);
      if (deferred && deferred.vectorText?.length) {
        await this.applyDeferredCondensation({
          req,
          res,
          endpointOption,
          runtimeCfg,
          userQuery: req?.ragUserQuery || '',
          systemContentRef: () => systemContent,
          updateSystemContent: (next) => {
            systemContent = next;
          },
          deferredContext: deferred,
        });
      }

      const ragContextObject = {
        global: multiStepResult.globalContextSummary || multiStepResult.globalContext || '',
        entities: multiStepResult.entities?.map((entity) => ({
          name: entity.name,
          graphContext: entity.graphLines,
          vectorContext: entity.vectorChunks,
          graphSummary: entity.graphSummary,
          vectorSummary: entity.vectorSummary,
          tokens: entity.tokens,
          passes: entity.passes,
        })) || [],
      };

      if (req) {
        req.ragMultiStep = {
          enabled: Boolean(runtimeCfg?.multiStepRag?.enabled),
          passesUsed: multiStepResult.passesUsed,
          entities: multiStepResult.entities?.map((entity) => ({
            name: entity.name,
            passes: entity.passes,
            tokens: entity.tokens,
            graphLines: entity.graphLines.length,
            vectorChunks: entity.vectorChunks.length,
          })),
          queueStatus: multiStepResult.queueStatus,
          ragContext: ragContextObject,
        };
      } else if (this.options?.req) {
        this.options.req.ragMultiStep = { ragContext: ragContextObject };
      }
    } catch (multiStepError) {
      logger.error('[rag.multistep.error]', {
        conversationId: this.conversationId,
        message: multiStepError?.message,
        stack: multiStepError?.stack,
      });
      clearDeferredContext(req);
    }

    let payload;
    let promptTokens;
    let tokenCountMap = {};

    if (this.options.attachments) {
      const attachments = await this.options.attachments;

      if (this.message_file_map) {
        this.message_file_map[orderedMessages[orderedMessages.length - 1].messageId] = attachments;
      } else {
        this.message_file_map = {
          [orderedMessages[orderedMessages.length - 1].messageId]: attachments,
        };
      }

      const files = await this.addImageURLs(
        orderedMessages[orderedMessages.length - 1],
        attachments,
      );

      this.options.attachments = files;
    }

    if (this.message_file_map && !isAgentsEndpoint(this.options.endpoint)) {
      this.contextHandlers = createContextHandlers(
        this.options.req,
        orderedMessages[orderedMessages.length - 1].text,
      );
    }

    const formattedMessages = orderedMessages.map((message, i) => {
      const formattedMessage = formatMessage({
        message,
        userName: this.options?.name,
        assistantName: this.options?.modelLabel,
      });

      if (message.ocr && i !== orderedMessages.length - 1) {
        if (typeof formattedMessage.content === 'string') {
          formattedMessage.content = message.ocr + '\n' + formattedMessage.content;
        } else {
          const textPart = formattedMessage.content.find((part) => part.type === 'text');
          textPart
            ? (textPart.text = message.ocr + '\n' + textPart.text)
            : formattedMessage.content.unshift({ type: 'text', text: message.ocr });
        }
      } else if (message.ocr && i === orderedMessages.length - 1) {
        systemContent = [systemContent, message.ocr].join('\n');
      }

      const needsTokenCount =
        (this.contextStrategy && !orderedMessages[i].tokenCount) || message.ocr;

      if (needsTokenCount || (this.isVisionModel && (message.image_urls || message.files))) {
        orderedMessages[i].tokenCount = this.getTokenCountForMessage(formattedMessage);
      }

      if (this.message_file_map && this.message_file_map[message.messageId]) {
        const attachments = this.message_file_map[message.messageId];
        for (const file of attachments) {
          if (file.embedded) {
            this.contextHandlers?.processFile(file);
            continue;
          }
        }
      }

      formattedMessage.metadata = formattedMessage.metadata || {};
      orderedMessages[i] = orderedMessages[i] || {};
      orderedMessages[i].metadata = orderedMessages[i].metadata || {};

      if (!message.isCreatedByUser && i !== orderedMessages.length - 1) {
        formattedMessage.metadata.isRagContext = true;
        orderedMessages[i].metadata.isRagContext = true;
      }

      return formattedMessage;
    });

    if (this.contextHandlers) {
      this.augmentedPrompt = await this.contextHandlers.createContext();
      systemContent = this.augmentedPrompt + systemContent;
    }

    const ragSections = this.options?.req?.ragMultiStep?.ragContext
      ? await this.instructionsBuilder?.buildRagSections(this.options.req.ragMultiStep.ragContext, {
          getEncoding: () => this.getEncoding(),
          compressor: new MessageCompressorBridge({ reduction: historyCompressionCfg?.layer2Ratio ?? 0.25 }),
        })
      : '';

    const combinedSystemContent = [ragSections, systemContent]
      .filter((section) => typeof section === 'string' && section.trim().length)
      .join('\n\n');

    instructions = normalizeInstructionsPayload(
      combinedSystemContent,
      () => this.getEncoding(),
      '[DIAG-PROMPT]',
    );
    logger.info(
      `[DIAG-PROMPT] Final instructions object created. Length: ${instructions.content.length}, Tokens: ${instructions.tokenCount}`,
    );
    if (this.contextStrategy) {
   ({ payload, promptTokens, tokenCountMap, messages } = await this.handleContextStrategy({
     orderedMessages,
     formattedMessages,
     instructions,
   }));
   logger.debug('[prompt.payload]', {
     conversationId: this.conversationId,
     promptTokens,
     ragContextTokens: this.options?.req?.ragContextTokens ?? 0,
     instructionsTokens: instructions?.tokenCount ?? 0,
     messageCount: messages.length,
   });
 }

    for (let i = 0; i < messages.length; i++) {
         this.indexTokenCountMap[i] = messages[i].tokenCount;
       }

    const result = {
      tokenCountMap,
      prompt: payload,
      promptTokens,
      messages,
    };

    const perMessageBreakdown = orderedMessages.map((msg, idx) => ({
      messageId: msg?.messageId || "msg-" + (idx + 1),
      tokens: Number(msg?.tokenCount) || 0,
      isRagContext: msg?.metadata?.isRagContext || false
    }));

    const rm = this.options?.req?.ragMetrics || {};
    this.promptTokenContext = {
      conversationId: this.conversationId ?? "unknown",
      instructionsTokens: instructions?.tokenCount || 0,
      ragGraphTokens: Number(rm.graphTokens) || 0,
      ragVectorTokens: Number(rm.vectorTokens) || 0,
      messages: perMessageBreakdown,
      promptTokensEstimate: promptTokens ?? 0
    };

    if (promptTokens >= 0 && typeof opts?.getReqData === 'function') {
      opts.getReqData({ promptTokens });
    }

    const withoutKeys = await this.useMemory();
    if (withoutKeys) {
      logger.debug('[AgentClient] Memory (withoutKeys) generated but not explicitly added to prompt, as system message already formed.');
    }

    return result;
  }

  async awaitMemoryWithTimeout(memoryPromise, timeoutMs = 3000) {
    if (!memoryPromise) {
      return;
    }

    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Memory processing timeout')), timeoutMs),
      );

      const attachments = await Promise.race([memoryPromise, timeoutPromise]);
      return attachments;
    } catch (error) {
      if (error.message === 'Memory processing timed out') {
        logger.warn('[AgentClient] Memory processing timed out after 3 seconds');
      } else {
        logger.error('[AgentClient] Error processing memory:', error);
      }
      return;
    }
  }

  async useMemory() {
    const user = this.options.req.user;
    if (user.personalization?.memories === false) {
      return;
    }
    const hasAccess = await checkAccess({
      user,
      permissionType: PermissionTypes.MEMORIES,
      permissions: [Permissions.USE],
      getRoleByName,
    });

    if (!hasAccess) {
      logger.debug(
        `[api/server/controllers/agents/client.js #useMemory] User ${user.id} does not have USE permission for memories`,
      );
      return;
    }
    const appConfig = this.options.req.config;
    const memoryConfig = appConfig.memory;
    if (!memoryConfig || memoryConfig.disabled === true) {
      return;
    }

    let prelimAgent;
    const allowedProviders = new Set(
      appConfig?.endpoints?.[EModelEndpoint.agents]?.allowedProviders,
    );
    try {
      if (memoryConfig.agent?.id != null && memoryConfig.agent.id !== this.options.agent.id) {
        prelimAgent = await loadAgent({
          req: this.options.req,
          agent_id: memoryConfig.agent.id,
          endpoint: EModelEndpoint.agents,
        });
      } else if (
        memoryConfig.agent?.id == null &&
        memoryConfig.agent?.model != null &&
        memoryConfig.agent?.provider != null
      ) {
        prelimAgent = { id: Constants.EPHEMERAL_AGENT_ID, ...memoryConfig.agent };
      }
    } catch (error) {
      logger.error(
        '[api/server/controllers/agents/client.js #useMemory] Error loading agent for memory',
        error,
      );
    }

    const agent = await initializeAgent({
      req: this.options.req,
      res: this.options.res,
      agent: prelimAgent,
      allowedProviders,
      endpointOption: {
        endpoint:
          prelimAgent.id !== Constants.EPHEMERAL_AGENT_ID
            ? EModelEndpoint.agents
            : memoryConfig.agent?.provider,
      },
    });

    if (!agent) {
      logger.warn(
        '[api/server/controllers/agents/client.js #useMemory] No agent found for memory',
        memoryConfig,
      );
      return;
    }

    const llmConfig = Object.assign(
      {
        provider: agent.provider,
        model: agent.model,
      },
      agent.model_parameters,
    );

    const config = {
      validKeys: memoryConfig.validKeys,
      instructions: agent.instructions,
      llmConfig,
      tokenLimit: memoryConfig.tokenLimit,
    };

    const userId = this.options.req.user.id + '';
    const messageId = this.responseMessageId + '';
    const conversationId = this.conversationId + '';
    const [withoutKeys, processMemory] = await createMemoryProcessor({
      userId,
      config,
      messageId,
      conversationId,
      memoryMethods: {
        setMemory,
        deleteMemory,
        getFormattedMemories,
      },
      res: this.options.res,
    });

    this.processMemory = processMemory;
    return withoutKeys;
  }

  removeImageContentFromMessage(message) {
    if (!message.content || typeof message.content === 'string') {
      return message;
    }

    if (Array.isArray(message.content)) {
      const filteredContent = message.content.filter(
        (part) => part.type !== ContentTypes.IMAGE_URL,
      );

      if (filteredContent.length === 1 && filteredContent[0].type === ContentTypes.TEXT) {
        const MessageClass = message.constructor;
        return new MessageClass({
          content: filteredContent[0].text,
          additional_kwargs: message.additional_kwargs,
        });
      }

      const MessageClass = message.constructor;
      return new MessageClass({
        content: filteredContent,
        additional_kwargs: message.additional_kwargs,
      });
    }

    return message;
  }

  async enrichContextWithMemoryAgent(messages) {
    try {
      if (this.processMemory == null) {
        return;
      }
      const appConfig = this.options.req.config;
      const memoryConfig = appConfig.memory;
      const messageWindowSize = memoryConfig?.messageWindowSize ?? 5;

      let messagesToProcess = [...messages];
      if (messages.length > messageWindowSize) {
        for (let i = messages.length - messageWindowSize; i >= 0; i--) {
          const potentialWindow = messages.slice(i, i + messageWindowSize);
          if (potentialWindow[0]?.role === 'user') {
            messagesToProcess = [...potentialWindow];
            break;
          }
        }

        if (messagesToProcess.length === messages.length) {
          messagesToProcess = [...messages.slice(-messageWindowSize)];
        }
      }

      const filteredMessages = messagesToProcess.map((msg) => this.removeImageContentFromMessage(msg));
      const bufferString = getBufferString(filteredMessages);
      const bufferMessage = new HumanMessage(`# Current Chat:\n\n${bufferString}`);
      return await this.processMemory([bufferMessage]);
    } catch (error) {
      logger.error('Memory Agent failed to process memory', error);
    }
  }

  async sendCompletion(payload, opts = {}) {
    await this.chatCompletion({
      payload,
      onProgress: opts.onProgress,
      userMCPAuthMap: opts.userMCPAuthMap,
      abortController: opts.abortController,
    });
    return this.contentParts;
  }

  async recordCollectedUsage({
    model,
    balance,
    transactions,
    context = 'message',
    collectedUsage = this.collectedUsage,
  }) {
    if (!collectedUsage || !collectedUsage.length) {
      return;
    }

    const modelName = this.options.agent.model_parameters?.model ?? this.model;
    const firstUsage = collectedUsage[0] ?? {};
    const initialInputTokens = Number(firstUsage?.input_tokens) || 0;
    const initialCacheCreation = Number(firstUsage?.input_token_details?.cache_creation) || 0;
    const initialCacheRead =
      Number(firstUsage?.input_token_details?.cache_token_details?.cache_read) || 0;
    const input_tokens = initialInputTokens + initialCacheCreation + initialCacheRead;

    let output_tokens = 0;
    let previousTokens = input_tokens;
    let totalCacheCreation = 0;
    let totalCacheRead = 0;
    let totalReasoningTokens = 0;

    for (let i = 0; i < collectedUsage.length; i++) {
      const usage = collectedUsage[i];
      if (!usage) {
        continue;
      }

      const cacheCreation = Number(usage?.input_token_details?.cache_creation) || 0;
      const cacheRead =
        Number(usage?.input_token_details?.cache_token_details?.cache_read) || 0;
      totalCacheCreation += cacheCreation;
      totalCacheRead += cacheRead;

      const reasoningDirect = Number(usage?.reasoning_tokens);
      const reasoningDetailed =
        Number(usage?.completion_tokens_details?.reasoning_tokens);
      if (Number.isFinite(reasoningDirect)) {
        totalReasoningTokens += reasoningDirect;
      } else if (Number.isFinite(reasoningDetailed)) {
        totalReasoningTokens += reasoningDetailed;
      }

      const txMetadata = {
        context,
        balance,
        transactions,
        conversationId: this.conversationId,
        user: this.user ?? this.options.req.user?.id,
        endpointTokenConfig: this.options.endpointTokenConfig,
        model: usage.model ?? model ?? modelName,
      };

      if (i > 0) {
        output_tokens +=
          (Number(usage.input_tokens) || 0) + cacheCreation + cacheRead - previousTokens;
      }

      output_tokens += Number(usage.output_tokens) || 0;
      previousTokens += Number(usage.output_tokens) || 0;

      if (cacheCreation > 0 || cacheRead > 0) {
        spendStructuredTokens(
          txMetadata,
          {
            promptTokens: {
              input: usage.input_tokens,
              write: cacheCreation,
              read: cacheRead,
            },
            completionTokens: usage.output_tokens,
          },
        ).catch((err) => {
          logger.error(
            '[api/server/controllers/agents/client.js #recordCollectedUsage] Error spending structured tokens',
            err,
          );
        });
        continue;
      }

      spendTokens(txMetadata, {
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
      }).catch((err) => {
        logger.error(
          '[api/server/controllers/agents/client.js #recordCollectedUsage] Error spending tokens',
          err,
        );
      });
    }

    this.usage = {
      input_tokens,
      output_tokens,
    };

    const totalTokensBilled = input_tokens + output_tokens + totalReasoningTokens;
    const pricingRates = resolvePricingRates(modelName, this.options?.req?.pricing);
    const promptRate = pricingRates.promptUsdPer1k;
    const completionRate = pricingRates.completionUsdPer1k;

    let costUsd = null;
    if (promptRate != null || completionRate != null) {
      costUsd = 0;
      if (promptRate != null) {
        costUsd += (input_tokens / 1000) * promptRate;
      }
      if (completionRate != null) {
        costUsd += ((output_tokens + totalReasoningTokens) / 1000) * completionRate;
      }
      costUsd = Math.round(costUsd * 1_000_000) / 1_000_000;

      if (typeof observeCost === 'function' && costUsd != null) {
        observeCost(
          {
            model: modelName,
            endpoint:
              this.options?.endpoint || this.options?.agent?.provider || 'unknown',
          },
          costUsd,
        );
      }
    }

    const promptRateLog = promptRate != null ? promptRate : 'n/a';
    const completionRateLog = completionRate != null ? completionRate : 'n/a';
    const costLog = costUsd != null ? costUsd.toFixed(6) : 'n/a';

    logger.info(
      `[pricing.tokens.detail] conversation=${
        this.conversationId ?? 'unknown'
      } model=${modelName} prompt=${input_tokens} completion=${output_tokens} reasoning=${totalReasoningTokens} cache_write=${totalCacheCreation} cache_read=${totalCacheRead} promptUsdPer1k=${promptRateLog} completionUsdPer1k=${completionRateLog} pricingSource=${pricingRates.source}`
    );
    logger.info(
      `[pricing.tokens.total] conversation=${this.conversationId ?? 'unknown'} totalTokens=${totalTokensBilled} costUsd=${costLog}`
    );

    try {
      const messages = Array.isArray(this.currentMessages) ? this.currentMessages : [];
      writeTokenReport({
        sessionId: this.conversationId ?? 'unknown-session',
        totalTokens: totalTokensBilled,
        promptTokens: input_tokens,
        completionTokens: output_tokens,
        reasoningTokens: totalReasoningTokens,
        costUsd,
        pricingSource: pricingRates.source,
        ragReuseCount: this.options.req?.ragCacheStatus === 'hit' ? 1 : 0,
        perMessage: messages.map((msg) => ({
          messageId: msg?.messageId ?? 'unknown-message',
          tokens: Number(msg?.tokenCount) || 0,
          isRagContext: msg?.metadata?.isRagContext === true,
        })),
      });
    } catch (reportError) {
      logger.warn('[token.report] failed', { message: reportError?.message });
    }
  }

  getStreamUsage() {
    return this.usage;
  }

  getTokenCountForResponse({ content }) {
    return this.getTokenCountForMessage({
      role: 'assistant',
      content,
    });
  }

  calculateCurrentTokenCount({ tokenCountMap, currentMessageId, usage }) {
    const originalEstimate = tokenCountMap[currentMessageId] || 0;

    if (!usage || typeof usage[this.inputTokensKey] !== 'number') {
      return originalEstimate;
    }

    tokenCountMap[currentMessageId] = 0;
    const totalTokensFromMap = Object.values(tokenCountMap).reduce((sum, count) => {
      const numCount = Number(count);
      return sum + (isNaN(numCount) ? 0 : numCount);
    }, 0);
    const totalInputTokens = usage[this.inputTokensKey] ?? 0;

    const currentMessageTokens = totalInputTokens - totalTokensFromMap;
    return currentMessageTokens > 0 ? currentMessageTokens : originalEstimate;
  }

  async chatCompletion({ payload, userMCPAuthMap, abortController = null }) {
    let config;
    let run;
    let memoryPromise;
    let retryAttempt = 0;
    const MAX_RETRIES = 2;
    
    try {
      if (!abortController) {
        abortController = new AbortController();
      }

      const req = this.options?.req;
      const res = this.options?.res;
      const onClientAbort = () => {
        try {
          abortController.abort();
        } catch {}
      };
      if (req && typeof req.once === 'function') req.once('aborted', onClientAbort);
      if (res && typeof res.once === 'function') res.once('close', onClientAbort);

      const appConfig = this.options.req.config;
      const agentsEConfig = appConfig.endpoints?.[EModelEndpoint.agents];

      config = {
        configurable: {
          thread_id: this.conversationId,
          last_agent_index: this.agentConfigs?.size ?? 0,
          user_id: this.user ?? this.options.req.user?.id,
          hide_sequential_outputs: this.options.agent.hide_sequential_outputs,
          requestBody: {
            messageId: this.responseMessageId,
            conversationId: this.conversationId,
            parentMessageId: this.parentMessageId,
          },
          user: this.options.req.user,
        },
        recursionLimit: agentsEConfig?.recursionLimit ?? 25,
        signal: abortController.signal,
        streamMode: 'values',
        version: 'v2',
      };

      const toolSet = new Set((this.options.agent.tools ?? []).map((tool) => tool && tool.name));
      let { messages: initialMessages, indexTokenCountMap } = formatAgentMessages(
        payload,
        this.indexTokenCountMap,
        toolSet,
      );

      try {
        const summarizeMsg = (m) => {
          let len = 0;
          if (typeof m.content === 'string') len = m.content.length;
          else if (Array.isArray(m.content)) {
            for (const part of m.content) {
              if (part && part.type === 'text' && typeof part.text === 'string') len += part.text.length;
            }
          }
          const role = typeof m._getType === 'function' ? m._getType() : m.role || 'unknown';
          return { role, len };
        };
        const diag = initialMessages.map(summarizeMsg);
        const top = [...diag].map((d, i) => ({ i, ...d })).sort((a, b) => b.len - a.len).slice(0, 5);
    logger.debug('[diag][fmt] payload stats', {
      messageCount: diag.length,
      topEntries: top.map((t) => `#${t.i}:${t.role}:${t.len}`),
    });
      } catch (e) {
    logger.error('[diag][fmt] log error', { message: e?.message, stack: e?.stack });
      }

      const runAgent = async (agent, _messages, i = 0, contentData = [], _currentIndexCountMap) => {
        try {
          this.trace('trace:agent.run', {
            provider: agent?.provider,
            model: agent?.model_parameters?.model,
            chainWindow: configService.get('features.geminiChainWindow', 'default'),
            chainBuffer: configService.get('features.googleChainBuffer', 'off'),
            step: i
          });
        } catch {}
        config.configurable.model = agent.model_parameters.model;
        const currentIndexCountMap = _currentIndexCountMap ?? indexTokenCountMap;
        if (i > 0) {
          this.model = agent.model_parameters.model;
        }
        if (i > 0 && config.signal == null) {
          config.signal = abortController.signal;
        }
        if (agent.recursion_limit && typeof agent.recursion_limit === 'number') {
          config.recursionLimit = agent.recursion_limit;
        }
        if (agentsEConfig?.maxRecursionLimit && config.recursionLimit > agentsEConfig?.maxRecursionLimit) {
          config.recursionLimit = agentsEConfig?.maxRecursionLimit;
        }
        config.configurable.agent_id = agent.id;
        config.configurable.name = agent.name;
        config.configurable.agent_index = i;
        const noSystemMessages = noSystemModelRegex.some((regex) => agent.model_parameters.model.match(regex));

        const systemMessage = Object.values(agent.toolContextMap ?? {})
          .join('\n')
          .trim();

        let instructionsForLangChain = null;
        if (typeof agent.instructions === 'string' && agent.instructions.length > 0) {
            instructionsForLangChain = new SystemMessage({ content: agent.instructions });
        } else if (agent.instructions instanceof SystemMessage) {
            instructionsForLangChain = agent.instructions;
        }

        let systemContent = [
          systemMessage,
          instructionsForLangChain?.content ?? '',
          i !== 0 ? agent.additional_instructions ?? '' : '',
        ]
          .filter(Boolean)
          .join('\n')
          .trim();

        if (!systemContent || systemContent.length === 0) {
          systemContent = DEFAULT_SYSTEM_PROMPT;
          logger.debug(`[AgentClient][runAgent:${agent.id}] Applied default system prompt`);
        }

        const normalizedSystem = normalizeInstructionsPayload(
          systemContent,
          () => this.getEncoding(),
          `[AgentClient][runAgent:${agent.id}]`,
        );
        systemContent = normalizedSystem.content;

        if (noSystemMessages === true) {
          agent.instructions = undefined;
          agent.additional_instructions = undefined;
        } else {
          if (systemContent && (instructionsForLangChain?.content !== systemContent || !instructionsForLangChain)) {
             agent.instructions = new SystemMessage({ content: systemContent });
          } else if (!systemContent) {
             agent.instructions = null;
          }
          agent.additional_instructions = undefined;
        }

        if (noSystemMessages === true && systemContent?.length) {
          let latestMessageContent = _messages[_messages.length - 1].content;
          if (typeof latestMessageContent !== 'string') {
            latestMessageContent[0].text = [systemContent, latestMessageContent[0].text].join('\n');
            _messages[_messages.length - 1] = new HumanMessage({ content: latestMessageContent });
          } else {
            const text = [systemContent, latestMessageContent].join('\n');
            _messages[_messages.length - 1] = new HumanMessage(text);
          }
        }

        let messages = _messages;
        if (agent.useLegacyContent === true) {
          messages = formatContentStrings(messages);
        }
        const defaultHeaders =
          agent.model_parameters?.clientOptions?.defaultHeaders ??
          agent.model_parameters?.configuration?.defaultHeaders;
        if (defaultHeaders?.['anthropic-beta']?.includes('prompt-caching')) {
          messages = addCacheControl(messages);
        }

        if (i === 0) {
          memoryPromise = this.enrichContextWithMemoryAgent(messages);
        }

        if (agent.model_parameters?.configuration?.defaultHeaders != null) {
          agent.model_parameters.configuration.defaultHeaders = resolveHeaders({
            headers: agent.model_parameters.configuration.defaultHeaders,
            body: config.configurable.requestBody,
          });
        }

        logger.debug('[agent.run.debug] Agent configuration', {
          conversationId: this.conversationId,
          agentId: agent.id,
          agentName: agent.name,
          provider: agent.provider,
          model: agent.model_parameters?.model,
          messagesCount: messages.length,
          systemContentLength: systemContent?.length || 0,
          hasInstructions: Boolean(agent.instructions),
          instructionsType: agent.instructions?.constructor?.name,
          recursionLimit: config.recursionLimit,
        });

        logger.debug('[agent.run.request] Request to model', {
          conversationId: this.conversationId,
          agentId: agent.id,
          model: agent.model_parameters?.model,
          provider: agent.provider,
          baseURL: agent.model_parameters?.configuration?.baseURL,
          messagesPreview: messages.slice(0, 2).map(m => ({
            role: typeof m._getType === 'function' ? m._getType() : m.role,
            contentLength: typeof m.content === 'string'
              ? m.content.length
              : (() => {
                  try {
                    return JSON.stringify(m.content).length;
                  } catch {
                    return 0;
                  }
                })(),
          })),
        });

        const run = await createRun({
          agent,
          req: this.options.req,
          runId: this.responseMessageId,
          signal: abortController.signal,
          customHandlers: this.options.eventHandlers,
        });

        if (!run) {
          throw new Error('Failed to create run');
        }

        if (i === 0) {
          this.run = run;
        }

        if (contentData.length) {
          const agentUpdate = {
            type: ContentTypes.AGENT_UPDATE,
            [ContentTypes.AGENT_UPDATE]: {
              index: contentData.length,
              runId: this.responseMessageId,
              agentId: agent.id,
            },
          };
          const streamData = {
            event: GraphEvents.ON_AGENT_UPDATE,
            data: agentUpdate,
          };
          this.options.aggregateContent(streamData);
          sendEvent(this.options.res, streamData);
          contentData.push(agentUpdate);
          run.Graph.contentData = contentData;
        }

        if (userMCPAuthMap != null) {
          config.configurable.userMCPAuthMap = userMCPAuthMap;
        }
        
        logger.debug('[agent.run.processStream] Starting stream processing', {
          conversationId: this.conversationId,
          agentId: agent.id,
          messagesCount: messages.length,
          maxContextTokens: agent.maxContextTokens,
        });
        
        await run.processStream({ messages }, config, {
          keepContent: i !== 0,
          tokenCounter: createTokenCounter(this.getEncoding()),
          indexTokenCountMap: currentIndexCountMap,
          maxContextTokens: agent.maxContextTokens,
          callbacks: {
            [Callback.TOOL_ERROR]: logToolError,
          },
        });

        config.signal = null;
      };

      while (retryAttempt <= MAX_RETRIES) {
        try {
          await runAgent(this.options.agent, initialMessages);
          break;
        } catch (runError) {
          if (detectContextOverflow(runError) && retryAttempt < MAX_RETRIES) {
            retryAttempt++;
            const reductionFactor = 0.3 + (retryAttempt * 0.2);
            
            logger.warn('[context.overflow.retry]', {
              conversationId: this.conversationId,
              attempt: retryAttempt,
              maxRetries: MAX_RETRIES,
              reductionFactor,
              originalError: runError?.message,
            });

            initialMessages = compressMessagesForRetry(initialMessages, reductionFactor);
            
            logger.info('[context.overflow.compressed]', {
              conversationId: this.conversationId,
              attempt: retryAttempt,
              newMessageCount: initialMessages.length,
              reductionFactor,
            });

            await new Promise(resolve => setTimeout(resolve, 500 * retryAttempt));
            continue;
          }
          
          throw runError;
        }
      }

      let finalContentStart = 0;
      if (
        this.agentConfigs &&
        this.agentConfigs.size > 0 &&
        (await checkCapability(this.options.req, AgentCapabilities.chain))
      ) {
        const windowSize = GEMINI_CHAIN_WINDOW;
        let latestMessage = initialMessages.pop().content;
        if (typeof latestMessage !== 'string') {
          latestMessage = latestMessage[0].text;
        }
        let i = 1;
        let runMessages = [];

        const windowIndexCountMap = {};
        let currentIndex = windowSize - 1;
        for (let k = initialMessages.length - 1; k >= 0; k--) {
          windowIndexCountMap[currentIndex] = indexTokenCountMap[k];
          currentIndex--;
          if (currentIndex < 0) {
            break;
          }
        }
        const encoding = this.getEncoding();
        const tokenCounter = createTokenCounter(encoding);
        for (const [agentId, agent] of this.agentConfigs) {
          if (abortController.signal.aborted === true) {
            break;
          }
          const currentRun = await this.run;

          if (i === this.agentConfigs.size && config.configurable.hide_sequential_outputs === true) {
            const content = this.contentParts.filter((part) => part.type === ContentTypes.TOOL_CALL);
            if (canWrite(this.options?.res)) {
              this.options.res.write(
                `event: message\ndata: ${JSON.stringify({
                  event: 'on_content_update',
                  data: {
                    runId: this.responseMessageId,
                    content,
                  },
                })}\n\n`,
              );
            }
            sseDebug(this.options?.res, { note: 'sequential_final_update' });
          }

          const _runMessages = currentRun.Graph.getRunMessages();
          finalContentStart = this.contentParts.length;
          runMessages = runMessages.concat(_runMessages);
          const contentData = currentRun.Graph.contentData.slice();

          let currentMessages;
          if (isGoogleModel(agent) && GOOGLE_CHAIN_BUFFER === 'off') {
            const contextMessages = [];
            const runIndexCountMap = {};
            for (let wi = 0; wi < windowMessages.length; wi++) {
              const message = windowMessages[wi];
              const messageType = message._getType();
              if (
                (!agent.tools || agent.tools.length === 0) &&
                (messageType === 'tool' || (message.tool_calls?.length ?? 0) > 0)
              ) {
                continue;
              }
              runIndexCountMap[contextMessages.length] = windowIndexCountMap[wi];
              contextMessages.push(message);
            }
            const bufferMessage = new HumanMessage(latestMessage);
            runIndexCountMap[contextMessages.length] = tokenCounter(bufferMessage);
            currentMessages = [...contextMessages, bufferMessage];
          } else {
            const bufferString = getBufferString([new HumanMessage(latestMessage), ...runMessages]);
            try {
              const contextMessages = [];
              const runIndexCountMap = {};
              for (let wi = 0; wi < windowMessages.length; wi++) {
                const message = windowMessages[wi];
                const messageType = message._getType();
                if (
                  (!agent.tools || agent.tools.length === 0) &&
                  (messageType === 'tool' || (message.tool_calls?.length ?? 0) > 0)
                ) {
                  continue;
                }
                runIndexCountMap[contextMessages.length] = windowIndexCountMap[wi];
                contextMessages.push(message);
              }
              const bufferMessage = new HumanMessage(bufferString);
              runIndexCountMap[contextMessages.length] = tokenCounter(bufferMessage);
              currentMessages = [...contextMessages, bufferMessage];
            } catch (err) {
              logger.error(
                `[api/server/controllers/agents/client.js #chatCompletion] Error preparing chain buffer for agent ${agentId} (${i})`,
                err,
              );
              currentMessages = windowMessages;
            }
          }

          try {
            await runAgent(agent, currentMessages, i, contentData, undefined);
          } catch (err) {
            logger.error(
              `[api/server/controllers/agents/client.js #chatCompletion] Error running agent ${agentId} (${i})`,
              err,
            );
          }
          i++;
        }
      }

      if (config.configurable.hide_sequential_outputs !== true) {
        finalContentStart = 0;
      }

      this.contentParts = this.contentParts.filter((part, index) => {
        return index >= finalContentStart || part.type === ContentTypes.TOOL_CALL || part.tool_call_ids;
      });

      try {
        const attachments = await this.awaitMemoryWithTimeout(memoryPromise);
        if (attachments && attachments.length > 0) {
          this.artifactPromises.push(...attachments);
        }

        const balanceConfig = getBalanceConfig(appConfig);
        const transactionsConfig = getTransactionsConfig(appConfig);
        try { const u = this.getStreamUsage && this.getStreamUsage(); this.trace('trace:usage', u || {}); } catch {}
        await this.recordCollectedUsage({
          context: 'message',
          balance: balanceConfig,
          transactions: transactionsConfig,
        });
      } catch (err) {
        logger.error(
          '[api/server/controllers/agents/client.js #chatCompletion] Error recording collected usage',
          err,
        );
      }
    } catch (err) {
      const isAborted =
        (typeof AbortController !== 'undefined' && abortController?.signal?.aborted === true) ||
        err?.name === 'AbortError' ||
        String(err?.message || '').toLowerCase().includes('aborted');

      try {
        const attachments = await this.awaitMemoryWithTimeout(memoryPromise);
        if (attachments && attachments.length > 0) {
          this.artifactPromises?.push(...attachments);
        }
      } catch (_) {}

      if (isAborted) {
        logger.info('[agents/client.chatCompletion] aborted by client; ending gracefully');
        return;
      }

      if (detectContextOverflow(err) && retryAttempt >= MAX_RETRIES) {
        logger.error('[context.overflow.max_retries]', {
          conversationId: this.conversationId,
          attempts: retryAttempt,
          message: 'Max retries reached for context overflow',
        });
        
        this.contentParts = this.contentParts || [];
        this.contentParts.push({
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: 'Context window exceeded. Please try with a shorter conversation history or reduce the amount of context.',
        });
        return;
      }

      const errorDetails = {
        message: err?.message,
        code: err?.code,
        name: err?.name,
        status: err?.response?.status || err?.status,
        statusText: err?.response?.statusText || err?.statusText,
        responseData: err?.response?.data || err?.error,
        requestData: err?.request ? {
          method: err?.request?.method,
          url: err?.request?.url,
          path: err?.request?.path,
        } : undefined,
        stack: err?.stack,
        conversationId: this.conversationId,
        agentId: this.options?.agent?.id,
        model: this.options?.agent?.model_parameters?.model,
        provider: this.options?.agent?.provider,
      };
      
      logger.error(
        '[api/server/controllers/agents/client.js #sendCompletion] Unhandled error',
        errorDetails,
      );
      
      this.contentParts = this.contentParts || [];
      this.contentParts.push({
        type: ContentTypes.ERROR,
        [ContentTypes.ERROR]: `An error occurred while processing the request${
          err?.message ? `: ${err.message}` : ''
        }`,
      });
    }
  }

  async titleConvo({ text, abortController }) {
    const ollamaConfig = configService.get('providers.ollama', {});
    const USE_OLLAMA_FOR_TITLES = configService.getBoolean('features.useOllamaForTitles', false);
    const OLLAMA_TITLE_URL = ollamaConfig.url || 'http://127.0.0.1:11434';
    const OLLAMA_TITLE_MODEL_NAME = this.options.titleModel || ollamaConfig.titleModel || 'gemma:7b-instruct';

    if (USE_OLLAMA_FOR_TITLES) {
        try {
            const ollama_payload = {
                "model": OLLAMA_TITLE_MODEL_NAME,
                "messages": [
                    {"role": "system", "content": "Ты — эксперт по созданию коротких и релевантных заголовков для бесед. На основе текста последнего сообщения пользователя, создай краткий заголовок. Выдавай ТОЛЬКО JSON-объект с полем 'title'. Никакого дополнительного текста. Заголовок должен быть на русском языке, без кавычек, двоеточий и пояснений, до 30 символов, без слов: создание, генерация, заголовок, название, тема, описание, запрос."},
                    {"role": "user", "content": `На основе текста ниже верни один короткий суммаризированный заголовок на русском, который отражает тему последнего сообщения пользователя (до 30 символов). Текст: "${text}"`}
                ],
                "stream": false,
                "format": "json",
                "options": {
                    "temperature": 0.1
                }
            };
            const response = await axios.post(`${OLLAMA_TITLE_URL}/api/chat`, ollama_payload, { timeout: 60000 });
            if (response.data && response.data.message && response.data.message.content) {
                const raw_json_str = response.data.message.content;
                const parsed_data = JSON.parse(raw_json_str);
                if (parsed_data && parsed_data.title) {
                    logger.info(`[title] Ollama generated: "${parsed_data.title}"`);
                    return parsed_data.title;
                }
            }
            logger.warn('[title] Ollama title generation failed or returned empty. Falling back.', {
              response: response.data,
            });
        } catch (e) {
            logger.error(`[title] Ollama title generation error: ${e.message}. Falling back.`, e);
        }
        const cleaned = String(text || '').replace(/\s+/g, ' ').slice(0, 30).trim();
        logger.warn(`[title][fallback-ollama] "${cleaned}"`);
        return cleaned.length ? cleaned : 'Новый диалог';
    }

    const cleaned = String(text || '').replace(/\s+/g, ' ').slice(0, 30).trim();
    logger.warn(`[title][fallback-no-llm] "${cleaned}"`);
    return cleaned.length ? cleaned : 'Новый диалог';
  }

  async recordTokenUsage({
    model,
    usage,
    balance,
    promptTokens,
    completionTokens,
    context = 'message',
  }) {
    try {
      await spendTokens(
        {
          model,
          context,
          balance,
          conversationId: this.conversationId,
          user: this.user ?? this.options.req.user?.id,
          endpointTokenConfig: this.options.endpointTokenConfig,
        },
        { promptTokens, completionTokens },
      );

      if (usage && typeof usage === 'object' && 'reasoning_tokens' in usage && typeof usage.reasoning_tokens === 'number') {
        await spendTokens(
          {
            model,
            balance,
            context: 'reasoning',
            conversationId: this.conversationId,
            user: this.user ?? this.options.req.user?.id,
            endpointTokenConfig: this.options.endpointTokenConfig,
          },
          { completionTokens: usage.reasoning_tokens },
        );
      }
    } catch (error) {
      logger.error('[api/server/controllers/agents/client.js #recordTokenUsage] Error recording token usage', error);
    }
  }

  getEncoding() {
    const model = this.options?.agent?.model_parameters?.model || this.model;
    if (model && /gemini/i.test(model)) {
        return 'cl100k_base';
    }
    return 'o200k_base';
  }

  getTokenCount(text) {
    const encoding = this.getEncoding();
    return Tokenizer.getTokenCount(text, encoding);
  }
  promptTokenContext;
  promptTokenBreakdown;

  emitPromptTokenBreakdown(
    {
      promptTokens: promptTokens,
      cacheRead: cacheRead = 0,
      cacheWrite: cacheWrite = 0,
      reasoningTokens: reasoningTokens = 0
    }
  ) {
    if (!this.promptTokenContext) {
      return;
    }

    const breakdown = computePromptTokenBreakdown({
      conversationId: this.promptTokenContext.conversationId,
      promptTokens: promptTokens ?? (this.promptTokenContext.promptTokensEstimate ?? 0),
      instructionsTokens: this.promptTokenContext.instructionsTokens,
      ragGraphTokens: this.promptTokenContext.ragGraphTokens,
      ragVectorTokens: this.promptTokenContext.ragVectorTokens,
      messages: this.promptTokenContext.messages,

      cache: {
        read: cacheRead,
        write: cacheWrite
      },

      reasoningTokens: reasoningTokens
    });

    this.promptTokenBreakdown = breakdown;

    if (this.options) {
      this.options.req = this.options && this.options;
    }

    if (configService.get("logging.tokenBreakdown", {
      enabled: true,
      level: "info"
    }).enabled) {
      logPromptTokenBreakdown(logger, breakdown, configService.get("logging.tokenBreakdown", {
        enabled: true,
        level: "info"
      }).level || "info");
    }
  }

  async applyDeferredCondensation({
    req,
    res,
    endpointOption,
    runtimeCfg,
    userQuery,
    systemContentRef,
    updateSystemContent,
    deferredContext,
  }) {
    const snapshot = deferredContext || getDeferredContext(req);
    if (!snapshot) {
      return;
    }

    try {
      const encoding = this.getEncoding();
      const policyIntro = snapshot.policyIntro;
      const graphLines = Array.isArray(snapshot.graphLines) ? snapshot.graphLines : [];
      const graphQueryHint = snapshot.graphQueryHint;
      const summarizationDefaults = { budgetChars: 12000, chunkChars: 20000, timeoutMs: 125000 };
      const summarizationConfig = Object.assign({}, summarizationDefaults, {
        budgetChars:
          Number.isFinite(snapshot?.summarizationConfig?.budgetChars) &&
          snapshot.summarizationConfig.budgetChars > 0
            ? snapshot.summarizationConfig.budgetChars
            : summarizationDefaults.budgetChars,
        chunkChars:
          Number.isFinite(snapshot?.summarizationConfig?.chunkChars) &&
          snapshot.summarizationConfig.chunkChars > 0
            ? snapshot.summarizationConfig.chunkChars
            : summarizationDefaults.chunkChars,
        timeoutMs:
          Number.isFinite(snapshot?.summarizationConfig?.timeoutMs) &&
          snapshot.summarizationConfig.timeoutMs > 0
            ? snapshot.summarizationConfig.timeoutMs
            : summarizationDefaults.timeoutMs,
        provider: snapshot?.summarizationConfig?.provider,
        enabled: snapshot?.summarizationConfig?.enabled !== false,
      });

      let vectorText = typeof snapshot.vectorText === 'string' ? snapshot.vectorText : '';
      const shouldSummarize = summarizationConfig.enabled && vectorText.length > summarizationConfig.budgetChars;

      if (shouldSummarize) {
        const graphContext = graphLines.length ? { lines: graphLines, queryHint: graphQueryHint } : null;
        try {
          vectorText = await withTimeout(
            mapReduceContext({
              req,
              res,
              endpointOption,
              contextText: vectorText,
              userQuery,
              graphContext,
              summarizationConfig: {
                budgetChars: summarizationConfig.budgetChars,
                chunkChars: summarizationConfig.chunkChars,
                provider: summarizationConfig.provider,
                timeoutMs: summarizationConfig.timeoutMs,
              },
            }),
            summarizationConfig.timeoutMs,
            'RAG deferred summarization timed out',
          );
        } catch (error) {
          logger.error('[rag.context.deferred.summarize.error]', {
            conversationId: this.conversationId,
            message: error?.message,
            stack: error?.stack,
          });
        }
      }

      const ragBlock = buildRagBlock({
        policyIntro,
        graphLines,
        vectorText,
      });

      const nextSystemContent = replaceRagBlock(systemContentRef(), ragBlock);
      updateSystemContent(nextSystemContent);

      const graphTokens = graphLines.length ? Tokenizer.getTokenCount(graphLines.join('\n'), encoding) : 0;
      const vectorTokens = vectorText ? Tokenizer.getTokenCount(vectorText, encoding) : 0;
      const contextTokens = ragBlock ? Tokenizer.getTokenCount(ragBlock, encoding) : graphTokens + vectorTokens;

      if (req) {
        req.ragMetrics = Object.assign({}, req.ragMetrics, {
          graphTokens,
          vectorTokens,
          contextTokens,
        });
        req.ragContextTokens = contextTokens;
      }

      const maxPromptTokens =
        runtimeCfg?.tokenLimits?.maxPromptTokens ||
        runtimeCfg?.tokenLimits?.maxMessageTokens ||
        this.maxContextTokens ||
        0;

      if (maxPromptTokens > 0 && contextTokens > maxPromptTokens) {
        logger.warn('[rag.context.preoverflow]', {
          conversationId: this.conversationId,
          contextTokens,
          maxPromptTokens,
        });
      }
    } catch (error) {
      logger.error('[rag.context.deferred.error]', {
        conversationId: this.conversationId,
        message: error?.message,
        stack: error?.stack,
      });
    } finally {
      clearDeferredContext(req);
    }
  }
}

module.exports = AgentClient;
