'use strict';

const { Tokenizer } = require('@librechat/api');
const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');
const { OpenRouterModelService } = require('~/server/services/Models');

const DEFAULT_HEADROOM_PERCENT = 0.08;

class PromptBudgetManager {
  constructor({ configService, modelService = null, logger = null } = {}) {
    this.configService = configService;
    this.logger = logger || getLogger('agents.budget');
    this.modelService = modelService || new OpenRouterModelService({ configService });
  }

  async resolveModelLimit({ model, requestContext = {} } = {}) {
    const modelsMap = await this.modelService.getModelsMap({ requestContext });
    const entry = modelsMap?.[model];
    if (entry?.maxContextTokens) {
      return entry.maxContextTokens;
    }
    return null;
  }

  resolveShares({ config = {}, minShares = {} } = {}) {
    const defaults = {
      instructions: 0.15,
      history: 0.35,
      rag: 0.25,
      tools: 0.05,
    };
    const shares = config.shares || {};
    const sanitized = {
      instructions: this._sanitizeShare(shares.instructions, defaults.instructions),
      history: this._sanitizeShare(shares.history, defaults.history),
      rag: this._sanitizeShare(shares.rag, defaults.rag),
      tools: this._sanitizeShare(shares.tools, defaults.tools),
    };

    const floor = {
      instructions: this._sanitizeMinShare(minShares.instructions, 0),
      history: this._sanitizeMinShare(minShares.history, 0),
      rag: this._sanitizeMinShare(minShares.rag, 0),
      tools: this._sanitizeMinShare(minShares.tools, 0),
    };

    return {
      instructions: Math.max(sanitized.instructions, floor.instructions),
      history: Math.max(sanitized.history, floor.history),
      rag: Math.max(sanitized.rag, floor.rag),
      tools: Math.max(sanitized.tools, floor.tools),
    };
  }

  _sanitizeShare(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
      return fallback;
    }
    return parsed;
  }

  _sanitizeMinShare(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 1) {
      return fallback;
    }
    return parsed;
  }

  _resolveHeadroomPercent(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
      return DEFAULT_HEADROOM_PERCENT;
    }
    return parsed;
  }

  async getBudget({ model, runtimeCfg = {}, requestContext = {}, encoding = 'o200k_base' } = {}) {
    const config = this.configService?.getSection?.('memory') || {};
    const perModel = runtimeCfg?.prompt?.models?.[model] || {};
    const globalPromptCfg = runtimeCfg?.prompt || {};
    const modelLimit =
      perModel.maxContextTokens ||
      (await this.resolveModelLimit({ model, requestContext })) ||
      runtimeCfg?.tokenLimits?.maxMessageTokens ||
      config?.history?.tokenBudget ||
      0;

    const headroomPercent = this._resolveHeadroomPercent(
      perModel.headroomPercent ?? globalPromptCfg.headroomPercent,
    );
    const maxContextPercent =
      Number(globalPromptCfg.maxContextPercent) > 0
        ? Number(globalPromptCfg.maxContextPercent)
        : 1;

    const safeBudget = Math.floor(modelLimit * maxContextPercent * (1 - headroomPercent));
    const shares = this.resolveShares({
      config: perModel.shares ? perModel : globalPromptCfg,
      minShares: perModel.minShares || globalPromptCfg.minShares || {},
    });

    const totalShare =
      shares.instructions + shares.history + shares.rag + shares.tools;
    const normalizedShares = totalShare > 0
      ? {
          instructions: shares.instructions / totalShare,
          history: shares.history / totalShare,
          rag: shares.rag / totalShare,
          tools: shares.tools / totalShare,
        }
      : shares;

    const budget = {
      modelLimit,
      safeBudget,
      headroomPercent,
      maxContextPercent,
      shares: normalizedShares,
      budgets: {
        instructions: Math.floor(safeBudget * normalizedShares.instructions),
        history: Math.floor(safeBudget * normalizedShares.history),
        rag: Math.floor(safeBudget * normalizedShares.rag),
        tools: Math.floor(safeBudget * normalizedShares.tools),
      },
    };

    this.logger.info(
      'context.budget',
      buildContext(requestContext, {
        model,
        modelLimit,
        safeBudget,
        headroomPercent,
        maxContextPercent,
        shares: normalizedShares,
      }),
    );

    return budget;
  }

  estimateTokens(text = '', encoding = 'o200k_base') {
    try {
      return Tokenizer.getTokenCount(text || '', encoding);
    } catch {
      return text.length || 0;
    }
  }
}

module.exports = PromptBudgetManager;
