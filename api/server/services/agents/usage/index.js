const { spendTokens, spendStructuredTokens } = require('~/models/spendTokens');
const { writeTokenReport } = require('~/utils/tokenReport');
const { observeCost } = require('~/utils/ragMetrics');
const { createAgentUsageService } = require('~/server/services/agents/usage/agentUsageService');
const { getLogger } = require('~/utils/logger');
const configService = require('~/server/services/Config/ConfigService');
const {
  computePromptTokenBreakdown,
  logPromptTokenBreakdown,
} = require('~/server/utils/tokenBreakdown');

function createUsageReporter(overrides = {}) {
  const impl = Object.assign(
    {
      spendTokens,
      spendStructuredTokens,
      writeTokenReport,
      observeCost,
      computePromptTokenBreakdown,
      logPromptTokenBreakdown,
    },
    overrides,
  );

  return Object.freeze({
    spendTokens: (meta, data) => impl.spendTokens(meta, data),
    spendStructuredTokens: (meta, data) => impl.spendStructuredTokens(meta, data),
    writeTokenReport: (report) => impl.writeTokenReport(report),
    observeCost: (labels, value) => impl.observeCost(labels, value),
    computePromptTokenBreakdown: (payload) => impl.computePromptTokenBreakdown(payload),
    logPromptTokenBreakdown: (logger, breakdown, level) =>
      impl.logPromptTokenBreakdown(logger, breakdown, level),
  });
}

const usageReporter = createUsageReporter();

const agentUsageService = createAgentUsageService({
  pricingConfig: configService.getSection('pricing') ?? null,
  usageReporter,
  writeTokenReport,
  logger: getLogger('agents.usage'),
  configService,
});

module.exports = {
  createUsageReporter,
  usageReporter,
  createAgentUsageService,
  agentUsageService,
};
