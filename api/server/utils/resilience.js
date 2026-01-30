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
      logger.warn(
        '[Resilience] Повторная попытка %d после ошибки в %s: %s',
        nextAttempt,
        operationName,
        error?.message || error,
      );
      if (typeof onRetry === 'function') {
        try {
          await onRetry(error, nextAttempt);
        } catch (hookErr) {
          logger.error(
            '[Resilience] Ошибка в пользовательском onRetry (%s): %s',
            operationName,
            hookErr?.message || hookErr,
          );
          throw hookErr;
        }
      }
    },
  };

  try {
    const result = await retryAsync(attemptExecutor, retryOptions);
    const durationMs = Date.now() - startedAt;
    logger.debug(
      '[Resilience] Операция %s завершена, попыток=%d, длительность=%dms',
      operationName,
      normalizedRetries + 1,
      durationMs,
    );
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logger.error(
      '[Resilience] Операция %s провалилась спустя %dms: %s',
      operationName,
      durationMs,
      err?.message || err,
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
