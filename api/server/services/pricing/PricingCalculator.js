const { logger } = require('@librechat/data-schemas');

/**
 * Pricing Calculator - handles token cost calculations
 */
class PricingCalculator {
  constructor(pricingConfig = {}) {
    this.pricingConfig = pricingConfig;
  }

  /**
   * Safely parses USD rate
   * @param {unknown} value
   * @returns {number|null}
   */
  static parseUsdRate(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Resolves pricing rates for a model
   * @param {string} modelName
   * @param {object|undefined} overrideConfig
   * @returns {{promptUsdPer1k: number|null, completionUsdPer1k: number|null, source: string}}
   */
  resolvePricingRates(modelName, overrideConfig) {
    const sources = new Set();
    let promptUsdPer1k = null;
    let completionUsdPer1k = null;

    if (overrideConfig && typeof overrideConfig === 'object') {
      const modelsConfig = overrideConfig.models;
      if (modelsConfig && typeof modelsConfig === 'object') {
        const modelPricing = modelsConfig[modelName] || modelsConfig.default;
        if (modelPricing && typeof modelPricing === 'object') {
          const promptCandidate = PricingCalculator.parseUsdRate(
            modelPricing.prompt ?? modelPricing.input ?? modelPricing.promptUsdPer1k,
          );
          if (promptCandidate != null) {
            promptUsdPer1k = promptCandidate;
            sources.add('request.models.prompt');
          }

          const completionCandidate = PricingCalculator.parseUsdRate(
            modelPricing.completion ?? modelPricing.output ?? modelPricing.completionUsdPer1k,
          );
          if (completionCandidate != null) {
            completionUsdPer1k = completionCandidate;
            sources.add('request.models.completion');
          }
        }
      }

      const rootPrompt = PricingCalculator.parseUsdRate(overrideConfig.promptUsdPer1k);
      if (promptUsdPer1k == null && rootPrompt != null) {
        promptUsdPer1k = rootPrompt;
        sources.add('request.promptUsdPer1k');
      }

      const rootCompletion = PricingCalculator.parseUsdRate(overrideConfig.completionUsdPer1k);
      if (completionUsdPer1k == null && rootCompletion != null) {
        completionUsdPer1k = rootCompletion;
        sources.add('request.completionUsdPer1k');
      }
    }

    const globalConfig =
      this.pricingConfig && typeof this.pricingConfig === 'object' ? this.pricingConfig : {};
    const globalModels = globalConfig.models;

    if (
      globalModels &&
      typeof globalModels === 'object' &&
      (promptUsdPer1k == null || completionUsdPer1k == null)
    ) {
      const modelPricing = globalModels[modelName] || globalModels.default;
      if (modelPricing && typeof modelPricing === 'object') {
        if (promptUsdPer1k == null) {
          const promptCandidate = PricingCalculator.parseUsdRate(
            modelPricing.prompt ?? modelPricing.input ?? modelPricing.promptUsdPer1k,
          );
          if (promptCandidate != null) {
            promptUsdPer1k = promptCandidate;
            sources.add('config.models.prompt');
          }
        }

        if (completionUsdPer1k == null) {
          const completionCandidate = PricingCalculator.parseUsdRate(
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
      const rootPrompt = PricingCalculator.parseUsdRate(globalConfig.promptUsdPer1k);
      if (rootPrompt != null) {
        promptUsdPer1k = rootPrompt;
        sources.add('config.promptUsdPer1k');
      }
    }

    if (completionUsdPer1k == null) {
      const rootCompletion = PricingCalculator.parseUsdRate(globalConfig.completionUsdPer1k);
      if (rootCompletion != null) {
        completionUsdPer1k = rootCompletion;
        sources.add('config.completionUsdPer1k');
      }
    }

    if (promptUsdPer1k == null) {
      const envPrompt = PricingCalculator.parseUsdRate(process.env.DEFAULT_PROMPT_USD_PER_1K);
      if (envPrompt != null) {
        promptUsdPer1k = envPrompt;
        sources.add('env.DEFAULT_PROMPT_USD_PER_1K');
      }
    }

    if (completionUsdPer1k == null) {
      const envCompletion = PricingCalculator.parseUsdRate(
        process.env.DEFAULT_COMPLETION_USD_PER_1K,
      );
      if (envCompletion != null) {
        completionUsdPer1k = envCompletion;
        sources.add('env.DEFAULT_COMPLETION_USD_PER_1K');
      }
    }

    const source = sources.size ? Array.from(sources).join(',') : 'unknown';
    return { promptUsdPer1k, completionUsdPer1k, source };
  }

  /**
   * Calculates cost for token usage
   * @param {Object} params
   * @returns {{costUsd: number|null, breakdown: Object}}
   */
  calculateCost({
    modelName,
    inputTokens = 0,
    outputTokens = 0,
    reasoningTokens = 0,
    cacheCreation = 0,
    cacheRead = 0,
    overrideConfig = null,
  }) {
    const rates = this.resolvePricingRates(modelName, overrideConfig);
    const { promptUsdPer1k, completionUsdPer1k, source } = rates;

    let costUsd = null;
    const breakdown = {
      inputCost: null,
      outputCost: null,
      reasoningCost: null,
      cacheCost: null,
      totalCost: null,
    };

    if (promptUsdPer1k != null || completionUsdPer1k != null) {
      costUsd = 0;

      if (promptUsdPer1k != null) {
        const inputCost = (inputTokens / 1000) * promptUsdPer1k;
        const cacheCost = ((cacheCreation + cacheRead) / 1000) * promptUsdPer1k;
        breakdown.inputCost = inputCost;
        breakdown.cacheCost = cacheCost;
        costUsd += inputCost + cacheCost;
      }

      if (completionUsdPer1k != null) {
        const outputCost = (outputTokens / 1000) * completionUsdPer1k;
        const reasoningCost = (reasoningTokens / 1000) * completionUsdPer1k;
        breakdown.outputCost = outputCost;
        breakdown.reasoningCost = reasoningCost;
        costUsd += outputCost + reasoningCost;
      }

      costUsd = Math.round(costUsd * 1_000_000) / 1_000_000;
      breakdown.totalCost = costUsd;
    }

    return {
      costUsd,
      breakdown,
      rates,
      source,
    };
  }

  /**
   * Formats cost for logging
   * @param {number|null} costUsd
   * @returns {string}
   */
  static formatCost(costUsd) {
    return costUsd != null ? costUsd.toFixed(6) : 'n/a';
  }

  /**
   * Logs pricing details
   * @param {Object} params
   */
  logPricing({
    conversationId,
    modelName,
    inputTokens,
    outputTokens,
    reasoningTokens = 0,
    cacheCreation = 0,
    cacheRead = 0,
    costUsd,
    source,
  }) {
    const rates = this.resolvePricingRates(modelName);
    const promptRateLog = rates.promptUsdPer1k != null ? rates.promptUsdPer1k : 'n/a';
    const completionRateLog = rates.completionUsdPer1k != null ? rates.completionUsdPer1k : 'n/a';
    const costLog = PricingCalculator.formatCost(costUsd);

    logger.info(
      `[pricing.tokens.detail] conversation=${conversationId ?? 'unknown'} model=${modelName} ` +
        `prompt=${inputTokens} completion=${outputTokens} reasoning=${reasoningTokens} ` +
        `cache_write=${cacheCreation} cache_read=${cacheRead} ` +
        `promptUsdPer1k=${promptRateLog} completionUsdPer1k=${completionRateLog} ` +
        `pricingSource=${source}`,
    );

    const totalTokens = inputTokens + outputTokens + reasoningTokens;
    logger.info(
      `[pricing.tokens.total] conversation=${conversationId ?? 'unknown'} ` +
        `totalTokens=${totalTokens} costUsd=${costLog}`,
    );
  }
}

module.exports = PricingCalculator;
