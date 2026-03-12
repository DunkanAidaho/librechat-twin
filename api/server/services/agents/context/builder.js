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
const {
  resolveSummarizationConfig,
  buildSummarizationSnapshot,
} = require('./summarization');
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
  const rawIntentEntities = Array.isArray(req?.intentAnalysis?.entities)
    ? req.intentAnalysis.entities
    : [];
  const intentEntities = rawIntentEntities
    .map((entity) => entity?.name ?? entity)
    .filter(Boolean)
    .slice(0, runtimeCfg?.multiStepRag?.maxEntities || 3);
  const temporalRange = req?.intentAnalysis?.temporalRange;
  const temporalHint = temporalRange?.from && temporalRange?.to
    ? `период ${temporalRange.from}-${temporalRange.to}`
    : '';
  const intentHints = rawIntentEntities
    .flatMap((entity) => (Array.isArray(entity?.hints) ? entity.hints : []))
    .filter(Boolean);
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
        ragBlock: cached.systemContent,
        contextLength: cached.contextLength,
        cacheStatus,
        metrics: cachedMetrics,
        vectorChunks: cached.vectorChunks || [],
        vectorText: cached.vectorText || '',
        originalVectorText: cached.originalVectorText || '',
        originalContextLength: cached.originalContextLength || cached.contextLength || 0,
        graphLines: cached.graphLines || [],
        policyIntro: cached.policyIntro || POLICY_INTRO,
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
  let conversationSummary = '';

  metrics.graphLines = graphContextLines.length;
  const temporalRewriteEnabled = Boolean(temporalRange?.from && temporalRange?.to);
  const filteredTemporalEntities = rawIntentEntities
    .filter((entity) => !['temporal_range', 'date', 'period'].includes(entity?.type))
    .map((entity) => entity?.name ?? entity)
    .filter(Boolean);
  const contentQuerySource = filteredTemporalEntities.length
    ? filteredTemporalEntities
    : intentEntities.length
      ? intentEntities
      : ['события'];
  const contentQuery = temporalRewriteEnabled
    ? `${contentQuerySource.join(' ')} ${temporalRange.from} ${temporalRange.to}`.trim()
    : normalizedQuery;
  const baseQuery = temporalRewriteEnabled ? contentQuery : normalizedQuery;
  let ragSearchQuery = baseQuery;
  logger?.debug?.('[rag.context.query.rewrite]', {
    conversationId,
    queryRewritten: temporalRewriteEnabled,
    contentQuery,
  });
  if (intentEntities.length || temporalHint) {
    const hints = intentHints.length ? ` (hints: ${[...new Set(intentHints)].join(', ')})` : '';
    const temporalLine = temporalHint ? `\nTemporal: ${temporalHint}` : '';
    ragSearchQuery = `${baseQuery}\n\nEntities: ${intentEntities.join(', ')}${hints}${temporalLine}`;
    logger?.debug?.('[rag.context.intent.entities]', {
      conversationId,
      entities: intentEntities,
      hints: [...new Set(intentHints)],
      temporalRange: temporalRange ? { from: temporalRange.from, to: temporalRange.to } : null,
      queryRewritten: temporalRewriteEnabled,
    });
  }
  if (graphQueryHint) {
    ragSearchQuery = `${baseQuery}\n\nGraph hints: ${graphQueryHint}`;
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

  const summarizationConfig = resolveSummarizationConfig({
    summarizationCfg: runtimeCfg?.summarization || {},
    ragBudgetTokens,
  });

  logger?.debug?.('[rag.context.summarization.config]', {
    conversationId,
    baseBudgetChars: summarizationConfig.baseBudgetChars,
    baseChunkChars: summarizationConfig.baseChunkChars,
    baseTimeoutMs: summarizationConfig.baseTimeoutMs,
    dynamicBudgetChars: summarizationConfig.dynamicBudgetChars,
    dynamicChunkChars: summarizationConfig.dynamicChunkChars,
    provider: summarizationConfig.provider,
    enabled: summarizationConfig.enabled,
  });

  let vectorChunks = [];
  let recentChunks = [];
  let rawVectorResults = 0;

  if (toolsGatewayUrl) {
    try {
      const vectorTopKForSeeds = Math.min(vectorTopK, Math.max(1, Math.ceil(vectorTopK / 2)));
      const seedPayload = {
        query: ragSearchQuery,
        top_k: vectorTopKForSeeds,
        embedding_model: embeddingModel,
        conversation_id: conversationId,
        user_id: req?.user?.id || req?.user?._id,
        ...(temporalRange?.from && temporalRange?.to
          ? {
              date_filter: {
                from: temporalRange.from,
                to: temporalRange.to,
              },
            }
          : {}),
        include_graph: true,
      };
      logger?.info?.('[rag.context.vector.search.payload]', {
        conversation_id: seedPayload.conversation_id,
        user_id: seedPayload.user_id,
        top_k: seedPayload.top_k,
        embedding_model: seedPayload.embedding_model,
        include_graph: seedPayload.include_graph,
        include_user: seedPayload.include_user,
        date_filter: seedPayload.date_filter,
        payloadBytes: Buffer.byteLength(JSON.stringify(seedPayload || {}), 'utf8'),
        phase: 'seed',
      });
      if (temporalRange?.from && temporalRange?.to) {
        logger?.debug?.('[rag.context.vector.date_filter]', {
          conversationId,
          date_filter: seedPayload.date_filter,
        });
      }
      const response = await axios.post(
        `${toolsGatewayUrl}/rag/search`,
        seedPayload,
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
        user_id: req?.user?.id || req?.user?._id,
        include_user: Boolean(req?.ragIncludeUserMessages),
        ...(temporalRange?.from && temporalRange?.to
          ? {
              date_filter: {
                from: temporalRange.from,
                to: temporalRange.to,
              },
            }
          : {}),
        include_graph: true,
      };
      logger?.info?.('[rag.context.vector.search.payload]', {
        conversation_id: searchPayload.conversation_id,
        user_id: searchPayload.user_id,
        top_k: searchPayload.top_k,
        embedding_model: searchPayload.embedding_model,
        include_graph: searchPayload.include_graph,
        include_user: searchPayload.include_user,
        date_filter: searchPayload.date_filter,
        payloadBytes: Buffer.byteLength(JSON.stringify(searchPayload || {}), 'utf8'),
        phase: 'final',
      });
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

      const finalResults = Array.isArray(finalResponse?.data?.results)
        ? finalResponse.data.results.filter(Boolean)
        : [];

      const finalContents = finalResults
        .map((item) => item?.content ?? '')
        .filter(Boolean);

      const graphContext = finalResponse?.data?.graph_context;
      if (graphContext) {
        if (graphContext.summary) {
          conversationSummary = graphContext.summary;
          logger?.info?.('[rag.context.graph.summary]', {
            conversationId,
            summaryLength: conversationSummary.length,
          });
        }
        if (Array.isArray(graphContext.lines) && graphContext.lines.length > 0) {
          const sanitizedLines = sanitizeGraphContext(graphContext.lines, {
            maxLines: graphMaxLines,
            maxLineChars: graphMaxLineChars,
          });
          graphContextLines.push(...sanitizedLines);
          rawGraphLinesCount += graphContext.lines.length;
          logger?.info?.('[rag.context.graph.lines_from_search]', {
            conversationId,
            linesCount: sanitizedLines.length,
          });
        }
      }

      logger?.debug?.('[rag.context.vector.search.results]', {
        conversationId,
        count: finalResults.length,
        contentsLength: finalContents.join('\n').length,
        firstResultSnippet: finalContents[0]?.slice(0, 100),
      });

      vectorChunks = sanitizeVectorChunks(finalContents, {
        maxChunks: vectorMaxChunks,
        maxChars: vectorMaxChars,
      });

      // Note: Redundant local date filtering removed.
      // We trust tools-gateway/rag/search date_filter results.
      // This prevents dropping relevant chunks due to JS-side date parsing mismatches.
      logger?.info?.('[rag.context.vector.date_filter.skipped]', {
        conversationId,
        resultCount: finalResults.length,
        hasTemporalRange: Boolean(temporalRange?.from && temporalRange?.to),
      });

      logger?.debug?.(
        `[rag.context.vector.raw] conversation=${conversationId} rawResults=${finalContents.length} sanitizedChunks=${vectorChunks.length} topK=${finalTopK}`,
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
          user_id: req?.user?.id || req?.user?._id,
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

  if (toolsGatewayUrl && graphContextLines.length === 0) {
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
  } else if (graphContextLines.length > 0) {
    logger?.info?.('[rag.context.graph.skip_fetch]', {
      conversationId,
      reason: 'already_have_lines_from_search',
      linesCount: graphContextLines.length,
    });
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
      summary: conversationSummary,
    };
  }

  const hasGraph = graphContextLines.length > 0;
  const hasVector = vectorChunks.length > 0;
  let policyIntro =
    'Ниже предоставлен внутренний контекст для твоего сведения: граф знаний и выдержки из беседы. ' +
    'Используй эти данные для формирования точного и полного ответа.\n\n';

  if (conversationSummary) {
    policyIntro = `Краткое содержание беседы: ${conversationSummary}\n\n${policyIntro}`;
  }

  let vectorText = '';
  let rawVectorTextLength = 0;
  let sanitizedBlock = '';
  let safeVectorText = '';

  const budgetChars = summarizationConfig.baseBudgetChars;
  const chunkChars = summarizationConfig.baseChunkChars;
  const baseTimeoutMs = summarizationConfig.baseTimeoutMs;
  const dynamicBudgetChars = summarizationConfig.dynamicBudgetChars;
  const dynamicChunkChars = summarizationConfig.dynamicChunkChars;

  if (!hasGraph && !hasVector) {
    logger?.debug?.(
      `[rag.context.tokens] conversation=${conversationId} graphTokens=0 vectorTokens=0 contextTokens=0`,
    );
  } else {

    vectorText = vectorChunks.join('\n\n');
    rawVectorTextLength = vectorText.length;
    const shouldSummarize =
      !multiStepEnabled &&
      summarizationConfig.enabled &&
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
              provider: summarizationConfig.provider,
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

    sanitizedBlock = ragBlock;

    contextLength = sanitizedBlock.length;
  }

  safeVectorText = typeof vectorText === 'string' ? vectorText : '';
  logger?.debug?.('[rag.context.safeVector]', {
    conversationId,
    hasGraph,
    hasVector,
    vectorInitialized: typeof vectorText === 'string',
    vectorLength: safeVectorText.length,
  });

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

  if (safeVectorText.length) {
    metrics.vectorTokens = Tokenizer.getTokenCount(safeVectorText, encoding);

    if (metrics.vectorTokens) {
      observeSegmentTokens?.({
        segment: 'rag_vector',
        tokens: metrics.vectorTokens,
        endpoint: endpointOption?.endpoint,
        model: endpointOption?.model,
      });
      setContextLength?.({
        segment: 'rag_vector',
        length: safeVectorText.length,
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
    if (hasGraph || hasVector) {
      logger?.info?.('[rag.context.summarize.deferred]', {
        conversationId,
        graphLines: graphContextLines.length,
        vectorChunks: vectorChunks.length,
      });
      setDeferredContext(req, {
        policyIntro,
        graphLines: graphContextLines,
        graphQueryHint,
        vectorText: safeVectorText,
        vectorChunks,
        summarizationConfig: buildSummarizationSnapshot(summarizationConfig),
        metrics: {
          graphTokens: metrics.graphTokens,
          vectorTokens: metrics.vectorTokens,
          contextTokens: metrics.contextTokens,
        },
      });
    } else {
      logger?.debug?.('[rag.context.summarize.deferred_skipped]', {
        conversationId,
        multiStepEnabled,
        reason: 'no_graph_or_vector_context',
      });
    }
  }

  logger?.info?.(
    `[rag.context.tokens] conversation=${conversationId} graphTokens=${metrics.graphTokens} vectorTokens=${metrics.vectorTokens} contextTokens=${metrics.contextTokens}`,
  );

  if (runtimeCfg?.enableMemoryCache) {
      ragCache.set(cacheKey, {
        systemContent: sanitizedBlock,
        contextLength,
        metrics,
        vectorChunks,
        vectorText,
        originalVectorText: rawVectorTextLength > 0 ? vectorChunks.join('\n\n') : '',
        originalContextLength: rawVectorTextLength,
        graphLines: graphContextLines,
        policyIntro,
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
    req.ragContextSnapshot = {
      vectorChunks,
      vectorText: safeVectorText,
      originalVectorText: rawVectorTextLength > 0 ? vectorChunks.join('\n\n') : '',
      originalContextLength: rawVectorTextLength,
      graphLines: graphContextLines,
      policyIntro,
    };
  }

  return {
    ragBlock: sanitizedBlock,
    contextLength,
    cacheStatus,
    metrics,
    vectorChunks,
    vectorText,
    originalVectorText: rawVectorTextLength > 0 ? vectorChunks.join('\n\n') : '',
    originalContextLength: rawVectorTextLength,
    graphLines: graphContextLines,
    policyIntro,
  };
}

module.exports = {
  buildContext,
};
