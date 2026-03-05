const axios = require('axios');
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
const { extractEntitiesFromText } = require('~/server/services/RAG/intentAnalyzer');
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
  ragBudgetTokens,
  graphBudgetTokens,
  vectorBudgetTokens,
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
    req.ragCondenseQuery = multiStepEnabled ? '' : normalizedQuery;
  }
  const intentEntities = Array.isArray(req?.intentAnalysis?.entities)
    ? req.intentAnalysis.entities
        .map((entity) => entity?.name)
        .filter(Boolean)
        .slice(0, runtimeCfg?.multiStepRag?.maxEntities || 3)
    : [];
  const intentHints = Array.isArray(req?.intentAnalysis?.entities)
    ? req.intentAnalysis.entities
        .flatMap((entity) => (Array.isArray(entity?.hints) ? entity.hints : []))
        .filter(Boolean)
    : [];
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

  let graphMaxLines = Number(graphLimits.maxLines ?? 40);
  const graphMaxLineChars = Number(graphLimits.maxLineChars ?? 200);
  const graphSummaryHintMaxChars = Number(graphLimits.summaryHintMaxChars ?? 2000);

  let vectorMaxChunks = Number(vectorLimits.maxChunks ?? 4);
  const vectorMaxChars = Number(vectorLimits.maxChars ?? 70000);
  let vectorTopK = Number(vectorLimits.topK ?? 12);
  const embeddingModel = vectorLimits.embeddingModel;
  const recentTurns = Number(vectorLimits.recentTurns ?? 6);

  if (Number.isFinite(graphBudgetTokens) && graphBudgetTokens > 0) {
    const avgTokensPerLine = Number(graphLimits.avgTokensPerLine ?? 24);
    const budgetMaxLines = Math.max(1, Math.floor(graphBudgetTokens / avgTokensPerLine));
    if (budgetMaxLines < graphMaxLines) {
      logger?.info?.('[rag.context.budget.graph]', {
        conversationId,
        graphBudgetTokens,
        avgTokensPerLine,
        maxLines: graphMaxLines,
        adjustedMaxLines: budgetMaxLines,
      });
      graphMaxLines = budgetMaxLines;
    }
  }

  if (Number.isFinite(vectorBudgetTokens) && vectorBudgetTokens > 0) {
    const avgTokensPerChunk = Number(vectorLimits.avgTokensPerChunk ?? 220);
    const budgetMaxChunks = Math.max(1, Math.floor(vectorBudgetTokens / avgTokensPerChunk));
    if (budgetMaxChunks < vectorMaxChunks) {
      logger?.info?.('[rag.context.budget.vector]', {
        conversationId,
        vectorBudgetTokens,
        avgTokensPerChunk,
        maxChunks: vectorMaxChunks,
        adjustedMaxChunks: budgetMaxChunks,
      });
      vectorMaxChunks = budgetMaxChunks;
    }

    if (vectorTopK > vectorMaxChunks) {
      vectorTopK = vectorMaxChunks;
    }
  }

  let graphContextLines = [];
  let graphQueryHint = '';
  let rawGraphLinesCount = 0;

  metrics.graphLines = graphContextLines.length;
  let ragSearchQuery = normalizedQuery;
  if (intentEntities.length) {
    const hints = intentHints.length ? ` (hints: ${[...new Set(intentHints)].join(', ')})` : '';
    ragSearchQuery = `${normalizedQuery}\n\nEntities: ${intentEntities.join(', ')}${hints}`;
    logger?.debug?.('[rag.context.intent.entities]', {
      conversationId,
      entities: intentEntities,
      hints: [...new Set(intentHints)],
    });
  }
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
      const vectorTopKForSeeds = Math.min(vectorTopK, Math.max(1, Math.ceil(vectorTopK / 2)));
      const response = await axios.post(
        `${toolsGatewayUrl}/rag/search`,
        {
          query: ragSearchQuery,
          top_k: vectorTopKForSeeds,
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

      const entityCandidates = extractEntitiesFromText(
        rawChunks.join('\n\n'),
        runtimeCfg?.multiStepRag?.maxEntities || 3,
      );

      if (entityCandidates.length && !intentEntities.length) {
        if (req) {
          req.ragSeedEntities = entityCandidates;
        }
        logger?.info?.('[rag.context.vector.entities]', {
          conversationId,
          entities: entityCandidates,
          source: 'vector_seed',
        });
      }

      const useQuery = intentEntities.length
        ? ragSearchQuery
        : entityCandidates.length
          ? `${normalizedQuery}\n\nEntities: ${entityCandidates.join(', ')}`
          : ragSearchQuery;

      if (useQuery !== ragSearchQuery) {
        const updated = condenseRagQuery(useQuery, queryMaxChars);
        ragSearchQuery = updated;
        logger?.debug?.('[rag.context.query.condensed]', {
          conversationId,
          originalLength: useQuery.length,
          condensedLength: updated.length,
          reason: 'vector_seed_entities',
        });
      }

      const finalTopK = vectorTopK;
      const searchPayload = {
        query: ragSearchQuery,
        top_k: finalTopK,
        embedding_model: embeddingModel,
        conversation_id: conversationId,
        user_id: req?.user?.id,
      };
      const searchStart = Date.now();
      const finalResponse = await axios.post(
        `${toolsGatewayUrl}/rag/search`,
        searchPayload,
        { timeout: toolsGatewayTimeout },
      );
      logger?.info?.('[rag.context.vector.search.ok]', {
        conversationId,
        durationMs: Date.now() - searchStart,
        timeoutMs: toolsGatewayTimeout,
        queryLength: ragSearchQuery?.length ?? 0,
        payloadBytes: Buffer.byteLength(JSON.stringify(searchPayload || {}), 'utf8'),
        resultCount: Array.isArray(finalResponse?.data?.results)
          ? finalResponse.data.results.length
          : 0,
      });

      const finalChunks = Array.isArray(finalResponse?.data?.results)
        ? finalResponse.data.results.map((item) => item?.content ?? '').filter(Boolean)
        : [];

      vectorChunks = sanitizeVectorChunks(finalChunks, {
        maxChunks: vectorMaxChunks,
        maxChars: vectorMaxChars,
      });

      logger?.debug?.(
        `[rag.context.vector.raw] conversation=${conversationId} rawResults=${finalChunks.length} sanitizedChunks=${vectorChunks.length} topK=${finalTopK}`,
      );
    } catch (error) {
      logger?.error?.('[rag.context.vector.error]', {
        conversationId,
        message: error?.message,
        stack: error?.stack,
        code: error?.code,
        status: error?.response?.status,
        timeoutMs: toolsGatewayTimeout,
        url: `${toolsGatewayUrl}/rag/search`,
      });
    }

    if (!intentEntities.length && req?.ragSeedEntities?.length) {
      intentEntities.push(...req.ragSeedEntities);
    }

    if (recentTurns > 0) {
      try {
        const recentPayload = {
          conversation_id: conversationId,
          limit: recentTurns,
          user_id: req?.user?.id,
        };
        const recentStart = Date.now();
        const recentResp = await axios.post(
          `${toolsGatewayUrl}/rag/recent`,
          recentPayload,
          { timeout: toolsGatewayTimeout },
        );
        logger?.info?.('[rag.context.recent.ok]', {
          conversationId,
          durationMs: Date.now() - recentStart,
          timeoutMs: toolsGatewayTimeout,
          payloadBytes: Buffer.byteLength(JSON.stringify(recentPayload || {}), 'utf8'),
          resultCount: Array.isArray(recentResp?.data?.results)
            ? recentResp.data.results.length
            : 0,
        });

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

  if (toolsGatewayUrl) {
    try {
      const graphEntities = intentEntities.length
        ? intentEntities
        : req?.ragSeedEntities?.length
          ? req.ragSeedEntities
          : [];

      if (graphEntities.length) {
        const graphResults = await Promise.all(
          graphEntities.map((entity) =>
            fetchGraphContext({
              conversationId,
              toolsGatewayUrl,
              limit: graphMaxLines,
              timeoutMs: toolsGatewayTimeout,
              entity: { name: entity },
              logger,
            }),
          ),
        );

        const lines = graphResults
          .flatMap((result) => (Array.isArray(result?.lines) ? result.lines : []))
          .filter(Boolean);
        rawGraphLinesCount = lines.length;

        if (lines.length) {
          graphContextLines = sanitizeGraphContext(lines, {
            maxLines: graphMaxLines,
            maxLineChars: graphMaxLineChars,
          });

          if (rawGraphLinesCount > graphContextLines.length && graphMaxLines) {
            logger?.debug?.(
              `[rag.context.limit] conversation=${conversationId} param=memory.graphContext.maxLines limit=${graphMaxLines} original=${rawGraphLinesCount}`,
            );
          }
        }

        const firstHint = graphResults.find((result) => typeof result?.queryHint === 'string');
        if (firstHint?.queryHint) {
          const trimmedHint = String(firstHint.queryHint).trim();
          if (trimmedHint) {
            if (graphSummaryHintMaxChars && trimmedHint.length > graphSummaryHintMaxChars) {
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

  if (req) {
    req.graphContext = {
      lines: graphContextLines,
      queryHint: graphQueryHint,
    };
  }

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
    const dynamicBudgetChars = Number.isFinite(ragBudgetTokens)
      ? Math.max(Math.floor(ragBudgetTokens * 4 * 0.35), 2000)
      : budgetChars;
    const dynamicChunkChars = Number.isFinite(ragBudgetTokens)
      ? Math.max(Math.floor(ragBudgetTokens * 4 * 0.2), 2000)
      : chunkChars;
    const baseTimeoutMs =
      Number.isFinite(summarizationCfg?.timeoutMs) && summarizationCfg.timeoutMs > 0
        ? summarizationCfg.timeoutMs
        : defaults.timeoutMs;

    let vectorText = vectorChunks.join('\n\n');
    const rawVectorTextLength = vectorText.length;
    const shouldSummarize =
      !multiStepEnabled &&
      summarizationCfg.enabled !== false &&
      vectorText.length > dynamicBudgetChars;

    if (shouldSummarize) {
      logger?.debug?.(
        `[rag.context.limit] conversation=${conversationId} param=memory.summarization.budgetChars limit=${dynamicBudgetChars} original=${rawVectorTextLength}`,
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
              budgetChars: dynamicBudgetChars,
              chunkChars: dynamicChunkChars,
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
      maxChars: Number.isFinite(ragBudgetTokens)
        ? Math.max(Math.floor(ragBudgetTokens * 4), 2000)
        : null,
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

  if (Number.isFinite(ragBudgetTokens) && ragBudgetTokens > 0) {
    if (metrics.contextTokens > ragBudgetTokens) {
      logger?.info?.('[rag.context.budget_exceeded]', {
        conversationId,
        contextTokens: metrics.contextTokens,
        ragBudgetTokens,
        graphTokens: metrics.graphTokens,
        vectorTokens: metrics.vectorTokens,
      });
    }
  }

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
