const {
  sanitizeGraphContext,
  sanitizeVectorChunks,
  condenseRagQuery,
  fetchGraphContext,
  calculateAdaptiveTimeout,
  mapReduceContext,
  ragCondenseContext,
  Tokenizer,
} = require('./helpers');
const { buildRagBlock, setDeferredContext } = require('~/server/services/RAG/RagContextManager');
const { sanitizeInput } = require('~/utils/security');
const { observeSegmentTokens, observeCache, setContextLength } = require('~/utils/ragMetrics');

const ragCache = new Map();
let ragCacheTtlMs = 0;

function pruneExpiredRagCache(now = Date.now()) {
  for (const [key, entry] of ragCache.entries()) {
    if (!entry?.expiresAt || entry.expiresAt <= now) {
      ragCache.delete(key);
    }
  }
}

function hashPayload(payload) {
  const crypto = require('crypto');
  const normalized =
    typeof payload === 'string'
      ? payload
      : JSON.stringify(
          payload ?? '',
          (_, value) => (typeof value === 'bigint' ? value.toString() : value),
        );

  return crypto.createHash('sha1').update(normalized ?? '').digest('hex');
}

function createCacheKey({ conversationId, endpoint, model, queryHash, configHash }) {
  return hashPayload({
    conversationId,
    endpoint,
    model,
    queryHash,
    configHash,
  });
}

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

async function buildContext({
  orderedMessages = [],
  systemContent = '',
  runtimeCfg = {},
  req,
  res,
  endpointOption = {},
  logger,
  encoding = 'o200k_base',
  ragCondense = ragCondenseContext,
}) {
  ragCacheTtlMs = Math.max(Number(runtimeCfg?.ragCacheTtl) * 1000, 0);
  const conversationId = req?.body?.conversationId || req?.conversationId;
  const userMessage = orderedMessages.slice(-1)[0];
  const userQuery = userMessage?.text ?? '';
  const multiStepEnabled = Boolean(runtimeCfg?.multiStepRag?.enabled);

  if (req) {
    setDeferredContext(req, null);
  }

  if (!runtimeCfg?.useConversationMemory || !conversationId || !userQuery) {
    logger?.debug?.('[rag.context.skip]', {
      conversationId,
      reason: 'disabled_or_empty_query',
      enableMemoryCache: runtimeCfg?.enableMemoryCache,
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
    logger?.debug?.(
      `[rag.context.limit] conversation=${conversationId} param=memory.ragQuery.maxChars limit=${queryMaxChars} original=${userQuery.length}`,
    );
  }

  const normalizedQuery = userQuery.slice(0, queryMaxChars);
  if (req) {
    req.ragUserQuery = normalizedQuery;
  }
  const queryTokenCount = Tokenizer?.getTokenCount
    ? Tokenizer.getTokenCount(normalizedQuery, encoding)
    : normalizedQuery.length;
  logger?.debug?.(
    `[rag.context.query.tokens] conversation=${conversationId} length=${normalizedQuery.length} tokens=${queryTokenCount}`,
  );

  const queryHash = hashPayload(normalizedQuery);
  const configHash = hashPayload({
    graph: runtimeCfg.graphContext,
    vector: runtimeCfg.vectorContext,
    summarization: runtimeCfg.summarization,
  });

  const cacheKey = createCacheKey({
    conversationId,
    endpoint: endpointOption?.endpoint || runtimeCfg?.endpoint || 'default',
    model: endpointOption?.model || runtimeCfg?.model || 'default',
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

  if (runtimeCfg?.enableMemoryCache) {
    const cached = ragCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      cacheStatus = 'hit';
      observeCache?.('hit');
      const cachedMetrics = cached.metrics || {};
      logger?.info?.(
        `[rag.context.cache.hit] conversation=${conversationId} cacheKey=${cacheKey} contextTokens=${cachedMetrics.contextTokens ?? 0} graphTokens=${cachedMetrics.graphTokens ?? 0} vectorTokens=${cachedMetrics.vectorTokens ?? 0} queryTokens=${cachedMetrics.queryTokens ?? 0}`,
      );
      if (req) {
        req.ragCacheStatus = cacheStatus;
        req.ragMetrics = Object.assign({}, req.ragMetrics, cachedMetrics);
        req.ragContextTokens = cachedMetrics.contextTokens;
      }
      return {
        patchedSystemContent: cached.systemContent,
        contextLength: cached.contextLength,
        cacheStatus,
        metrics: cachedMetrics,
      };
    }

    cacheStatus = 'miss';
    observeCache?.('miss');
    logger?.debug?.(
      `[rag.context.cache.miss] conversation=${conversationId} cacheKey=${cacheKey}`,
    );
  } else {
    logger?.debug?.('[rag.context.cache.skip]', {
      conversationId,
      cacheKey,
      reason: 'cache_disabled',
    });
  }

  const toolsGatewayUrl = runtimeCfg?.toolsGateway?.url || '';
  const toolsGatewayTimeout = runtimeCfg?.toolsGateway?.timeoutMs || 20000;
  const graphLimits = runtimeCfg?.graphContext || {};
  const vectorLimits = runtimeCfg?.vectorContext || {};

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
        logger,
      });

      rawGraphLinesCount = Array.isArray(graphContext?.lines) ? graphContext.lines.length : 0;

      if (graphContext?.lines?.length) {
        graphContextLines = sanitizeGraphContext(graphContext.lines, {
          maxLines: graphMaxLines,
          maxLineChars: graphMaxLineChars,
        });

        if (rawGraphLinesCount > graphContextLines.length && graphMaxLines) {
          logger?.debug?.(
            `[rag.context.limit] conversation=${conversationId} param=memory.graphContext.maxLines limit=${graphMaxLines} original=${rawGraphLinesCount}`,
          );
        }

        if (
          graphContextLines.some((line) => line.endsWith('…')) &&
          graphMaxLineChars
        ) {
          logger?.debug?.(
            `[rag.context.limit] conversation=${conversationId} param=memory.graphContext.maxLineChars limit=${graphMaxLineChars}`,
          );
        }
      }

      if (typeof graphContext?.queryHint === 'string') {
        const trimmedHint = graphContext.queryHint.trim();
        if (trimmedHint) {
          if (
            graphSummaryHintMaxChars &&
            trimmedHint.length > graphSummaryHintMaxChars
          ) {
            logger?.debug?.(
              `[rag.context.limit] conversation=${conversationId} param=memory.graphContext.summaryHintMaxChars limit=${graphSummaryHintMaxChars} original=${trimmedHint.length}`,
            );
          }
          graphQueryHint = trimmedHint.slice(
            0,
            graphSummaryHintMaxChars || trimmedHint.length,
          );
        }
      }
    } catch (error) {
      logger?.error?.('[rag.context.graph.error]', {
        conversationId,
        message: error?.message,
        stack: error?.stack,
      });
    }
  } else {
    logger?.debug?.('[rag.context.graph.skip]', {
      conversationId,
      reason: 'tools_gateway_missing',
    });
  }

  metrics.graphLines = graphContextLines.length;

  let ragSearchQuery = normalizedQuery;
  if (graphQueryHint) {
    ragSearchQuery = `${normalizedQuery}\n\nGraph hints: ${graphQueryHint}`;
  }

  const condensedQuery = condenseRagQuery(ragSearchQuery, queryMaxChars);
  if (condensedQuery.length < ragSearchQuery.length) {
    logger?.debug?.('[rag.context.query.condensed]', {
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

      logger?.debug?.(
        `[rag.context.vector.raw] conversation=${conversationId} rawResults=${rawVectorResults} sanitizedChunks=${vectorChunks.length} topK=${vectorTopK}`,
      );
    } catch (error) {
      logger?.error?.('[rag.context.vector.error]', {
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
            user_id: req?.user?.id,
          },
          { timeout: toolsGatewayTimeout },
        );

        const rawRecent = Array.isArray(recentResp?.data?.results)
          ? recentResp.data.results.map((r) => r?.content ?? '').filter(Boolean)
          : [];

        recentChunks = sanitizeVectorChunks(rawRecent, {
          maxChunks: recentTurns,
          maxChars: vectorMaxChars,
        });

        logger?.debug?.('[rag.context.recent]', {
          conversationId,
          recentTurns,
          got: recentChunks.length,
        });
      } catch (error) {
        const status = error?.response?.status;
        if (status === 404 || status === 501) {
          logger?.debug?.('[rag.context.recent.unavailable]', { conversationId, status });
        } else {
          logger?.warn?.('[rag.context.recent.skip]', {
            conversationId,
            reason: error?.message,
            status,
          });
        }
      }
    }

    const merged = [];
    const seen = new Set();

    for (const chunk of [...recentChunks, ...vectorChunks]) {
      const key = chunk.trim();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(chunk);
    }

    vectorChunks = merged.slice(0, vectorMaxChunks);

    if (rawVectorResults > vectorChunks.length && vectorMaxChunks) {
      logger?.debug?.(
        `[rag.context.limit] conversation=${conversationId} param=memory.vectorContext.maxChunks limit=${vectorMaxChunks} original=${rawVectorResults}`,
      );
    }

    if (vectorChunks.some((chunk) => chunk.endsWith('…')) && vectorMaxChars) {
      logger?.debug?.(
        `[rag.context.limit] conversation=${conversationId} param=memory.vectorContext.maxChars limit=${vectorMaxChars}`,
      );
    }
  } else {
    logger?.debug?.('[rag.context.vector.skip]', {
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
    logger?.debug?.(
      `[rag.context.tokens] conversation=${conversationId} graphTokens=0 vectorTokens=0 contextTokens=0`,
    );
  } else {
    const summarizationCfg = runtimeCfg?.summarization || {};
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
    const baseTimeoutMs =
      Number.isFinite(summarizationCfg?.timeoutMs) && summarizationCfg.timeoutMs > 0
        ? summarizationCfg.timeoutMs
        : defaults.timeoutMs;

    let vectorText = vectorChunks.join('\n\n');
    const rawVectorTextLength = vectorText.length;
    const shouldSummarize =
      !multiStepEnabled &&
      summarizationCfg.enabled !== false &&
      vectorText.length > budgetChars;

    if (shouldSummarize) {
      logger?.debug?.(
        `[rag.context.limit] conversation=${conversationId} param=memory.summarization.budgetChars limit=${budgetChars} original=${rawVectorTextLength}`,
      );
      try {
        const adaptiveTimeoutMs = calculateAdaptiveTimeout(rawVectorTextLength, baseTimeoutMs);

        logger?.debug?.('[rag.context.summarize.timeout]', {
          conversationId,
          contextLength: rawVectorTextLength,
          baseTimeoutMs,
          adaptiveTimeoutMs,
          configuredTimeout: summarizationCfg?.timeoutMs,
        });

        vectorText = await withTimeout(
          mapReduceContext({
            ragCondenseContext: ragCondense,
            logger,
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
          'RAG summarization timed out',
        );
      } catch (error) {
        logger?.error?.('[rag.context.vector.summarize.error]', {
          message: error?.message,
          stack: error?.stack,
          timeout: error?.message?.includes('timed out'),
          contextLength: rawVectorTextLength,
        });

        if (error?.message?.includes('timed out')) {
          const fallbackLength = Math.min(vectorText.length, budgetChars);
          vectorText = vectorText.slice(0, fallbackLength);
          logger?.warn?.(
            `[rag.context.vector.summarize.fallback] Using truncated text (${fallbackLength} chars) due to timeout`,
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
    } catch (error) {
      logger?.error?.('[rag.context.sanitize.error]', {
        message: error?.message,
        stack: error?.stack,
      });
    }

    finalSystemContent = sanitizedBlock + systemContent;
    contextLength = sanitizedBlock.length;

    if (hasGraph) {
      const graphText = graphContextLines.join('\n');
      metrics.graphTokens = graphText ? Tokenizer.getTokenCount(graphText, encoding) : 0;

      if (metrics.graphTokens) {
        observeSegmentTokens?.({
          segment: 'rag_graph',
          tokens: metrics.graphTokens,
          endpoint: endpointOption?.endpoint,
          model: endpointOption?.model,
        });
        setContextLength?.({
          segment: 'rag_graph',
          length: graphText.length,
          endpoint: endpointOption?.endpoint,
          model: endpointOption?.model,
        });
      }

      logger?.info?.(
        `[rag.context.graph.stats] conversation=${conversationId} lines=${graphContextLines.length} tokens=${metrics.graphTokens}`,
      );
    }

    if (vectorText.length) {
      metrics.vectorTokens = Tokenizer.getTokenCount(vectorText, encoding);

      if (metrics.vectorTokens) {
        observeSegmentTokens?.({
          segment: 'rag_vector',
          tokens: metrics.vectorTokens,
          endpoint: endpointOption?.endpoint,
          model: endpointOption?.model,
        });
        setContextLength?.({
          segment: 'rag_vector',
          length: vectorText.length,
          endpoint: endpointOption?.endpoint,
          model: endpointOption?.model,
        });
      }

      logger?.info?.(
        `[rag.context.vector.stats] conversation=${conversationId} chunks=${metrics.vectorChunks} tokens=${metrics.vectorTokens}`,
      );
    }

    metrics.contextTokens = sanitizedBlock
      ? Tokenizer.getTokenCount(sanitizedBlock, encoding)
      : metrics.graphTokens + metrics.vectorTokens;

    if (multiStepEnabled && req) {
      logger?.info?.('[rag.context.summarize.deferred]', {
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

    logger?.info?.(
      `[rag.context.tokens] conversation=${conversationId} graphTokens=${metrics.graphTokens} vectorTokens=${metrics.vectorTokens} contextTokens=${metrics.contextTokens}`,
    );
  }

  if (runtimeCfg?.enableMemoryCache) {
    ragCache.set(cacheKey, {
      systemContent: finalSystemContent,
      contextLength,
      metrics,
      expiresAt: now + ragCacheTtlMs,
    });
    logger?.debug?.(
      `[rag.context.cache.store] conversation=${conversationId} cacheKey=${cacheKey} contextTokens=${metrics.contextTokens} graphTokens=${metrics.graphTokens} vectorTokens=${metrics.vectorTokens} queryTokens=${metrics.queryTokens}`,
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

module.exports = {
  buildContext,
};
