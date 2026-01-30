const { logger } = require('@librechat/data-schemas');
const { Tokenizer, getTokenCountForMessage } = require('@librechat/api');

/**
 * Token Counter - handles token counting with caching
 */
class TokenCounter {
  constructor(options = {}) {
    this.encoding = options.encoding || 'o200k_base';
    this.cache = new Map();
    this.cacheEnabled = options.cacheEnabled !== false;
    this.maxCacheSize = options.maxCacheSize || 10000;
  }

  /**
   * Creates cache key for message
   * @param {Object} message
   * @returns {string}
   */
  createCacheKey(message) {
    const content =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const role = message.role || message._getType?.() || 'unknown';
    return `${role}:${content.slice(0, 100)}:${content.length}`;
  }

  /**
   * Counts tokens in text
   * @param {string} text
   * @returns {number}
   */
  countText(text) {
    if (!text || typeof text !== 'string') {
      return 0;
    }

    try {
      return Tokenizer.getTokenCount(text, this.encoding);
    } catch (error) {
      logger.warn('[TokenCounter] Failed to count tokens', {
        error: error?.message,
        textLength: text.length,
      });
      return Math.ceil(text.length / 4);
    }
  }

  /**
   * Counts tokens in message
   * @param {Object} message
   * @returns {number}
   */
  countMessage(message) {
    if (!message) {
      return 0;
    }

    if (this.cacheEnabled) {
      const cacheKey = this.createCacheKey(message);
      const cached = this.cache.get(cacheKey);

      if (cached !== undefined) {
        return cached;
      }

      if (this.cache.size >= this.maxCacheSize) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
    }

    const countTokens = (text) => this.countText(text);
    const count = getTokenCountForMessage(message, countTokens);

    if (this.cacheEnabled) {
      const cacheKey = this.createCacheKey(message);
      this.cache.set(cacheKey, count);
    }

    return count;
  }

  /**
   * Counts tokens in array of messages
   * @param {Array} messages
   * @returns {number}
   */
  countMessages(messages) {
    if (!Array.isArray(messages)) {
      return 0;
    }

    return messages.reduce((sum, message) => sum + this.countMessage(message), 0);
  }

  /**
   * Creates token counter function for specific encoding
   * @param {string} encoding
   * @returns {Function}
   */
  static createCounter(encoding) {
    return function (message) {
      const countTokens = (text) => Tokenizer.getTokenCount(text, encoding);
      return getTokenCountForMessage(message, countTokens);
    };
  }

  /**
   * Calculates current token count from usage
   * @param {Object} params
   * @returns {number}
   */
  static calculateCurrentTokenCount({
    tokenCountMap,
    currentMessageId,
    usage,
    inputTokensKey = 'input_tokens',
  }) {
    const originalEstimate = tokenCountMap[currentMessageId] || 0;

    if (!usage || typeof usage[inputTokensKey] !== 'number') {
      return originalEstimate;
    }

    tokenCountMap[currentMessageId] = 0;
    const totalTokensFromMap = Object.values(tokenCountMap).reduce((sum, count) => {
      const numCount = Number(count);
      return sum + (isNaN(numCount) ? 0 : numCount);
    }, 0);
    const totalInputTokens = usage[inputTokensKey] ?? 0;

    const currentMessageTokens = totalInputTokens - totalTokensFromMap;
    return currentMessageTokens > 0 ? currentMessageTokens : originalEstimate;
  }

  /**
   * Clears token cache
   */
  clearCache() {
    this.cache.clear();
    logger.debug('[TokenCounter] Cache cleared');
  }

  /**
   * Gets cache statistics
   * @returns {Object}
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      enabled: this.cacheEnabled,
    };
  }
}

module.exports = TokenCounter;
