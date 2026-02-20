const { logger } = require('@librechat/data-schemas');
const axios = require('axios');
const { Tokenizer } = require('@librechat/api');
const { sanitizeInput } = require('~/utils/security');
const {
  observeSegmentTokens,
  observeCache,
  setContextLength,
} = require('~/utils/ragMetrics');
const crypto = require('crypto');

/**
 * @typedef {Object} RagMetrics
 * @property {number} graphTokens
 * @property {number} vectorTokens
 * @property {number} contextTokens
 * @property {number} graphLines
 * @property {number} vectorChunks
 * @property {number} queryTokens
 */

/**
 * @typedef {Object} RagContextResult
 * @property {string} patchedSystemContent
 * @property {number} contextLength
 * @property {'hit'|'miss'|'skipped'} cacheStatus
 * @property {RagMetrics} metrics
 */

/**
 * RAG Context Builder - handles graph and vector context retrieval and caching
 */
class RagContextBuilder {
  constructor(options = {}) {
    this.cache = options.cache || new Map();
    this.cacheTtlMs = options.cacheTtlMs || 300000;
    this.mapReduceContext = options.mapReduceContext;
  }

  /**
   * Hashes payload for cache key generation
   * @param {unknown} payload
   * @returns {string}
   */
  hashPayload(payload) {
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
   * Creates cache key from parameters
   * @param {Object} params
   * @returns {string}
   */
  createCacheKey({ conversationId, endpoint, model, queryHash, configHash }) {
    return this.hashPayload({
      conversationId,
      endpoint,
      model,
      queryHash,
      configHash,
    });
  }

  /**
   * Prunes expired cache entries
   * @param {number} now
   */
  pruneExpiredCache(now = Date.now()) {
    for (const [key, entry] of this.cache.entries()) {
      if (!entry?.expiresAt || entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Sanitizes graph context lines
   * @param {string[]} lines
   * @param {Object} config
   * @returns {string[]}
   */
  sanitizeGraphContext(lines, config) {
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
   * Sanitizes vector chunks
   * @param {string[]} chunks
   * @param {Object} config
   * @returns {string[]}
   */
  sanitizeVectorChunks(chunks, config) {
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
   * Fetches graph context from tools-gateway
   * @param {Object} params
   * @returns {Promise<{lines: string[], queryHint: string}|null>}
   */
  async fetchGraphContext({ conversationId, toolsGatewayUrl, limit, timeoutMs }) {
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
      };

      logger.error('[DIAG-GRAPH] Failed to fetch graph context', serializedError);
      return null;
    }
  }

  /**
   * Fetches vector context from RAG API
   * @param {Object} params
   * @returns {Promise<string[]>}
   */
  async fetchVectorContext({
    conversationId,
    toolsGatewayUrl,
    ragSearchQuery,
    vectorTopK,
    embeddingModel,
    userId,
    timeoutMs,
  }) {
    try {
      const response = await axios.post(
        `${toolsGatewayUrl}/rag/search`,
        {
          query: ragSearchQuery,
          top_k: vectorTopK,
          embedding_model: embeddingModel,
          conversation_id: conversationId,
          user_id: userId,
        },
        { timeout: timeoutMs },
      );

      const rawChunks = Array.isArray(response?.data?.results)
        ? response.data.results.map((item) => item?.content ?? '').filter(Boolean)
        : [];

      return rawChunks;
    } catch (error) {
      logger.error('[rag.context.vector.error]', {
        conversationId,
        message: error?.message,
        stack: error?.stack,
      });
      return [];
    }
  }

  /**
   * Fetches recent turns from RAG API
   * @param {Object} params
   * @returns {Promise<string[]>}
   */
  async fetchRecentTurns({
    conversationId,
    toolsGatewayUrl,
    recentTurns,
    userId,
    timeoutMs,
  }) {
    try {
      const recentResp = await axios.post(
        `${toolsGatewayUrl}/rag/recent`,
        {
          conversation_id: conversationId,
          limit: recentTurns,
          user_id: userId,
        },
        { timeout: timeoutMs },
      );

      const rawRecent = Array.isArray(recentResp?.data?.results)
        ? recentResp.data.results.map((r) => r?.content ?? '').filter(Boolean)
        : [];

      return rawRecent;
    } catch (e) {
      const status = e?.response?.status;
      if (status === 404 || status === 501) {
        logger.info('[rag.context.recent.unavailable]', { conversationId, status });
      } else {
        logger.warn('[rag.context.recent.skip]', {
          conversationId,
          reason: e?.message,
          status,
        });
      }
      return [];
    }
  }

  /**
   * Builds RAG context with caching
   * @param {Object} params
   * @returns {Promise<RagContextResult>}
   */
  async buildContext({
    conversationId,
    userQuery,
    systemContent,
    runtimeCfg,
    req,
    res,
    endpointOption,
    encoding = 'o200k_base',
  }) {
    this.cacheTtlMs = Math.max(Number(runtimeCfg.ragCacheTtl) * 1000, 0);

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

    this.pruneExpiredCache();

    const queryMaxChars = runtimeCfg?.ragQuery?.maxChars || 6000;
    const normalizedQuery = userQuery.slice(0, queryMaxChars);
    const queryTokenCount = Tokenizer.getTokenCount(normalizedQuery, encoding);

    logger.info(
      `[rag.context.query.tokens] conversation=${conversationId} length=${normalizedQuery.length} tokens=${queryTokenCount}`,
    );

    const queryHash = this.hashPayload(normalizedQuery);
    const configHash = this.hashPayload({
      graph: runtimeCfg.graphContext,
      vector: runtimeCfg.vectorContext,
      summarization: runtimeCfg.summarization,
    });

    const cacheKey = this.createCacheKey({
      conversationId,
      endpoint: endpointOption?.endpoint,
      model: endpointOption?.model,
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

    const now = Date.now();
    let cacheStatus = 'skipped';

    if (runtimeCfg.enableMemoryCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        cacheStatus = 'hit';
        observeCache('hit');
        const cachedMetrics = cached.metrics || {};
        logger.info(
          `[rag.context.cache.hit] conversation=${conversationId} cacheKey=${cacheKey}`,
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
      logger.info(`[rag.context.cache.miss] conversation=${conversationId} cacheKey=${cacheKey}`);
    }

    const condenseCfg = runtimeCfg?.condense || {};
    const condenseEnabled = condenseCfg.enabled !== false;
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

    if (toolsGatewayUrl) {
      const graphContext = await this.fetchGraphContext({
        conversationId,
        toolsGatewayUrl,
        limit: graphMaxLines,
        timeoutMs: toolsGatewayTimeout,
      });

      if (graphContext?.lines?.length) {
        graphContextLines = this.sanitizeGraphContext(graphContext.lines, {
          maxLines: graphMaxLines,
          maxLineChars: graphMaxLineChars,
        });
      }

      if (typeof graphContext?.queryHint === 'string') {
        const trimmedHint = graphContext.queryHint.trim();
        if (trimmedHint) {
          graphQueryHint = trimmedHint.slice(0, graphSummaryHintMaxChars || trimmedHint.length);
        }
      }
    }

    metrics.graphLines = graphContextLines.length;

    let ragSearchQuery = normalizedQuery;
    if (graphQueryHint) {
      ragSearchQuery = `${normalizedQuery}\n\nGraph hints: ${graphQueryHint}`;
    }

    const condensedQuery = this.condenseRagQuery(ragSearchQuery, queryMaxChars);
    ragSearchQuery = condensedQuery;

    let vectorChunks = [];

    if (toolsGatewayUrl) {
      const rawChunks = await this.fetchVectorContext({
        conversationId,
        toolsGatewayUrl,
        ragSearchQuery,
        vectorTopK,
        embeddingModel,
        userId: req?.user?.id,
        timeoutMs: toolsGatewayTimeout,
      });

      vectorChunks = this.sanitizeVectorChunks(rawChunks, {
        maxChunks: vectorMaxChunks,
        maxChars: vectorMaxChars,
      });

      if (recentTurns > 0) {
        const rawRecent = await this.fetchRecentTurns({
          conversationId,
          toolsGatewayUrl,
          recentTurns,
          userId: req?.user?.id,
          timeoutMs: toolsGatewayTimeout,
        });

        const recentChunks = this.sanitizeVectorChunks(rawRecent, {
          maxChunks: recentTurns,
          maxChars: vectorMaxChars,
        });

        const merged = [];
        const seen = new Set();

        for (const c of [...recentChunks, ...vectorChunks]) {
          const key = c.trim();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          merged.push(c);
        }

        vectorChunks = merged.slice(0, vectorMaxChunks);
      }
    }

    metrics.vectorChunks = vectorChunks.length;

    const hasGraph = graphContextLines.length > 0;
    const policyIntro =
      'Ниже предоставлен внутренний контекст для твоего сведения: граф знаний и выдержки из беседы. ' +
      'Используй эти данные для формирования точного и полного ответа. ' +
      'Категорически запрещается цитировать или пересказывать этот контекст, особенно строки, содержащие "-->". ' +
      'Эта информация предназначена только для твоего внутреннего анализа.\n\n';

    let finalSystemContent = systemContent;
    let contextLength = 0;

    if (hasGraph || vectorChunks.length > 0) {
      const summarizationCfg = runtimeCfg.summarization || {};
      const summarizationEnabled = summarizationCfg.enabled !== false;
      const budgetChars = Number.isFinite(summarizationCfg?.budgetChars)
        ? summarizationCfg.budgetChars
        : 12000;

      let vectorText = vectorChunks.join('\n\n');
      const shouldSummarize =
        summarizationCfg.enabled !== false && vectorText.length > budgetChars;

      if (shouldSummarize && this.mapReduceContext) {
        try {
          vectorText = await this.mapReduceContext({
            req,
            res,
            endpointOption,
            contextText: vectorText,
            userQuery: normalizedQuery,
            graphContext: hasGraph
              ? { lines: graphContextLines, queryHint: graphQueryHint }
              : null,
            summarizationConfig: summarizationCfg,
          });
        } catch (error) {
          logger.error('[rag.context.vector.summarize.error]', {
            message: error?.message,
          });
        }
      }

      const graphBlock = hasGraph
        ? `### Graph context\n${graphContextLines.join('\n')}\n\n`
        : '';
      const vectorBlock = vectorText.length ? `### Vector context\n${vectorText}\n\n` : '';
      const combined = `${policyIntro}${graphBlock}${vectorBlock}---\n\n`;

      let sanitizedBlock = combined;
      try {
        sanitizedBlock = sanitizeInput(combined);
      } catch (error) {
        logger.error('[rag.context.sanitize.error]', { message: error?.message });
      }

      finalSystemContent = sanitizedBlock + systemContent;
      contextLength = sanitizedBlock.length;

      if (hasGraph) {
        const graphText = graphContextLines.join('\n');
        metrics.graphTokens = Tokenizer.getTokenCount(graphText, encoding);

        if (metrics.graphTokens) {
          observeSegmentTokens({
            segment: 'rag_graph',
            tokens: metrics.graphTokens,
            endpoint: endpointOption?.endpoint,
            model: endpointOption?.model,
          });
          setContextLength({
            segment: 'rag_graph',
            length: graphText.length,
            endpoint: endpointOption?.endpoint,
            model: endpointOption?.model,
          });
        }
      }

      if (vectorBlock) {
        metrics.vectorTokens = Tokenizer.getTokenCount(vectorText, encoding);

        if (metrics.vectorTokens) {
          observeSegmentTokens({
            segment: 'rag_vector',
            tokens: metrics.vectorTokens,
            endpoint: endpointOption?.endpoint,
            model: endpointOption?.model,
          });
        }
      }

      metrics.contextTokens = Tokenizer.getTokenCount(sanitizedBlock, encoding);
    }

    if (runtimeCfg.enableMemoryCache) {
      this.cache.set(cacheKey, {
        systemContent: finalSystemContent,
        contextLength,
        metrics,
        expiresAt: now + this.cacheTtlMs,
      });
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

  /**
   * Condenses RAG query text
   * @param {string} text
   * @param {number} limit
   * @returns {string}
   */
  condenseRagQuery(text, limit = 6000) {
    if (!text) return '';

    const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!normalized) return '';

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
    if (condensed.length <= limit) return condensed;

    const half = Math.max(1, Math.floor(limit / 2));
    const head = condensed.slice(0, half);
    const tail = condensed.slice(-half);
    return `${head}\n...\n${tail}`;
  }
}

module.exports = RagContextBuilder;
