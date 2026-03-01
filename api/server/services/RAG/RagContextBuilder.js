const BaseService = require('../Base/BaseService');
const { ValidationError } = require('../Base/ErrorHandler');
const { buildRagBlock, replaceRagBlock } = require('./RagContextManager');
const { analyzeIntent } = require('./intentAnalyzer');
const { runMultiStepRag } = require('./multiStepOrchestrator');
const { fetchGraphContext } = require('./graphContext');

/**
 * Сервис для построения RAG контекста
 */
class RagContextBuilder extends BaseService {
  /**
   * @param {Object} options
   * @param {TokenManager} options.tokenManager - Менеджер токенов
   * @param {RagCache} options.ragCache - Кэш RAG
   * @param {MetricsCollector} options.metrics - Сборщик метрик
   */
  constructor(options = {}) {
    super({ serviceName: 'rag.context', ...options });

    if (!options.tokenManager) {
      throw new ValidationError('TokenManager is required');
    }
    if (!options.ragCache) {
      throw new ValidationError('RagCache is required');
    }

    this.tokenManager = options.tokenManager;
    this.ragCache = options.ragCache;
    this.metrics = options.metrics;
  }

  /**
   * Строит контекст RAG
   * @param {Object} options
   * @param {Array<Object>} options.orderedMessages - Упорядоченные сообщения
   * @param {string} options.systemContent - Системный контент
   * @param {Object} options.runtimeCfg - Конфигурация выполнения
   * @param {Object} options.req - Express request
   * @param {Object} options.res - Express response
   * @param {Object} options.endpointOption - Опции эндпоинта
   * @returns {Promise<Object>} Результат построения контекста
   */
  async buildContext({
    orderedMessages,
    systemContent,
    runtimeCfg,
    req,
    res,
    endpointOption
  }) {
    const context = this.buildLogContext(req, {
      conversationId: req?.body?.conversationId
    });

    this.log('debug', '[rag.context.build.start]', context);

    try {
      // Проверяем необходимость построения контекста
      if (!runtimeCfg.useConversationMemory || !context.conversationId) {
        this.log('debug', '[rag.context.skip]', {
          ...context,
          reason: 'disabled_or_no_conversation'
        });
        return this.emptyResult(systemContent);
      }

      // Получаем последнее сообщение пользователя
      const userMessage = orderedMessages[orderedMessages.length - 1];
      const userQuery = this.tokenManager.normalizeText(
        userMessage?.text || ''
      );

      if (!userQuery) {
        this.log('debug', '[rag.context.skip]', {
          ...context,
          reason: 'no_query'
        });
        return this.emptyResult(systemContent);
      }

      // Проверяем кэш
      const cacheKey = this.buildCacheKey({
        conversationId: context.conversationId,
        endpoint: endpointOption?.endpoint,
        model: endpointOption?.model,
        query: userQuery,
        config: runtimeCfg
      });

      const cached = this.ragCache.get(cacheKey);
      if (cached) {
        this.log('info', '[rag.context.cache.hit]', {
          ...context,
          cacheKey
        });
        if (this.metrics) {
          this.metrics.observeCache('hit');
        }
        return cached;
      }

      // Анализируем intent для multi-step RAG
      const intentAnalysis = runtimeCfg?.multiStepRag?.enabled
        ? await analyzeIntent({
            message: userMessage,
            context: orderedMessages.slice(-8),
            signal: req?.abortController?.signal,
            timeoutMs: runtimeCfg.multiStepRag?.intentTimeoutMs || 2000
          })
        : { entities: [], needsFollowUps: false };

      if (req) {
        req.intentAnalysis = intentAnalysis;
      }

      // Получаем граф контекст
      const graphContext = await this.getGraphContext({
        conversationId: context.conversationId,
        runtimeCfg,
        userQuery
      });

      // Строим контекст через multi-step RAG если включен
      let result;
      if (runtimeCfg?.multiStepRag?.enabled) {
        result = await this.buildMultiStepContext({
          intentAnalysis,
          runtimeCfg,
          baseContext: systemContent,
          graphContext,
          req,
          context
        });
      } else {
        // Строим обычный контекст
        result = await this.buildSimpleContext({
          userQuery,
          systemContent,
          graphContext,
          runtimeCfg,
          req,
          res,
          endpointOption,
          context
        });
      }

      // Сохраняем в кэш
      this.ragCache.set(cacheKey, result);
      if (this.metrics) {
        this.metrics.observeCache('miss');
      }

      this.log('info', '[rag.context.build.complete]', {
        ...context,
        contextLength: result.contextLength,
        cacheStatus: 'miss'
      });

      return result;
    } catch (error) {
      this.handleError(error, context);
    }
  }

  /**
   * Строит ключ кэша
   * @private
   */
  buildCacheKey({ conversationId, endpoint, model, query, config }) {
    const components = [
      conversationId,
      endpoint || 'default',
      model || 'default',
      this.tokenManager.normalizeText(query),
      JSON.stringify({
        graph: config.graphContext,
        vector: config.vectorContext,
        summarization: config.summarization
      })
    ];
    return components.join(':');
  }

  /**
   * Возвращает пустой результат
   * @private
   */
  emptyResult(systemContent) {
    return {
      patchedSystemContent: systemContent,
      contextLength: 0,
      cacheStatus: 'skipped',
      metrics: {}
    };
  }

  /**
   * Получает контекст из графа
   * @private
   */
  async getGraphContext({ conversationId, runtimeCfg, userQuery }) {
    if (!runtimeCfg?.useGraphContext) {
      return null;
    }

    const graphContext = await fetchGraphContext({
      conversationId,
      toolsGatewayUrl: runtimeCfg?.toolsGateway?.url,
      limit: runtimeCfg?.graphContext?.maxLines,
      timeoutMs: runtimeCfg?.graphContext?.requestTimeoutMs
    });

    if (graphContext?.lines?.length) {
      const normalizedLines = graphContext.lines.map(line =>
        this.tokenManager.normalizeText(line)
      );

      if (this.metrics) {
        const tokens = this.tokenManager.getTokenCount(
          normalizedLines.join('\n')
        );
        this.metrics.observeTokens({
          segment: 'rag_graph',
          tokens,
          type: 'raw'
        });
      }

      return {
        lines: normalizedLines,
        queryHint: graphContext.queryHint
      };
    }

    return null;
  }

  /**
   * Строит контекст через multi-step RAG
   * @private
   */
  async buildMultiStepContext({
    intentAnalysis,
    runtimeCfg,
    baseContext,
    graphContext,
    req,
    context
  }) {
    const result = await runMultiStepRag({
      intentAnalysis,
      runtimeCfg,
      baseContext,
      graphContext,
      conversationId: context.conversationId,
      userId: req?.user?.id,
      endpoint: req?.body?.endpointOption?.endpoint,
      model: req?.body?.endpointOption?.model,
      signal: req?.abortController?.signal
    });

    if (this.metrics && result.entities) {
      for (const entity of result.entities) {
        if (entity.tokens) {
          this.metrics.observeTokens({
            segment: 'rag_entity',
            tokens: entity.tokens,
            type: entity.type
          });
        }
      }
    }

    return {
      patchedSystemContent: result.globalContext,
      contextLength: result.globalContext.length,
      cacheStatus: 'miss',
      metrics: {
        entityCount: result.entities?.length || 0,
        passesUsed: result.passesUsed
      }
    };
  }

  /**
   * Строит обычный контекст
   * @private
   */
  async buildSimpleContext({
    userQuery,
    systemContent,
    graphContext,
    runtimeCfg,
    req,
    res,
    endpointOption,
    context
  }) {
    // Здесь должна быть логика построения обычного контекста
    // Включая работу с vector store и т.д.
    
    const ragBlock = buildRagBlock({
      policyIntro: 'RAG context:',
      graphLines: graphContext?.lines || [],
      vectorText: '' // TODO: добавить работу с vector store
    });

    const patchedSystemContent = ragBlock + systemContent;

    if (this.metrics) {
      const contextTokens = this.tokenManager.getTokenCount(ragBlock);
      this.metrics.observeTokens({
        segment: 'rag_context',
        tokens: contextTokens,
        type: 'simple'
      });
    }

    return {
      patchedSystemContent,
      contextLength: ragBlock.length,
      cacheStatus: 'miss',
      metrics: {
        graphLines: graphContext?.lines?.length || 0
      }
    };
  }
}

module.exports = RagContextBuilder;
