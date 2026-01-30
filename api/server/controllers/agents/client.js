// /opt/open-webui/client.js - Финальная версия с исправленной логикой индексации и RAG через tools-gateway
require('events').EventEmitter.defaultMaxListeners = 100;
const { logger } = require('@librechat/data-schemas');
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
 * @param {number} [now=Date.now()] - Текущая отметка времени.
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
 * @param {unknown} payload - Данные для хэширования.
 * @returns {string} SHA1-хеш.
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
 * @param {Object} params
 * @param {string} params.conversationId
 * @param {string} params.endpoint
 * @param {string} params.model
 * @param {string} params.queryHash
 * @param {string} params.configHash
 * @returns {string} Ключ кэша.
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
 * @param {string[]} lines - Строки графового контента.
 * @param {{ maxLines: number, maxLineChars: number }} config - Настройки графа.
 * @returns {string[]} Нормализованные строки.
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
 * @param {string[]} chunks - Фрагменты контекста.
 * @param {{ maxChunks: number, maxChars: number }} config - Лимиты vector-контента.
 * @returns {string[]} Нормализованные фрагменты.
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
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function parseUsdRate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Определяет тарифы (prompt/completion) для расчёта стоимости токенов.
 *
 * Приоритет источников:
 * 1) pricing.models[model] или pricing.models.default;
 * 2) корневые поля pricing (promptUsdPer1k / completionUsdPer1k);
 * 3) env DEFAULT_PROMPT_USD_PER_1K / DEFAULT_COMPLETION_USD_PER_1K.
 *
 * @param {string} modelName
 * @param {object|undefined} pricingConfig
 * @returns {{ promptUsdPer1k: number|null, completionUsdPer1k: number|null, source: string }}
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
 * @description Fetches graph context from tools-gateway for RAG enhancement in agent conversations.
 * @param {Object} params - Parameters for graph context fetching.
 * @param {string} params.conversationId - Unique identifier of the conversation.
 * @param {string} params.toolsGatewayUrl - Base URL for the tools-gateway service.
 * @param {number} [params.limit=GRAPH_RELATIONS_LIMIT] - Maximum number of relations to fetch.
 * @param {number} [params.timeoutMs=GRAPH_REQUEST_TIMEOUT_MS] - Timeout for the request in milliseconds.
 * @returns {Promise<{lines: string[], queryHint: string}|null>} Graph context data or null if skipped/failed.
 * @throws {Error} If the request fails and cannot be handled gracefully.
 * @example
 * const context = await fetchGraphContext({ conversationId: '123', toolsGatewayUrl: 'http://gateway' });
 */
async function fetchGraphContext({ conversationId, toolsGatewayUrl, limit = GRAPH_RELATIONS_LIMIT, timeoutMs = GRAPH_REQUEST_TIMEOUT_MS }) {
  if (!USE_GRAPH_CONTEXT || !conversationId) {
    logger.warn('[DIAG-GRAPH] Graph context skipped', {
      useGraphContext: USE_GRAPH_CONTEXT,
      conversationId,
    });
    return null;
  }

  const url = `${toolsGatewayUrl}/neo4j/graph_context`;
  const requestPayload = { conversation_id: conversationId, limit };

  logger.info('[DIAG-GRAPH] Fetching graph context', {
    conversationId,
    toolsGatewayUrl,
    limit,
  });

  try {
    const response = await axios.post(url, requestPayload, { timeout: timeoutMs });

    const lines = Array.isArray(response?.data?.lines) ? response.data.lines : [];
    const queryHint = response?.data?.query_hint ? String(response.data.query_hint) : '';

    logger.info('[DIAG-GRAPH] Graph context response', {
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

    logger.error('[DIAG-GRAPH] Failed to fetch graph context', serializedError);

    try {
      if (typeof error?.toJSON === 'function') {
        logger.error('[DIAG-GRAPH] Axios error JSON', error.toJSON());
      }
    } catch (jsonErr) {
        logger.warn('[DIAG-GRAPH] Failed to serialize axios error', {
          message: jsonErr?.message,
          stack: jsonErr?.stack,
        });
      }

    return null;
  }
}

/**
 * @description Performs map-reduce condensation on context text for RAG using configured providers.
 * @param {Object} params - Parameters for context condensation.
 * @param {Object} params.req - Express request object.
 * @param {Object} params.res - Express response object.
 * @param {Object} params.endpointOption - Endpoint configuration options.
 * @param {string} params.contextText - Raw context text to condense.
 * @param {string} params.userQuery - User query for relevance scoring.
 * @param {Object|null} [params.graphContext=null] - Optional graph context data.
 * @param {{ budgetChars: number, chunkChars: number, provider?: string }|null} [params.summarizationConfig=null] - Summarization limits from runtime config.
 * @returns {Promise<string>} Condensed context text.
 * @throws {Error} If condensation fails, falls back to raw context.
 * @example
 * const condensed = await mapReduceContext({ req, res, endpointOption, contextText: 'long text', userQuery: 'query', summarizationConfig });
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
  };

  const {
    budgetChars: cfgBudget,
    chunkChars: cfgChunk,
    provider: cfgProvider,
  } = summarizationConfig ?? defaults;

  const budgetChars =
    Number.isFinite(cfgBudget) && cfgBudget > 0 ? Number(cfgBudget) : defaults.budgetChars;
  const chunkChars =
    Number.isFinite(cfgChunk) && cfgChunk > 0 ? Number(cfgChunk) : defaults.chunkChars;
  const provider = cfgProvider && typeof cfgProvider === 'string' ? cfgProvider : undefined;

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
    });

    logger.info('[rag.context.summarize.complete]', {
      initialLength: contextText.length,
      finalLength: finalContext.length,
      budgetChars,
      chunkChars,
      provider,
    });

    return finalContext;
  } catch (error) {
    logger.error('[rag.context.summarize.error]', {
      message: error?.message,
      stack: error?.stack,
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

/**
 * Provides safe logger methods with environment-aware fallbacks.
 * @returns {{info: function(...[*]): void, warn: function(...[*]): void, error: function(...[*]): void}}
 */
const createSafeLogger = () => {
  const noop = () => {};
  if (typeof logger !== 'object' || logger === null) {
    return { info: noop, warn: noop, error: noop };
  }
  return {
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : noop,
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : noop,
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : noop,
  };
};

const { info: safeInfo, warn: safeWarn, error: safeError } = createSafeLogger();

/**
 * Wraps a promise with a timeout.
 * @template T
 * @param {Promise<T>} promise - The promise to wrap.
 * @param {number} timeoutMs - Timeout in milliseconds.
 * @param {string} [timeoutMessage='Operation timed out'] - Error message on timeout.
 * @returns {Promise<T>} A promise that rejects on timeout.
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

/* Example withTimeout usage:
 * withTimeout(fetchData(), 5000, 'Fetch timed out').catch(console.error);
 */

/**
 * Normalizes instruction payload into a consistent object format.
 * @param {string|{content: string, tokenCount?: number}|null|undefined} rawInstructions - Raw instructions value.
 * @param {(() => string)|string} getEncoding - Function or string describing tokenizer encoding.
 * @param {string} [logPrefix='[AgentClient]'] - Prefix for log messages.
 * @returns {{content: string, tokenCount: number}} Normalized instructions.
 */
/**
 * @description Normalizes instruction payload into a consistent object format with token counting.
 * @param {string|{content: string, tokenCount?: number}|null|undefined} rawInstructions - Raw instructions value.
 * @param {(() => string)|string} getEncoding - Function or string describing tokenizer encoding.
 * @param {string} [logPrefix='[AgentClient]'] - Prefix for log messages.
 * @returns {{content: string, tokenCount: number}} Normalized instructions.
 * @example
 * const normalized = normalizeInstructionsPayload('instructions', 'o200k_base');
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

/* Example normalizeInstructionsPayload usage:
 * normalizeInstructionsPayload(null, () => 'o200k_base');
 * normalizeInstructionsPayload('Some instructions', 'o200k_base');
 * normalizeInstructionsPayload({ content: 'Structured', tokenCount: 10 }, () => 'o200k_base');
 */

/**
 * Extracts text content from a message object.
 * @param {Object|null|undefined} message - The message object.
 * @param {string} [logPrefix='[AgentClient]'] - Prefix for log messages.
 * @param {{silent?: boolean}} [options] - Options for extraction.
 * @returns {string} Extracted text content.
 */
/**
 * @description Extracts text content from a message object.
 * @param {Object|null|undefined} message - The message object.
 * @param {string} [logPrefix='[AgentClient]'] - Prefix for log messages.
 * @param {{silent?: boolean}} [options] - Options for extraction.
 * @returns {string} Extracted text content.
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
 * @description Normalizes and cleans memory text for RAG processing.
 * @param {string|null|undefined} text - Input text to normalize.
 * @param {string} [logPrefix='[history->RAG]'] - Prefix for log messages.
 * @returns {string} Normalized and cleaned text.
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

/* Example extractMessageText usage:
 * extractMessageText(null);
 * extractMessageText({ text: 'Hello' });
 * extractMessageText({ content: 'Line' });
 * extractMessageText({ content: [{ type: 'text', text: 'A' }] });
 * extractMessageText({ content: { foo: 'bar' } }, '[AgentClient]', { silent: true });
 */

/**
 * @description Generates a unique ingest key for deduplication in RAG.
 * @param {string} convId - Conversation ID.
 * @param {string|null} msgId - Message ID, if available.
 * @param {string} raw - Raw content for hashing if msgId is missing.
 * @returns {string} Unique ingest key.
 */
function makeIngestKey(convId, msgId, raw) {
  if (msgId) return `ing:${convId}:${msgId}`;
  const hash = crypto.createHash('md5').update(String(raw || '')).digest('hex');
  return `ing:${convId}:${hash}`;
}

/**
 * @description Condenses RAG query text by deduplicating and truncating.
 * @param {string} text - Input query text.
 * @param {number} [limit=RAG_QUERY_MAX_CHARS] - Maximum character limit.
 * @returns {string} Condensed query text.
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
 * @description Checks if the agent uses a Google/Gemini model.
 * @param {Object} agent - Agent configuration object.
 * @returns {boolean} True if Google/Gemini model, false otherwise.
 */
function isGoogleModel(agent) {
  const model = agent?.model_parameters?.model || agent?.model || '';
  return agent?.provider === Providers.GOOGLE || /gemini/i.test(model);
}

/**
 * @description Parses model parameters based on endpoint type.
 * @param {Object} params - Parsing parameters.
 * @param {Object} params.req - Express request object.
 * @param {Object} params.agent - Agent configuration.
 * @param {string} params.endpoint - Endpoint type.
 * @returns {Object} Parsed model parameters.
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
 * @description Creates a token counter function for messages.
 * @param {string} encoding - Tokenizer encoding.
 * @returns {function(Object): number} Token counting function.
 */
function createTokenCounter(encoding) {
  return function (message) {
    const countTokens = (text) => Tokenizer.getTokenCount(text, encoding);
    return getTokenCountForMessage(message, countTokens);
  };
}

/**
 * @description Logs tool errors with structured details.
 * @param {Object} graph - Graph context.
 * @param {Error} error - Error object.
 * @param {string} toolId - Tool identifier.
 * @returns {void}
 */
function logToolError(graph, error, toolId) {
  logAxiosError({
    error,
    message: `[api/server/controllers/agents/client.js #chatCompletion] Tool Error "${toolId}"`,
  });
}

/**
 * @description Detects if error is context overflow (400 with token limit message).
 * @param {Error} error - Error object to check.
 * @returns {boolean} True if context overflow detected.
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
 * @description Aggressively compresses messages for retry after context overflow.
 * @param {Array} messages - Original messages array.
 * @param {number} targetReduction - Target reduction percentage (0-1).
 * @returns {Array} Compressed messages array.
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
 * @description Agent client for handling AI agent interactions, RAG, and tool integrations.
 * @extends BaseClient
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
        logger.info(`[trace] ${JSON.stringify(Object.assign(meta, cleaned))}`);
      } catch (error) {
        logger.warn('[trace] failed to emit trace log: %s', error?.message || error);
      }
    };
  }

  /**
     * @description Returns the content parts associated with the agent client.
     * @returns {Array} Array of content parts.
     */
  getContentParts() {
    return this.contentParts;
  }

  /**
   * @description Sets options for the agent client and logs them.
   * @param {Object} options - Options object to set.
   * @returns {void}
   */
  setOptions(options) {
    logger.info('[api/server/controllers/agents/client.js] setOptions', options);
  }

  /**
   * @description Checks if the request involves vision capabilities (placeholder implementation).
   * @returns {void}
   */
  checkVisionRequest() {}

  /**
   * @description Generates save options by parsing model parameters and removing nullish values.
   * @returns {Object} Parsed and cleaned save options.
   * @throws {Error} If payload parsing fails.
   */
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

  /**
   * @description Returns options for building messages, including instructions.
   * @returns {Object} Options object with instructions and additional_instructions.
   */
  getBuildMessagesOptions() {
    return {
      instructions: this.options.agent.instructions,
      additional_instructions: this.options.agent.additional_instructions,
    };
  }

  /**
   * @description Adds image URLs to the message and handles file ingestion for RAG if applicable.
   * @param {Object} message - Message object to modify.
   * @param {Array} attachments - Array of file attachments.
   * @returns {Promise<Array>} Array of processed files.
   * @throws {Error} If file encoding or task enqueueing fails.
   */
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
            Math.min(MEMORY_TASK_TIMEOUT_MS, 10000), // Cap timeout for file indexing
            'Memory indexing timed out',
          );
            
          // Set flag only for successful blocking operations
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


  /**
   * Формирует RAG-контекст для текущего разговора с использованием кеша, лимитов и метрик.
   * @param {Object} params
   * @param {Array<Object>} params.orderedMessages - Сообщения беседы в упорядоченном виде.
   * @param {string} params.systemContent - Исходный системный промпт до вставки RAG-контента.
   * @param {Object} params.runtimeCfg - Текущая конфигурация памяти.
   * @param {Object} params.req - Express Request.
   * @param {Object} params.res - Express Response.
   * @param {Object} params.endpointOption - Настройки конца, включая модель.
   * @returns {Promise<{ patchedSystemContent: string, contextLength: number, cacheStatus: 'hit'|'miss'|'skipped', metrics: Object }>}
   */
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

    if (!runtimeCfg.useConversationMemory || !conversationId || !userQuery) {
      logger.info('[rag.context.skip]', {
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
      logger.info(
        `[rag.context.limit] conversation=${conversationId} param=memory.ragQuery.maxChars limit=${queryMaxChars} original=${userQuery.length}`
      );
    }

    const normalizedQuery = userQuery.slice(0, queryMaxChars);
    const queryTokenCount = Tokenizer.getTokenCount(normalizedQuery, encoding);
    logger.info(
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
        return {
          patchedSystemContent: cached.systemContent,
          contextLength: cached.contextLength,
          cacheStatus,
          metrics: cachedMetrics,
        };
      }

      cacheStatus = 'miss';
      observeCache('miss');
      logger.info(
        `[rag.context.cache.miss] conversation=${conversationId} cacheKey=${cacheKey}`
      );
    } else {
      logger.info('[rag.context.cache.skip]', {
        conversationId,
        cacheKey,
        reason: 'cache_disabled',
      });
    }

    const toolsGatewayUrl = runtimeCfg?.toolsGateway?.url || '';
    const toolsGatewayTimeout = runtimeCfg?.toolsGateway?.timeoutMs || 20000;
    const graphLimits = runtimeCfg.graphContext || {};
    const vectorLimits = runtimeCfg.vectorContext || {};

    // Нормализация лимитов для защиты от undefined - ДОЛЖНО БЫТЬ ЗДЕСЬ
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
            logger.info(
              `[rag.context.limit] conversation=${conversationId} param=memory.graphContext.maxLines limit=${graphMaxLines} original=${rawGraphLinesCount}`
            );
          }

          if (
            graphContextLines.some((line) => line.endsWith('…')) &&
            graphMaxLineChars
          ) {
            logger.info(
              `[rag.context.limit] conversation=${conversationId} param=memory.graphContext.maxLineChars limit=${graphMaxLineChars}`
            );
          }
        }

        logger.info(
          `[rag.context.graph.raw] conversation=${conversationId} rawLines=${rawGraphLinesCount} sanitizedLines=${graphContextLines.length}`
        );

        if (typeof graphContext?.queryHint === 'string') {
          const trimmedHint = graphContext.queryHint.trim();
          if (trimmedHint) {
            if (
              graphSummaryHintMaxChars &&
              trimmedHint.length > graphSummaryHintMaxChars
            ) {
              logger.info(
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
      logger.warn('[rag.context.graph.skip]', {
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
      logger.info('[rag.context.query.condensed]', {
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
      // Semantic search
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

        logger.info(
          `[rag.context.vector.raw] conversation=${conversationId} rawResults=${rawVectorResults} sanitizedChunks=${vectorChunks.length} topK=${vectorTopK}`
        );
        logger.info('[rag.context.vector.limits]', { 
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

      // Часть C: Recent turns для устойчивости
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

          logger.info('[rag.context.recent]', { 
            conversationId, 
            recentTurns, 
            got: recentChunks.length 
          });
        } catch (e) {
          const status = e?.response?.status;
          if (status === 404 || status === 501) {
            logger.info('[rag.context.recent.unavailable]', { conversationId, status });
          } else {
            logger.warn('[rag.context.recent.skip]', { 
              conversationId, 
              reason: e?.message, 
              status 
            });
          }
        }
      }

      // Объединяем recent + semantic с дедупликацией
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
        logger.info(
          `[rag.context.limit] conversation=${conversationId} param=memory.vectorContext.maxChunks limit=${vectorMaxChunks} original=${rawVectorResults}`
        );
      }

      if (
        vectorChunks.some((chunk) => chunk.endsWith('…')) &&
        vectorMaxChars
      ) {
        logger.info(
          `[rag.context.limit] conversation=${conversationId} param=memory.vectorContext.maxChars limit=${vectorMaxChars}`
        );
      }
    } else {
      logger.warn('[rag.context.vector.skip]', {
        conversationId,
        reason: 'tools_gateway_missing',
      });
    }

    metrics.vectorChunks = vectorChunks.length;

    const hasGraph = graphContextLines.length > 0;
    const policyIntro =
      'Ниже предоставлен внутренний контекст для твоего сведения: граф знаний и выдержки из беседы. ' +
      'Используй эти данные для формирования точного и полного ответа. ' +
      'Категорически запрещается цитировать или пересказывать этот контекст, особенно строки, содержащие "-->". ' +
      'Эта информация предназначена только для твоего внутреннего анализа.\n\n';

    if (!hasGraph && vectorChunks.length === 0) {
      logger.info(
        `[rag.context.tokens] conversation=${conversationId} graphTokens=0 vectorTokens=0 contextTokens=0`
      );
    } else {
      const summarizationCfg = runtimeCfg.summarization || {};
      const defaults = { budgetChars: 12000, chunkChars: 20000 };
      const budgetChars =
        Number.isFinite(summarizationCfg?.budgetChars) && summarizationCfg.budgetChars > 0
          ? summarizationCfg.budgetChars
          : defaults.budgetChars;
      const chunkChars =
        Number.isFinite(summarizationCfg?.chunkChars) && summarizationCfg.chunkChars > 0
          ? summarizationCfg.chunkChars
          : defaults.chunkChars;

      let vectorText = vectorChunks.join('\n\n');
      const rawVectorTextLength = vectorText.length;
      const shouldSummarize =
        summarizationCfg.enabled !== false && vectorText.length > budgetChars;

      if (shouldSummarize) {
        logger.info(
          `[rag.context.limit] conversation=${conversationId} param=memory.summarization.budgetChars limit=${budgetChars} original=${rawVectorTextLength}`
        );
        try {
          const summarizationTimeoutMs = runtimeCfg.summarization?.timeoutMs ?? 25000;
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
              },
            }),
            summarizationTimeoutMs,
            'RAG summarization timed out'
          );
        } catch (summarizeError) {
          logger.error('[rag.context.vector.summarize.error]', {
            message: summarizeError?.message,
            stack: summarizeError?.stack,
            timeout: summarizeError?.message?.includes('timed out'),
          });
          
          // On timeout, fall back to truncated text
          if (summarizeError?.message?.includes('timed out')) {
            const fallbackLength = Math.min(vectorText.length, budgetChars);
            vectorText = vectorText.slice(0, fallbackLength);
            logger.warn(
              `[rag.context.vector.summarize.fallback] Using truncated text (${fallbackLength} chars) due to timeout`
            );
          }
        }
      }

      const graphBlock = hasGraph
        ? `### Graph context\n${graphContextLines.join('\n')}\n\n`
        : '';
      const vectorBlock = vectorText.length
        ? `### Vector context\n${vectorText}\n\n`
        : '';
      const combined = `${policyIntro}${graphBlock}${vectorBlock}---\n\n`;

      let sanitizedBlock = combined;
      try {
        sanitizedBlock = sanitizeInput(combined);
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

      if (vectorBlock) {
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

      logger.info(
        `[rag.context.tokens] conversation=${conversationId} graphTokens=${metrics.graphTokens} vectorTokens=${metrics.vectorTokens} contextTokens=${metrics.contextTokens}`
      );
    }

    if (runtimeCfg.enableMemoryCache) {
      ragCache.set(cacheKey, {
        systemContent: finalSystemContent,
        contextLength,
        metrics,
        expiresAt: now + ragCacheTtlMs,
      });
      logger.info(
        `[rag.context.cache.store] conversation=${conversationId} cacheKey=${cacheKey} contextTokens=${metrics.contextTokens} graphTokens=${metrics.graphTokens} vectorTokens=${metrics.vectorTokens} queryTokens=${metrics.queryTokens}`
      );
    }

    if (req) {
      req.ragCacheStatus = cacheStatus;
      req.ragMetrics = Object.assign({}, req.ragMetrics, metrics);
      req.ragContextTokens = metrics.contextTokens;
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
    let orderedMessages = this.constructor.getMessagesForConversation({
      messages,
      parentMessageId,
      summary: this.shouldSummarize,
    });
    
    
    const MAX_MESSAGES_TO_PROCESS = 25;
    
    // Часть B: Обработка dropped messages для RAG
    let systemMessage = orderedMessages.find(m => m.role === 'system');
    let otherMessages = orderedMessages.filter(m => m.role !== 'system');
    let droppedMessages = [];

    if (otherMessages.length > MAX_MESSAGES_TO_PROCESS) {
      const keptMessages = otherMessages.slice(-MAX_MESSAGES_TO_PROCESS);
      droppedMessages = otherMessages.slice(0, otherMessages.length - MAX_MESSAGES_TO_PROCESS);
      
      orderedMessages = systemMessage ? [systemMessage, ...keptMessages] : keptMessages;
      
      logger.warn(`[PROMPT-LIMIT] Принудительно усекаем историю с ${otherMessages.length} до ${MAX_MESSAGES_TO_PROCESS} сообщений. Dropped: ${droppedMessages.length}`);
      
      // Отправляем dropped messages в RAG
      const convId = this.conversationId || this.options?.req?.body?.conversationId;
      const userId = this.options?.req?.user?.id;

      if (convId && userId && droppedMessages.length) {
        const droppedTasks = [];

        for (const m of droppedMessages) {
          const rawText = extractMessageText(m, '[history->RAG][dropped]');
          const normalizedText = normalizeMemoryText(rawText, '[history->RAG][dropped]');

          if (!normalizedText || normalizedText.length < 20) continue;

          const dedupeKey = makeIngestKey(convId, m.messageId, normalizedText);
          if (IngestedHistory.has(dedupeKey)) continue;

          IngestedHistory.add(dedupeKey);

          const stableId = m.messageId || `dropped-${hashPayload(normalizedText).slice(0, 12)}`;
          droppedTasks.push({
            type: 'add_turn',
            payload: {
              conversation_id: convId,
              message_id: stableId,
              role: m?.isCreatedByUser ? 'user' : 'assistant',
              content: normalizedText,
              user_id: userId,
            },
          });
        }

        if (droppedTasks.length) {
          try {
            // For dropped messages, use fire-and-forget to avoid blocking user request
            const result = await withTimeout(
              enqueueMemoryTasks(droppedTasks, {
                reason: 'history_window_drop',
                conversationId: convId,
                userId,
                messageCount: droppedTasks.length,
                fireAndForget: droppedTasks.length > 50, // Fire-and-forget for large batches
              }),
              Math.min(MEMORY_TASK_TIMEOUT_MS, 5000), // Cap timeout for dropped messages
              'Dropped history ingest timed out',
            );
            
            // Don't set didEnqueueIngest for dropped messages to avoid unnecessary waiting
            logger.info(`[history->RAG][dropped] queued ${droppedTasks.length} dropped messages`, {
              conversationId: convId,
              status: result?.status,
              actualCount: result?.count,
            });
          } catch (queueError) {
            safeError('[history->RAG][dropped] Failed to enqueue dropped messages', {
              conversationId: convId,
              messageCount: droppedTasks.length,
              message: queueError?.message,
            });
          }
        }
      }
    }
    const runtimeCfg = runtimeMemoryConfig.getMemoryConfig();
    logger.info({
      msg: '[config.history]',
      conversationId: this.conversationId,
      dontShrinkLastN: runtimeCfg?.history?.dontShrinkLastN,
      historyTokenBudget: runtimeCfg?.history?.tokenBudget ?? configService.getNumber('memory.history.tokenBudget', 0),
    });
    ragCacheTtlMs = Math.max(Number(runtimeCfg?.ragCacheTtl) * 1000, 0);
    const endpointOption = this.options?.req?.body?.endpointOption ?? this.options?.endpointOption ?? {};
    logger.info({
      msg: '[AgentClient.buildMessages] start',
      conversationId: this.conversationId,
      orderedMessagesCount: orderedMessages.length,
    });
    try { this.trace('trace:build.start', {
      total: orderedMessages.length,
      lastIds: orderedMessages.slice(-3).map(m => m && m.messageId).join(',')
    }); } catch {}

    try {
      const convId = this.conversationId || this.options?.req?.body?.conversationId;
      const requestUserId = this.options?.req?.user?.id || null;
      const toIngest = [];
      const totalMessages = orderedMessages.length;
      const dontShrinkConfigured = runtimeCfg?.history?.dontShrinkLastN;
      const effectiveDontShrink = Number.isFinite(dontShrinkConfigured)
        ? Math.max(dontShrinkConfigured, 0)
        : 0;
      const dontShrinkStartIndex = Math.max(totalMessages - effectiveDontShrink, 0);

      for (let idx = 0; idx < orderedMessages.length; idx++) {
        const m = orderedMessages[idx];
        try {
          const rawText = extractMessageText(m, '[history->RAG]');
          const normalizedText = normalizeMemoryText(rawText);
          const len = normalizedText.length;

          const looksHTML =
            /</i.test(normalizedText) &&
            /<html|<body|<div|<p|<span/i.test(normalizedText);

          let hasThink = false;
          if (Array.isArray(m?.content)) {
            hasThink = m.content.some(
              (part) =>
                part?.type === 'think' &&
                typeof part.think === 'string' &&
                part.think.trim().length > 0,
            );
          }
          if (!hasThink) {
            const t = normalizedText;
            hasThink = /(^|\n)\s*(Мысли|Рассуждения|Thoughts|Chain of Thought)\s*:/i.test(t);
          }

          const shouldShrinkUser = m?.isCreatedByUser && (len > HIST_LONG_USER_TO_RAG || looksHTML);
          const shouldShrinkAssistant =
            !m?.isCreatedByUser && (len > ASSIST_LONG_TO_RAG || looksHTML || hasThink);

          const messageUserId =
            requestUserId ||
            m?.user ||
            m?.metadata?.user ||
            m?.metadata?.user_id ||
            this?.user ||
            null;

          if ((shouldShrinkUser || shouldShrinkAssistant) && convId && normalizedText && normalizedText.length >= 20 && messageUserId) {
            const dedupeKey = makeIngestKey(convId, m.messageId, normalizedText);

            if (IngestedHistory.has(dedupeKey)) {
              logger.debug('[history->RAG][dedup] skip message already enqueued', {
                conversationId: convId,
                messageId: m?.messageId,
              });
            } else {
              const stableId = m.messageId || `hist-${idx}-${hashPayload(normalizedText).slice(0, 12)}`;
              const taskPayload = {
                message_id: stableId,
                content: normalizedText,
                role: m?.isCreatedByUser ? 'user' : 'assistant',
                user_id: messageUserId,
              };
              IngestedHistory.add(dedupeKey);
              toIngest.push(taskPayload);
              logger.info('[history->RAG] prepared memory task', {
                conversationId: convId,
                messageId: taskPayload.message_id,
                role: taskPayload.role,
                textLength: len,
              });
            }

            const roleTag = m?.isCreatedByUser ? 'user' : 'assistant';
            const isLatestMessage = idx === orderedMessages.length - 1;
            const skipShrinkForRecent = idx >= dontShrinkStartIndex;
            const keepFullText = isLatestMessage || skipShrinkForRecent;

            if (!keepFullText) {
              const snippetLen = m?.isCreatedByUser ? 2000 : ASSIST_SNIPPET_CHARS;
              const snippet = normalizedText.slice(0, snippetLen);
              m.text = `[[moved_to_memory:RAG,len=${len},role=${roleTag}]]\n\n${snippet}`;
              if (Array.isArray(m?.content)) {
                m.content = [{ type: 'text', text: m.text }];
              }

              const limitLabel = m?.isCreatedByUser ? 'HIST_LONG_USER_TO_RAG' : 'ASSIST_LONG_TO_RAG';
              const limitValue = m?.isCreatedByUser ? HIST_LONG_USER_TO_RAG : ASSIST_LONG_TO_RAG;
              const shrinkReason = looksHTML ? 'html' : hasThink ? 'reasoning' : 'length';
              logger.info(
                `[prompt][shrink] idx=${idx} role=${roleTag} reason=${shrinkReason} limit=${limitLabel} limitValue=${limitValue} snippetLen=${snippet.length}`
              );
            } else {
              logger.info(
                `[prompt][shrink] idx=${idx} role=${roleTag} len=${len} action=keep-full keepReason=memory.history.dontShrinkLastN value=${effectiveDontShrink}`
              );
            }
          }
        } catch (error) {
          logger.warn('[history->RAG] error while scanning message', {
            conversationId: convId,
            messageId: m?.messageId,
            error: error?.message,
            stack: error?.stack,
          });
        }
      }

      if (toIngest.length && convId) {
        const tasks = toIngest
          .map((t) => ({
            type: 'add_turn',
            payload: {
              conversation_id: convId,
              message_id: t.message_id,
              role: t.role,
              content: t.content,
              user_id: t.user_id,
            },
          }))
          .filter((task) => task.payload.user_id);

        if (tasks.length) {
          const totalLength = tasks.reduce(
            (acc, task) => acc + (task.payload.content?.length ?? 0),
            0,
          );
          try {
            const result = await withTimeout(
              enqueueMemoryTasks(
                tasks,
                {
                  reason: 'history_sync',
                  conversationId: convId,
                  userId: requestUserId,
                  textLength: totalLength,
                },
              ),
              MEMORY_TASK_TIMEOUT_MS,
              'History sync timed out',
            );
            
            // Set flag only for successful blocking operations
            if (this.options?.req && result?.status === 'queued') {
              this.options.req.didEnqueueIngest = true;
            }
            logger.info(
              `[history->RAG] queued ${tasks.length} turn(s) через JetStream ` +
              `(conversation=${convId}, totalChars=${totalLength}).`,
            );
          } catch (queueError) {
            safeError('[history->RAG] Failed to enqueue history tasks', {
              conversationId: convId,
              messageCount: tasks.length,
              message: queueError?.message,
            });
          }
        } else {
          logger.info('[history->RAG] nothing enqueued (missing user_id).');
        }
      }
    } catch (e) {
      logger.error('[history->RAG] failed', e);
    }


    let systemContent = [instructions ?? '', additional_instructions ?? '']
      .filter(Boolean)
      .join('\n')
      .trim();
    /**
     * @description Fallback для новых чатов: если нет истории сообщений и systemContent пуст,
     * устанавливаем базовый промпт 'You are a helpful assistant.' для работы RAG.
     * TODO: рассмотреть взятие дефолтного промпта из конфигурации агента.
     */
    if (orderedMessages.length === 0 && systemContent.length === 0) {
        systemContent = 'You are a helpful assistant.';
        logger.info('[DEBUG] Applied fallback systemContent for new chat');
    }
    logger.info(`[DIAG-PROMPT] Initial systemContent (from instructions/additional_instructions): ${systemContent.length} chars`);

    let ragContextLength = 0;
    let ragCacheStatus = 'skipped';
    const req = this.options?.req;
    const res = this.options?.res;

    if (req) {
      req.ragCacheStatus = ragCacheStatus;
    }

    // Часть A: Применение WAIT_FOR_RAG_INGEST_MS из runtimeCfg с upper bound
    // Only wait for blocking operations (history_sync, index_file), not dropped messages
    const waitMsRaw = Number(runtimeCfg?.rag?.history?.waitForIngestMs ?? runtimeCfg?.history?.waitForIngestMs ?? 0);
    const waitMs = Math.min(Math.max(waitMsRaw, 0), 3000); // Reduced max wait time
    const didIngest = Boolean(req?.didEnqueueIngest);
    
    if (didIngest && waitMs > 0) {
      logger.info('[history->RAG] waiting before rag/search', { 
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

      logger.info('[rag.context.applied]', {
        conversationId: this.conversationId,
        cacheStatus: ragCacheStatus,
        contextLength: ragContextLength,
        contextTokens: ragResult?.metrics?.contextTokens ?? 0,
        graphTokens: ragResult?.metrics?.graphTokens ?? 0,
        vectorTokens: ragResult?.metrics?.vectorTokens ?? 0,
      });
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

    instructions = normalizeInstructionsPayload(
      systemContent,
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
   logger.info('[prompt.payload]', {
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
      logger.warn('[DIAG-PROMPT] Memory (withoutKeys) generated but not explicitly added to prompt, as system message already formed.');
    }

    return result;
  }

  /**
   * @description Awaits memory processing with a timeout to prevent hanging.
   * @param {Promise} memoryPromise - Promise for memory processing.
   * @param {number} [timeoutMs=3000] - Timeout in milliseconds.
   * @returns {Promise<any>} Resolved attachments or undefined on timeout/error.
   */
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

  /**
   * @description Initializes and configures memory processing for the agent.
   * @returns {Promise<Object|null>} Memory processor configuration or null if disabled/unavailable.
   * @throws {Error} If agent loading or initialization fails.
   */
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

  /**
   * @description Filters out image URLs from message content for memory processing.
   * @param {Object} message - Message object to filter.
   * @returns {Object} Filtered message without image URLs.
   */
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

  /**
   * @description Processes messages through memory agent for context enhancement.
   * @param {Array} messages - Array of messages to process.
   * @returns {Promise<any>} Processed memory result or undefined on error.
   * @throws {Error} If memory processing fails.
   */
  /**
   * Анализирует последние сообщения и отправляет уникальные фрагменты в memory-агент.
   * @param {Array} messages
   * @returns {Promise<any>}
   */
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

  /**
   * @description Sends completion request and returns content parts.
   * @param {Object} payload - Payload for completion.
   * @param {Object} [opts] - Options including onProgress, userMCPAuthMap, abortController.
   * @returns {Promise<Array>} Content parts from completion.
   * @throws {Error} If chat completion fails.
   */
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

  /**
   * @description Returns the current stream usage statistics.
   * @returns {Object} Usage object with input/output tokens.
   */
  getStreamUsage() {
    return this.usage;
  }

  /**
   * @description Calculates token count for assistant response content.
   * @param {Object} params - Response parameters.
   * @param {string} params.content - Response content.
   * @returns {number} Token count.
   */
  getTokenCountForResponse({ content }) {
    return this.getTokenCountForMessage({
      role: 'assistant',
      content,
    });
  }

  /**
   * @description Calculates current message token count from usage and map.
   * @param {Object} params - Calculation parameters.
   * @param {Object} params.tokenCountMap - Map of token counts.
   * @param {string} params.currentMessageId - Current message ID.
   * @param {Object} params.usage - Usage statistics.
   * @returns {number} Calculated token count.
   */
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

  /**
   * @description Executes chat completion with agent processing, streaming, and tool handling.
   * @param {Object} params - Completion parameters.
   * @param {Object} params.payload - Payload for completion.
   * @param {Object} [params.userMCPAuthMap] - MCP authentication map.
   * @param {AbortController} [params.abortController] - Abort controller for cancellation.
   * @returns {Promise<void>}
   * @throws {Error} If agent run or processing fails.
   */
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
        logger.debug(`[diag][fmt] messages=${diag.length}, top=${top.map((t) => `#${t.i}:${t.role}:${t.len}`).join(', ')}`);
      } catch (e) {
        logger.error('[diag][fmt] log error', e);
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
          const latestMessageContent = _messages.pop().content;
          if (typeof latestMessageContent !== 'string') {
            latestMessageContent[0].text = [systemContent, latestMessageContent[0].text].join('\n');
            _messages.push(new HumanMessage({ content: latestMessageContent }));
          } else {
            const text = [systemContent, latestMessageContent].join('\n');
            _messages.push(new HumanMessage(text));
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

        // ДОБАВЛЕНО: Детальное логирование перед вызовом createRun
        logger.info('[agent.run.debug] Agent configuration', {
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

        // ДОБАВЛЕНО: Логирование запроса к модели
        logger.info('[agent.run.request] Request to model', {
          conversationId: this.conversationId,
          agentId: agent.id,
          model: agent.model_parameters?.model,
          provider: agent.provider,
          baseURL: agent.model_parameters?.configuration?.baseURL,
          messagesPreview: messages.slice(0, 2).map(m => ({
            role: typeof m._getType === 'function' ? m._getType() : m.role,
            contentLength: typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length,
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
        
        // ДОБАВЛЕНО: Логирование перед processStream
        logger.info('[agent.run.processStream] Starting stream processing', {
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

      // Main execution loop with retry logic
      while (retryAttempt <= MAX_RETRIES) {
        try {
          await runAgent(this.options.agent, initialMessages);
          break; // Success, exit retry loop
        } catch (runError) {
          if (detectContextOverflow(runError) && retryAttempt < MAX_RETRIES) {
            retryAttempt++;
            const reductionFactor = 0.3 + (retryAttempt * 0.2); // 30%, 50%, 70% reduction
            
            logger.warn('[context.overflow.retry]', {
              conversationId: this.conversationId,
              attempt: retryAttempt,
              maxRetries: MAX_RETRIES,
              reductionFactor,
              originalError: runError?.message,
            });

            // Compress messages for retry
            initialMessages = compressMessagesForRetry(initialMessages, reductionFactor);
            
            logger.info('[context.overflow.compressed]', {
              conversationId: this.conversationId,
              attempt: retryAttempt,
              newMessageCount: initialMessages.length,
              reductionFactor,
            });

            // Wait a bit before retry
            await new Promise(resolve => setTimeout(resolve, 500 * retryAttempt));
            continue;
          }
          
          // If not overflow or max retries reached, throw error
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

      // Check if this is a context overflow error after all retries
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

      // ИСПРАВЛЕНО: Используем JSON.stringify для вывода объекта с деталями ошибки
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
        `[api/server/controllers/agents/client.js #sendCompletion] Unhandled error ${err?.response?.status || err?.code || 'unknown'} ${err?.message || 'Provider returned error'}\n${JSON.stringify(errorDetails, null, 2)}`
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

  /**
   * @description Generates a conversation title using Ollama or fallback.
   * @param {Object} params - Title generation parameters.
   * @param {string} params.text - Text to base title on.
   * @param {AbortController} params.abortController - Abort controller.
   * @returns {Promise<string>} Generated title.
   * @throws {Error} If title generation fails.
   */
  async titleConvo({ text, abortController }) {
    const ollamaConfig = configService.get('ollama', {});
    const USE_OLLAMA_FOR_TITLES = configService.getBoolean('features.useOllamaForTitles', false);
    const OLLAMA_TITLE_URL = ollamaConfig.titleUrl || ollamaConfig.url || 'http://127.0.0.1:11434';
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
            logger.warn(`[title] Ollama title generation failed or returned empty. Falling back. Response: ${JSON.stringify(response.data)}`);
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

  /**
   * @description Returns the tokenizer encoding based on model.
   * @returns {string} Encoding name (e.g., 'cl100k_base' or 'o200k_base').
   */
  getEncoding() {
    const model = this.options?.agent?.model_parameters?.model || this.model;
    if (model && /gemini/i.test(model)) {
        return 'cl100k_base'; // Gemini использует похожий токенизатор
    }
    return 'o200k_base'; // Для GPT-4o
  }

  /**
   * @description Counts tokens in the given text using the current encoding.
   * @param {string} text - Text to count tokens for.
   * @returns {number} Token count.
   */
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
}

module.exports = AgentClient;
