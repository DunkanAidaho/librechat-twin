const configService = require('~/server/services/Config/ConfigService');
const { getLogger } = require('~/utils/logger');

const logger = getLogger('agents.promptBudget');

class PromptBudgetManager {
  constructor(promptConfig) {
    this.promptConfig = promptConfig || configService.getSection('prompt');
  }

  getHeadroom() {
    return Math.max(0, Number(this.promptConfig?.minHeadroomTokens) || 0);
  }

  resolveMaxPromptTokens(modelMaxTokens, explicitMaxTokens = null) {
    const resolvedModelLimit = Number(modelMaxTokens) || 0;
    const percentCap = Math.floor(
      resolvedModelLimit * (Number(this.promptConfig?.maxContextPercent) || 0.9),
    );
    const explicit = Number(explicitMaxTokens || this.promptConfig?.maxPromptTokens);
    const clampTarget = explicit > 0 ? explicit : resolvedModelLimit || percentCap;
    const rawLimit = Math.min(
      clampTarget || percentCap,
      percentCap > 0 ? percentCap : clampTarget,
    );

    const headroom = this.getHeadroom();
    const budget = Math.max(0, rawLimit - headroom);

    return {
      headroom,
      rawLimit,
      promptBudget: budget,
      modelLimit: resolvedModelLimit,
    };
  }

  computeDeficit(currentTokens, budget) {
    const normalizedBudget = Math.max(0, Number(budget) || 0);
    const overflow = Math.max(0, Number(currentTokens) - normalizedBudget);
    return overflow;
  }

  logBudgetCheck({ conversationId, total, limit, stage, action, extra = {} }) {
    logger.info('[prompt.budget.check]', {
      conversationId,
      total,
      limit,
      stage,
      action,
      ...extra,
    });
  }

  getRetryPolicy() {
    const retry = this.promptConfig?.retry || {};
    return {
      maxAttempts: Math.max(1, Number(retry.maxAttempts) || 2),
      maxReduction: Math.min(1, Math.max(0, Number(retry.maxReduction) || 0.5)),
    };
  }

  getVectorLimits() {
    const vector = this.promptConfig?.vector || {};
    return {
      maxTokens: Math.max(1, Number(vector.maxTokens) || 50000),
      maxTokensPerChunk: Math.max(1, Number(vector.maxTokensPerChunk) || 6000),
    };
  }
}

module.exports = {
  PromptBudgetManager,
};
