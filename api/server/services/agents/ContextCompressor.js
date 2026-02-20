const { logger } = require('@librechat/data-schemas');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');

/**
 * Context compression strategies
 */
const CompressionStrategy = {
  MINIMAL: 'minimal',
  MODERATE: 'moderate',
  AGGRESSIVE: 'aggressive',
};

/**
 * Context Compressor - handles message compression for retry scenarios
 */
class ContextCompressor {
  /**
   * Detects if error is context overflow (400 with token limit message)
   * @param {Error} error
   * @returns {boolean}
   */
  static detectContextOverflow(error) {
    if (!error) {
      return false;
    }

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
  }

  /**
   * Gets reduction factor for strategy
   * @param {string} strategy
   * @returns {number}
   */
  static getReductionFactor(strategy) {
    switch (strategy) {
      case CompressionStrategy.MINIMAL:
        return 0.3;
      case CompressionStrategy.MODERATE:
        return 0.5;
      case CompressionStrategy.AGGRESSIVE:
        return 0.7;
      default:
        return 0.5;
    }
  }

  /**
   * Compresses messages for retry after context overflow
   * @param {Array} messages
   * @param {number|string} targetReduction
   * @returns {Array}
   */
  static compressMessages(messages, targetReduction = 0.5) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return messages;
    }

    const reductionFactor =
      typeof targetReduction === 'string'
        ? this.getReductionFactor(targetReduction)
        : targetReduction;

    const compressed = [];
    const keepSystemMessage = messages.find((m) => m._getType && m._getType() === 'system');

    if (keepSystemMessage) {
      const systemContent =
        typeof keepSystemMessage.content === 'string'
          ? keepSystemMessage.content
          : JSON.stringify(keepSystemMessage.content);

      const maxSystemLength = Math.floor(systemContent.length * (1 - reductionFactor));
      const truncatedSystem = systemContent.slice(0, maxSystemLength);

      compressed.push(
        new SystemMessage({
          content: truncatedSystem + '\n[...system message truncated due to context limit...]',
        }),
      );
    }

    const nonSystemMessages = messages.filter((m) => !m._getType || m._getType() !== 'system');
    const keepCount = Math.max(3, Math.floor(nonSystemMessages.length * (1 - reductionFactor)));
    const recentMessages = nonSystemMessages.slice(-keepCount);

    for (const msg of recentMessages) {
      const messageType = msg._getType ? msg._getType() : 'unknown';
      let content = msg.content;

      if (typeof content === 'string') {
        const maxLength = Math.floor(content.length * (1 - reductionFactor));
        if (content.length > maxLength) {
          content = content.slice(0, maxLength) + '\n[...truncated...]';
        }
      } else if (Array.isArray(content)) {
        content = content
          .filter((part) => part.type === 'text')
          .map((part) => {
            const text = part.text || '';
            const maxLength = Math.floor(text.length * (1 - reductionFactor));
            return {
              type: 'text',
              text:
                text.length > maxLength ? text.slice(0, maxLength) + '\n[...truncated...]' : text,
            };
          });
      }

      if (messageType === 'human') {
        compressed.push(new HumanMessage({ content }));
      } else {
        compressed.push(msg.constructor ? new msg.constructor({ content }) : { ...msg, content });
      }
    }

    logger.info('[ContextCompressor] Compressed messages', {
      original: messages.length,
      compressed: compressed.length,
      reductionFactor,
    });

    return compressed;
  }

  /**
   * Estimates token reduction from compression
   * @param {Array} originalMessages
   * @param {Array} compressedMessages
   * @returns {number}
   */
  static estimateTokenReduction(originalMessages, compressedMessages) {
    const getContentLength = (msg) => {
      if (typeof msg.content === 'string') return msg.content.length;
      if (Array.isArray(msg.content)) {
        return msg.content.reduce((sum, part) => sum + (part.text?.length || 0), 0);
      }
      return 0;
    };

    const originalLength = originalMessages.reduce((sum, msg) => sum + getContentLength(msg), 0);
    const compressedLength = compressedMessages.reduce(
      (sum, msg) => sum + getContentLength(msg),
      0,
    );

    return originalLength > 0 ? 1 - compressedLength / originalLength : 0;
  }
}

class MessageCompressorBridge {
  constructor(options = {}) {
    this.reduction = options.reduction ?? 0.5;
    this.strategy = options.strategy ?? null;
  }

  async compress(message) {
    if (!message || typeof message.text !== 'string' || message.text.length === 0) {
      return null;
    }

    const text = message.text;
    const shouldTruncate = text.length > 2048;
    if (!shouldTruncate) {
      return text;
    }

    const targetLength = Math.max(512, Math.floor(text.length * (1 - this.reduction)));
    return `${text.slice(0, targetLength)}\n[...compressed...]`;
  }
}

module.exports = {
  ContextCompressor,
  CompressionStrategy,
  MessageCompressorBridge,
};
