const { logger } = require('@librechat/data-schemas');
const { retryAsync, withTimeout } = require('~/utils/async');

/**
 * Default resilience configuration
 */
const DEFAULT_RESILIENCE_CONFIG = {
  minDelayMs: 200,
  maxDelayMs: 5000,
  backoffFactor: 2,
  jitter: 0.2,
};

/**
 * Executes a function with resilience (retries, timeout, backoff)
 * @param {string} operationName - Name of the operation for logging
 * @param {function} fn - Function to execute, receives {attempt}
 * @param {Object} options - Resilience options
 * @returns {Promise<any>}
 */
async function runWithResilience(operationName, fn, options = {}) {
  const {
    timeoutMs = 0,
    retries = 0,
    timeoutMessage,
    signal,
    minDelay = DEFAULT_RESILIENCE_CONFIG.minDelayMs,
    maxDelay = DEFAULT_RESILIENCE_CONFIG.maxDelayMs,
    factor = DEFAULT_RESILIENCE_CONFIG.backoffFactor,
    jitter = DEFAULT_RESILIENCE_CONFIG.jitter,
    onRetry,
  } = options;

  const normalizedRetries = Math.max(0, retries);
  const normalizedMinDelay = Number.isFinite(minDelay) ? Math.max(0, minDelay) : DEFAULT_RESILIENCE_CONFIG.minDelayMs;
  const normalizedMaxDelayRaw = Number.isFinite(maxDelay) ? Math.max(0, maxDelay) : DEFAULT_RESILIENCE_CONFIG.maxDelayMs;
  const normalizedMaxDelay = Math.max(normalizedMinDelay, normalizedMaxDelayRaw);
  const normalizedFactor = Number.isFinite(factor) && factor >= 1 ? factor : DEFAULT_RESILIENCE_CONFIG.backoffFactor;
  const normalizedJitter = Number.isFinite(jitter) ? Math.min(Math.max(0, jitter), 1) : DEFAULT_RESILIENCE_CONFIG.jitter;
  const hasTimeout = Boolean(timeoutMs && timeoutMs > 0);
  const startedAt = Date.now();

  const attemptExecutor = (attempt) => {
    const promise = Promise.resolve(fn({ attempt }));
    if (!hasTimeout) {
      return promise;
    }
    return withTimeout(
      promise,
      timeoutMs,
      timeoutMessage || `Операция ${operationName} превысила таймаут`,
      signal,
    );
  };

  if (normalizedRetries <= 0) {
    return attemptExecutor(0);
  }

  const retryOptions = {
    retries: normalizedRetries,
    minDelay: normalizedMinDelay,
    maxDelay: normalizedMaxDelay,
    factor: normalizedFactor,
    jitter: normalizedJitter,
    signal,
    onRetry: async (error, attemptNumber) => {
      const nextAttempt = attemptNumber + 1;
      logger.info(
        `[Resilience] Повторная попытка ${nextAttempt} после ошибки в ${operationName}: ${error?.message || error}`,
      );
      if (typeof onRetry === 'function') {
        try {
          await onRetry(error, nextAttempt);
        } catch (hookError) {
          logger.error(
            `[Resilience] Ошибка в пользовательском onRetry (${operationName}): ${hookError?.message || hookError}`,
          );
          throw hookError;
        }
      }
    },
  };

  try {
    const result = await retryAsync(attemptExecutor, retryOptions);
    const durationMs = Date.now() - startedAt;
    logger.debug(
      `[Resilience] Операция ${operationName} завершена, попыток=${normalizedRetries - retryOptions.retries}, длительность=${durationMs}ms`,
    );
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logger.error(
      `[Resilience] Операция ${operationName} провалилась спустя ${durationMs}ms: ${err?.message || err}`,
    );
    throw err;
  }
}

/**
 * Normalizes a label value for metrics
 * @param {string} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeLabelValue(value, fallback = 'unknown') {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
}

module.exports = {
  runWithResilience,
  normalizeLabelValue,
  DEFAULT_RESILIENCE_CONFIG,
};
