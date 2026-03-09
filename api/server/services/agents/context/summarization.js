const DEFAULT_LIMITS = Object.freeze({
  budgetChars: 12000,
  chunkChars: 20000,
  timeoutMs: 125000,
  minBudgetChars: 2000,
  minChunkChars: 2000,
});

function toPositiveInteger(value, fallback) {
  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function resolveSummarizationConfig({ summarizationCfg = {}, ragBudgetTokens } = {}) {
  const baseBudgetChars = toPositiveInteger(
    summarizationCfg?.budgetChars,
    DEFAULT_LIMITS.budgetChars,
  );
  const baseChunkChars = toPositiveInteger(
    summarizationCfg?.chunkChars,
    DEFAULT_LIMITS.chunkChars,
  );
  const baseTimeoutMs = toPositiveInteger(
    summarizationCfg?.timeoutMs,
    DEFAULT_LIMITS.timeoutMs,
  );
  const provider = typeof summarizationCfg?.provider === 'string' ? summarizationCfg.provider : undefined;
  const enabled = summarizationCfg?.enabled !== false;

  const dynamicBudgetChars = Number.isFinite(ragBudgetTokens)
    ? Math.max(Math.floor(ragBudgetTokens * 4 * 0.35), DEFAULT_LIMITS.minBudgetChars)
    : baseBudgetChars;
  const dynamicChunkChars = Number.isFinite(ragBudgetTokens)
    ? Math.max(Math.floor(ragBudgetTokens * 4 * 0.2), DEFAULT_LIMITS.minChunkChars)
    : baseChunkChars;

  return {
    baseBudgetChars,
    baseChunkChars,
    baseTimeoutMs,
    dynamicBudgetChars,
    dynamicChunkChars,
    provider,
    enabled,
  };
}

function buildSummarizationSnapshot(resolvedConfig) {
  if (!resolvedConfig) {
    return normalizeSummarizationSnapshot();
  }

  return {
    budgetChars: resolvedConfig.dynamicBudgetChars,
    chunkChars: resolvedConfig.dynamicChunkChars,
    timeoutMs: resolvedConfig.baseTimeoutMs,
    provider: resolvedConfig.provider,
    enabled: resolvedConfig.enabled,
    baseBudgetChars: resolvedConfig.baseBudgetChars,
    baseChunkChars: resolvedConfig.baseChunkChars,
    dynamicBudgetChars: resolvedConfig.dynamicBudgetChars,
    dynamicChunkChars: resolvedConfig.dynamicChunkChars,
  };
}

function normalizeSummarizationSnapshot(inputConfig = {}) {
  const budgetChars = toPositiveInteger(
    inputConfig?.budgetChars ?? inputConfig?.dynamicBudgetChars,
    DEFAULT_LIMITS.budgetChars,
  );
  const chunkChars = toPositiveInteger(
    inputConfig?.chunkChars ?? inputConfig?.dynamicChunkChars,
    DEFAULT_LIMITS.chunkChars,
  );
  const timeoutMs = toPositiveInteger(inputConfig?.timeoutMs, DEFAULT_LIMITS.timeoutMs);
  const provider = typeof inputConfig?.provider === 'string' ? inputConfig.provider : undefined;
  const enabled = inputConfig?.enabled !== false;

  return {
    budgetChars,
    chunkChars,
    timeoutMs,
    provider,
    enabled,
  };
}

module.exports = {
  DEFAULT_LIMITS,
  resolveSummarizationConfig,
  buildSummarizationSnapshot,
  normalizeSummarizationSnapshot,
};
