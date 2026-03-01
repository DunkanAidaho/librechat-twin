const axios = require('axios');
const { Tokenizer } = require('@librechat/api');
const { condenseContext: ragCondenseContext } = require('~/server/services/RAG/condense');

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

function condenseRagQuery(text, limit) {
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

async function fetchGraphContext({
  conversationId,
  toolsGatewayUrl,
  limit,
  timeoutMs,
  entity = null,
  relationHints = [],
  passIndex = null,
  signal = null,
  logger,
  axiosInstance = axios,
}) {
  if (!conversationId || !toolsGatewayUrl) {
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

  logger?.debug?.('[rag.graph] Fetching graph context', {
    conversationId,
    toolsGatewayUrl,
    limit,
  });

  try {
    const response = await axiosInstance.post(url, requestPayload, {
      timeout: timeoutMs,
      signal,
    });

    const lines = Array.isArray(response?.data?.lines) ? response.data.lines : [];
    const queryHint = response?.data?.query_hint ? String(response.data.query_hint) : '';

    logger?.debug?.('[rag.graph] Graph context response', {
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

    logger?.error?.('[rag.graph] Failed to fetch graph context', serializedError);

    try {
      if (typeof error?.toJSON === 'function') {
        logger?.error?.('[rag.graph] Axios error JSON', error.toJSON());
      }
    } catch (jsonErr) {
      logger?.warn?.('[rag.graph] Failed to serialize axios error', {
        message: jsonErr?.message,
        stack: jsonErr?.stack,
      });
    }

    return null;
  }
}

function calculateAdaptiveTimeout(contextLength, baseTimeoutMs) {
  const BASE_CONTEXT_SIZE = 50000;

  if (contextLength <= BASE_CONTEXT_SIZE) {
    return baseTimeoutMs;
  }

  const extraChunks = Math.ceil((contextLength - BASE_CONTEXT_SIZE) / BASE_CONTEXT_SIZE);
  const additionalTimeout = extraChunks * 20000;

  const MAX_TIMEOUT = 300000;
  const adaptiveTimeout = Math.min(baseTimeoutMs + additionalTimeout, MAX_TIMEOUT);

  return adaptiveTimeout;
}

async function mapReduceContext({
  ragCondenseContext,
  logger,
  req,
  res,
  endpointOption,
  contextText,
  userQuery,
  graphContext = null,
  summarizationConfig = {},
}) {
  if (typeof ragCondenseContext !== 'function') {
    throw new Error('ragCondenseContext is required');
  }

  const defaults = {
    budgetChars: 50000,
    chunkChars: 30000,
    timeoutMs: 125000,
  };

  const budgetChars = Number.isFinite(summarizationConfig.budgetChars) && summarizationConfig.budgetChars > 0
    ? summarizationConfig.budgetChars
    : defaults.budgetChars;
  const chunkChars = Number.isFinite(summarizationConfig.chunkChars) && summarizationConfig.chunkChars > 0
    ? summarizationConfig.chunkChars
    : defaults.chunkChars;
  const provider = summarizationConfig.provider && typeof summarizationConfig.provider === 'string'
    ? summarizationConfig.provider
    : undefined;
  const baseTimeout = Number.isFinite(summarizationConfig.timeoutMs) && summarizationConfig.timeoutMs > 0
    ? summarizationConfig.timeoutMs
    : defaults.timeoutMs;
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

    logger?.info?.('[rag.context.summarize.complete]', {
      initialLength: contextText.length,
      finalLength: finalContext.length,
      budgetChars,
      chunkChars,
      provider,
      timeoutMs: adaptiveTimeout,
    });

    return finalContext;
  } catch (error) {
    logger?.error?.('[rag.context.summarize.error]', {
      message: error?.message,
      stack: error?.stack,
      contextLength: contextText.length,
      timeoutMs: adaptiveTimeout,
    });

    return contextText;
  }
}

module.exports = {
  sanitizeGraphContext,
  sanitizeVectorChunks,
  condenseRagQuery,
  fetchGraphContext,
  calculateAdaptiveTimeout,
  mapReduceContext,
  ragCondenseContext,
  Tokenizer,
};
