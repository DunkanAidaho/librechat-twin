'use strict';

const path = require('path');

const BOOL_TRUE = new Set(['1', 'true', 'yes', 'on']);
const BOOL_FALSE = new Set(['0', 'false', 'no', 'off']);

function parseBoolean(value, defaultValue) {
  if (value == null) {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (BOOL_TRUE.has(normalized)) {
    return true;
  }
  if (BOOL_FALSE.has(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseInteger(value, defaultValue, options = {}) {
  if (value == null || value === '') {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }
  if (options.min != null && parsed < options.min) {
    return options.min;
  }
  if (options.max != null && parsed > options.max) {
    return options.max;
  }
  return parsed;
}

function resolvePath(value, defaultValue) {
  if (!value || String(value).trim().length === 0) {
    return path.resolve(defaultValue);
  }
  return path.resolve(value);
}

function getDefaultedPricingUrl() {
  const overrideUrl = process.env.OPENROUTER_PRICING_URL;
  if (overrideUrl && overrideUrl.trim().length > 0) {
    return overrideUrl.trim().replace(/\/+$/, '');
  }
  const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const normalized = String(baseUrl).replace(/\/+$/, '');
  return `${normalized}/models/user`;
}

function buildMemoryConfig() {
  const useConversationMemory = parseBoolean(process.env.USE_CONVERSATION_MEMORY, true);
  const enableMemoryCache = parseBoolean(
    process.env.ENABLE_MEMORY_CACHE,
    useConversationMemory,
  );

  const fallbackGraphLines = parseInteger(process.env.RAG_GRAPH_MAX_LINES, 8, { min: 1 });
  const graphMaxLines = parseInteger(
    process.env.GRAPH_CONTEXT_LINE_LIMIT,
    fallbackGraphLines,
    { min: 1 },
  );
  const graphMaxLineChars = parseInteger(
    process.env.GRAPH_CONTEXT_MAX_LINE_CHARS,
    200,
    { min: 40 },
  );
  const ragQueryMaxChars = parseInteger(process.env.RAG_QUERY_MAX_CHARS, 6000, { min: 500 });
  const graphSummaryLineLimit = parseInteger(
    process.env.GRAPH_CONTEXT_SUMMARY_LINE_LIMIT,
    Math.min(graphMaxLines, 8),
    { min: 1 },
  );
  const graphSummaryHintMaxChars = parseInteger(
    process.env.GRAPH_CONTEXT_SUMMARY_HINT_MAX_CHARS,
    2000,
    { min: 200 },
  );

  const vectorMaxChunks = parseInteger(process.env.RAG_VECTOR_MAX_CHUNKS, 3, { min: 1 });
  const vectorMaxChars = parseInteger(process.env.RAG_VECTOR_MAX_CHARS, 2000, { min: 200 });
  const vectorTopK = parseInteger(process.env.RAG_CONTEXT_TOPK, 12, { min: 1 });
  const vectorEmbeddingModelRaw = (process.env.RAG_SEARCH_MODEL || 'mxbai').trim();
  const vectorEmbeddingModel = vectorEmbeddingModelRaw.length > 0 ? vectorEmbeddingModelRaw : 'mxbai';

  const ragCacheTtl = parseInteger(process.env.RAG_CACHE_TTL, 900, { min: 0 });
  const memoryActivationThreshold = parseInteger(
    process.env.MEMORY_ACTIVATION_THRESHOLD,
    6,
    { min: 0 },
  );
  const toolsGatewayUrlRaw = process.env.TOOLS_GATEWAY_URL;
  const toolsGatewayUrl = toolsGatewayUrlRaw && toolsGatewayUrlRaw.trim().length > 0
    ? toolsGatewayUrlRaw.trim()
    : 'http://10.10.23.1:8000';
  const toolsGatewayTimeoutMs = parseInteger(process.env.TOOLS_GATEWAY_TIMEOUT_MS, 20000, { min: 1000 });

  const maxMessageTokens = parseInteger(process.env.MAX_MESSAGE_TOKENS, 0, { min: 0 });
  const truncateLongMessages = parseBoolean(process.env.TRUNCATE_LONG_MESSAGES, true);
  const maxUserMessageChars = parseInteger(
    process.env.MAX_USER_MSG_TO_MODEL_CHARS,
    0,
    { min: 0 },
  );
  const promptPerMsgMax = parseInteger(process.env.PROMPT_PER_MSG_MAX, 0, { min: 0 });
  const historyTokenBudget = parseInteger(
    process.env.HISTORY_TOKEN_BUDGET,
    8000,
    { min: 0 },
  );
  const dontShrinkLastN = parseInteger(process.env.DONT_SHRINK_LAST_N, 4, { min: 0 });

  const summarizationBudget = parseInteger(
    process.env.RAG_SUMMARY_BUDGET,
    12000,
    { min: 1000 },
  );
  const summarizationChunkChars = parseInteger(
    process.env.RAG_CHUNK_CHARS,
    20000,
    { min: 1000 },
  );
  const summarizationEnabled = parseBoolean(process.env.RAG_SUMMARIZE_IF_OVER, true);
  const summarizationProvider = process.env.RAG_VECTOR_SUMMARY_PROVIDER || '';

  const tokenUsageReportMode = (process.env.TOKEN_USAGE_REPORT_MODE || 'json').trim().toLowerCase();

  const pricingRefreshSec = parseInteger(
    process.env.OPENROUTER_PRICING_REFRESH_SEC,
    86400,
    { min: 3600 },
  );
  const pricingCachePath = resolvePath(
    process.env.OPENROUTER_PRICING_CACHE_PATH,
    './api/cache/openrouter_pricing.json',
  );

  return Object.freeze({
      useConversationMemory,
      enableMemoryCache,
      ragCacheTtl,
      memoryActivationThreshold,
      tokenLimits: Object.freeze({
        maxMessageTokens,
        truncateLongMessages,
        maxUserMessageChars,
        promptPerMsgMax,
      }),
      history: Object.freeze({
        dontShrinkLastN,
        tokenBudget: historyTokenBudget,
      }),
      toolsGateway: Object.freeze({
        url: toolsGatewayUrl,
        timeoutMs: toolsGatewayTimeoutMs,
      }),
      ragQuery: Object.freeze({
        maxChars: ragQueryMaxChars,
      }),
      graphContext: Object.freeze({
        maxLines: graphMaxLines,
        maxLineChars: graphMaxLineChars,
        summaryLineLimit: graphSummaryLineLimit,
        summaryHintMaxChars: graphSummaryHintMaxChars,
      }),
      vectorContext: Object.freeze({
        maxChunks: vectorMaxChunks,
        maxChars: vectorMaxChars,
        topK: vectorTopK,
        embeddingModel: vectorEmbeddingModel,
      }),
      summarization: Object.freeze({
        enabled: summarizationEnabled,
        budgetChars: summarizationBudget,
        chunkChars: summarizationChunkChars,
        provider: summarizationProvider,
      }),
      logging: Object.freeze({
        tokenUsageReportMode,
      }),
      pricing: Object.freeze({
        apiKey: process.env.OPENROUTER_PRICING_API_KEY || '',
        url: getDefaultedPricingUrl(),
        refreshIntervalSec: pricingRefreshSec,
        cachePath: pricingCachePath,
      }),
    });
}

let memoized;

function getMemoryConfig() {
  if (!memoized) {
    memoized = buildMemoryConfig();
  }
  return memoized;
}

function refreshMemoryConfig() {
  memoized = buildMemoryConfig();
  return memoized;
}

module.exports = {
  getMemoryConfig,
  refreshMemoryConfig,
};
