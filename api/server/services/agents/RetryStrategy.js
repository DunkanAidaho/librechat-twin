const { logger } = require('@librechat/data-schemas');

/**
 * Retry Strategy - handles retry logic with backoff
 */
class RetryStrategy {
  constructor(options = {}) {
    this.maxAttempts = options.maxAttempts || 3;
    this.initialDelayMs = options.initialDelayMs || 500;
    this.maxDelayMs = options.maxDelayMs || 5000;
    this.backoffMultiplier = options.backoffMultiplier || 2;
    this.retryCondition = options.retryCondition || (() => true);
  }

  /**
   * Calculates delay for retry attempt
   * @param {number} attempt
   * @returns {number}
   */
  calculateDelay(attempt) {
    const delay = this.initialDelayMs * Math.pow(this.backoffMultiplier, attempt - 1);
    return Math.min(delay, this.maxDelayMs);
  }

  /**
   * Executes function with retry logic
   * @param {Function} fn
   * @param {Object} context
   * @returns {Promise<any>}
   */
  async execute(fn, context = {}) {
    let lastError;
    let attempt = 0;

    while (attempt < this.maxAttempts) {
      try {
        const result = await fn(attempt, context);
        return result;
      } catch (error) {
        lastError = error;
        attempt++;

        const shouldRetry = this.retryCondition(error, attempt, context);

        if (!shouldRetry || attempt >= this.maxAttempts) {
          logger.error('[RetryStrategy] Max retries reached or retry condition failed', {
            attempt,
            maxAttempts: this.maxAttempts,
            error: error?.message,
          });
          throw error;
        }

        const delay = this.calculateDelay(attempt);

        logger.warn('[RetryStrategy] Retrying after error', {
          attempt,
          maxAttempts: this.maxAttempts,
          delayMs: delay,
          error: error?.message,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Creates retry strategy for context overflow
   * @param {Object} options
   * @returns {RetryStrategy}
   */
  static forContextOverflow(options = {}) {
    return new RetryStrategy({
      maxAttempts: options.maxAttempts || 3,
      initialDelayMs: options.initialDelayMs || 500,
      maxDelayMs: options.maxDelayMs || 2000,
      backoffMultiplier: options.backoffMultiplier || 1.5,
      retryCondition: (error) => {
        const status = error?.status || error?.response?.status || error?.code;
        if (status !== 400 && status !== '400') {
          return false;
        }

        const message = error?.message || error?.response?.data?.message || '';
        const lowerMessage = String(message).toLowerCase();

        return (
          lowerMessage.includes('context length') ||
          lowerMessage.includes('maximum context') ||
          (lowerMessage.includes('token') &&
            (lowerMessage.includes('exceed') || lowerMessage.includes('limit')))
        );
      },
    });
  }

  /**
   * Creates retry strategy for network errors
   * @param {Object} options
   * @returns {RetryStrategy}
   */
  static forNetworkErrors(options = {}) {
    return new RetryStrategy({
      maxAttempts: options.maxAttempts || 3,
      initialDelayMs: options.initialDelayMs || 1000,
      maxDelayMs: options.maxDelayMs || 10000,
      backoffMultiplier: options.backoffMultiplier || 2,
      retryCondition: (error) => {
        const code = error?.code;
        const status = error?.response?.status;

        if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
          return true;
        }

        if (status >= 500 && status < 600) {
          return true;
        }

        if (status === 429) {
          return true;
        }

        return false;
      },
    });
  }

  /**
   * Creates retry strategy for rate limits
   * @param {Object} options
   * @returns {RetryStrategy}
   */
  static forRateLimits(options = {}) {
    return new RetryStrategy({
      maxAttempts: options.maxAttempts || 5,
      initialDelayMs: options.initialDelayMs || 2000,
      maxDelayMs: options.maxDelayMs || 30000,
      backoffMultiplier: options.backoffMultiplier || 2,
      retryCondition: (error) => {
        const status = error?.response?.status;
        return status === 429;
      },
    });
  }
}

module.exports = RetryStrategy;
