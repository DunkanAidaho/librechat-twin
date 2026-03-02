const PricingCalculator = require('~/server/services/pricing/PricingCalculator');

function createAgentUsageService({ pricingConfig, usageReporter, writeTokenReport, logger, configService }) {
  const pricingCalculator = new PricingCalculator(pricingConfig);

  const recordCollectedUsage = async ({
    model,
    balance,
    transactions,
    context = 'message',
    collectedUsage = [],
    conversationId,
    user,
    endpointTokenConfig,
    currentMessages = [],
    ragCacheStatus,
    pricingOverride,
  }) => {
    if (!collectedUsage || !collectedUsage.length) {
      return { usage: null, pricing: null };
    }

    const modelName = model;
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
      const cacheRead = Number(usage?.input_token_details?.cache_token_details?.cache_read) || 0;
      totalCacheCreation += cacheCreation;
      totalCacheRead += cacheRead;

      const reasoningDirect = Number(usage?.reasoning_tokens);
      const reasoningDetailed = Number(usage?.completion_tokens_details?.reasoning_tokens);
      if (Number.isFinite(reasoningDirect)) {
        totalReasoningTokens += reasoningDirect;
      } else if (Number.isFinite(reasoningDetailed)) {
        totalReasoningTokens += reasoningDetailed;
      }

      const txMetadata = {
        context,
        balance,
        transactions,
        conversationId,
        user,
        endpointTokenConfig,
        model: usage.model ?? modelName,
      };

      if (i > 0) {
        output_tokens +=
          (Number(usage.input_tokens) || 0) + cacheCreation + cacheRead - previousTokens;
      }

      output_tokens += Number(usage.output_tokens) || 0;
      previousTokens += Number(usage.output_tokens) || 0;

      if (cacheCreation > 0 || cacheRead > 0) {
        usageReporter
          .spendStructuredTokens(txMetadata, {
            promptTokens: {
              input: usage.input_tokens,
              write: cacheCreation,
              read: cacheRead,
            },
            completionTokens: usage.output_tokens,
          })
          .catch((err) => {
            logger.error('[agent.usage.recordCollectedUsage] Error spending structured tokens', err);
          });
        continue;
      }

      usageReporter
        .spendTokens(txMetadata, {
          promptTokens: usage.input_tokens,
          completionTokens: usage.output_tokens,
        })
        .catch((err) => {
          logger.error('[agent.usage.recordCollectedUsage] Error spending tokens', err);
        });
    }

    const usage = {
      input_tokens,
      output_tokens,
    };

    const totalTokensBilled = input_tokens + output_tokens + totalReasoningTokens;
    const inputTokensNet = Math.max(input_tokens - totalCacheCreation - totalCacheRead, 0);
    const pricing = pricingCalculator.calculateCost({
      modelName,
      inputTokens: inputTokensNet,
      outputTokens: output_tokens,
      reasoningTokens: totalReasoningTokens,
      cacheCreation: totalCacheCreation,
      cacheRead: totalCacheRead,
      overrideConfig: pricingOverride,
    });

    if (typeof usageReporter.observeCost === 'function' && pricing.costUsd != null) {
      usageReporter.observeCost(
        {
          model: modelName,
          endpoint: pricingOverride?.endpoint || 'unknown',
        },
        pricing.costUsd,
      );
    }

    pricingCalculator.logPricing({
      logger,
      overrideConfig: pricingOverride,
      conversationId,
      modelName,
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      reasoningTokens: totalReasoningTokens,
      cacheCreation: totalCacheCreation,
      cacheRead: totalCacheRead,
      costUsd: pricing.costUsd,
      source: pricing.source,
    });

    try {
      writeTokenReport({
        sessionId: conversationId ?? 'unknown-session',
        totalTokens: totalTokensBilled,
        promptTokens: input_tokens,
        completionTokens: output_tokens,
        reasoningTokens: totalReasoningTokens,
        costUsd: pricing.costUsd,
        pricingSource: pricing.source,
        ragReuseCount: ragCacheStatus === 'hit' ? 1 : 0,
        perMessage: currentMessages.map((msg) => ({
          messageId: msg?.messageId ?? 'unknown-message',
          tokens: Number(msg?.tokenCount) || 0,
          isRagContext: msg?.metadata?.isRagContext === true,
        })),
      });
    } catch (reportError) {
      logger.warn('[token.report] failed', { message: reportError?.message });
    }

    return { usage, pricing };
  };

  const recordTokenUsage = async ({
    model,
    usage,
    balance,
    promptTokens,
    completionTokens,
    context = 'message',
    conversationId,
    user,
    endpointTokenConfig,
  }) => {
    try {
      await usageReporter.spendTokens(
        {
          model,
          context,
          balance,
          conversationId,
          user,
          endpointTokenConfig,
        },
        { promptTokens, completionTokens },
      );

      if (
        usage &&
        typeof usage === 'object' &&
        'reasoning_tokens' in usage &&
        typeof usage.reasoning_tokens === 'number'
      ) {
        await usageReporter.spendTokens(
          {
            model,
            balance,
            context: 'reasoning',
            conversationId,
            user,
            endpointTokenConfig,
          },
          { completionTokens: usage.reasoning_tokens },
        );
      }
    } catch (error) {
      logger.error('[agent.usage.recordTokenUsage] Error recording token usage', error);
    }
  };

  const emitPromptTokenBreakdown = ({
    promptTokenContext,
    promptTokens,
    cacheRead = 0,
    cacheWrite = 0,
    reasoningTokens = 0,
  }) => {
    if (!promptTokenContext) {
      return null;
    }

    const breakdown = usageReporter.computePromptTokenBreakdown({
      conversationId: promptTokenContext.conversationId,
      promptTokens: promptTokens ?? (promptTokenContext.promptTokensEstimate ?? 0),
      instructionsTokens: promptTokenContext.instructionsTokens,
      ragGraphTokens: promptTokenContext.ragGraphTokens,
      ragVectorTokens: promptTokenContext.ragVectorTokens,
      messages: promptTokenContext.messages,
      cache: {
        read: cacheRead,
        write: cacheWrite,
      },
      reasoningTokens,
    });

    const tokenBreakdownConfig = configService.get('logging.tokenBreakdown', {
      enabled: true,
      level: 'info',
    });

    if (tokenBreakdownConfig.enabled) {
      usageReporter.logPromptTokenBreakdown(logger, breakdown, tokenBreakdownConfig.level || 'info');
    }

    return breakdown;
  };

  return Object.freeze({
    recordCollectedUsage,
    recordTokenUsage,
    emitPromptTokenBreakdown,
  });
}

module.exports = {
  createAgentUsageService,
};
