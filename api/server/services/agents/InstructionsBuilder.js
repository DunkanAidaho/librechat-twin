const { logger } = require('@librechat/data-schemas');
const { Tokenizer } = require('@librechat/api');
const { SystemMessage } = require('@langchain/core/messages');

/**
 * Instructions Builder - handles instruction normalization and validation
 */
class InstructionsBuilder {
  constructor(options = {}) {
    this.defaultEncoding = options.defaultEncoding || 'o200k_base';
    this.fallbackPrompt = options.fallbackPrompt || 'You are a helpful assistant.';
  }

  /**
   * Resolves encoding from function or string
   * @param {(() => string)|string} getEncoding
   * @param {string} logPrefix
   * @returns {string}
   */
  resolveEncoding(getEncoding, logPrefix = '[InstructionsBuilder]') {
    if (typeof getEncoding === 'function') {
      try {
        const resolved = getEncoding();
        if (resolved) {
          return resolved;
        }
      } catch (error) {
        logger.warn(`${logPrefix} Failed to resolve encoding via function: ${error.message}`);
      }
    } else if (typeof getEncoding === 'string' && getEncoding.length > 0) {
      return getEncoding;
    }
    return this.defaultEncoding;
  }

  /**
   * Computes token count for text
   * @param {string} text
   * @param {string} encoding
   * @param {string} logPrefix
   * @returns {number}
   */
  computeTokens(text, encoding, logPrefix = '[InstructionsBuilder]') {
    if (!text) {
      return 0;
    }

    if (Tokenizer?.getTokenCount) {
      try {
        return Tokenizer.getTokenCount(text, encoding);
      } catch (error) {
        logger.warn(`${logPrefix} Failed to count tokens: ${error.message}`);
      }
    } else {
      logger.warn(`${logPrefix} Tokenizer unavailable, using string length as estimate.`);
    }

    return text.length;
  }

  /**
   * Normalizes instruction payload
   * @param {string|{content: string, tokenCount?: number}|null|undefined} rawInstructions
   * @param {(() => string)|string} getEncoding
   * @param {string} logPrefix
   * @returns {{content: string, tokenCount: number}}
   */
  normalizeInstructions(rawInstructions, getEncoding, logPrefix = '[InstructionsBuilder]') {
    const encoding = this.resolveEncoding(getEncoding, logPrefix);

    if (rawInstructions == null) {
      return { content: '', tokenCount: 0 };
    }

    if (typeof rawInstructions === 'object') {
      if (rawInstructions.content == null || typeof rawInstructions.content !== 'string') {
        logger.warn(`${logPrefix} Instructions object missing valid content property.`);
        return { content: '', tokenCount: 0 };
      }

      const tokenCount = this.computeTokens(rawInstructions.content, encoding, logPrefix);
      if (rawInstructions.tokenCount !== tokenCount) {
        logger.info(
          `${logPrefix} Recomputed instruction tokens. Length: ${rawInstructions.content.length}, Tokens: ${tokenCount}`,
        );
      }

      return {
        content: rawInstructions.content,
        tokenCount,
      };
    }

    if (typeof rawInstructions !== 'string') {
      logger.warn(`${logPrefix} Unsupported instructions type: ${typeof rawInstructions}`);
      return { content: '', tokenCount: 0 };
    }

    const tokenCount = this.computeTokens(rawInstructions, encoding, logPrefix);
    logger.info(
      `${logPrefix} Converted string instructions. Length: ${rawInstructions.length}, Tokens: ${tokenCount}`,
    );

    return {
      content: rawInstructions,
      tokenCount,
    };
  }

  /**
   * Builds system message from instructions
   * @param {string|SystemMessage|null} instructions
   * @param {string} additionalInstructions
   * @param {string} toolContext
   * @returns {SystemMessage|null}
   */
  buildSystemMessage(instructions, additionalInstructions = '', toolContext = '') {
    let instructionsForLangChain = null;

    if (typeof instructions === 'string' && instructions.length > 0) {
      instructionsForLangChain = new SystemMessage({ content: instructions });
    } else if (instructions instanceof SystemMessage) {
      instructionsForLangChain = instructions;
    }

    const systemContent = [toolContext, instructionsForLangChain?.content ?? '', additionalInstructions]
      .filter(Boolean)
      .join('\n')
      .trim();

    if (!systemContent) {
      return null;
    }

    if (instructionsForLangChain?.content !== systemContent || !instructionsForLangChain) {
      return new SystemMessage({ content: systemContent });
    }

    return instructionsForLangChain;
  }

  /**
   * Applies fallback prompt if needed
   * @param {string} systemContent
   * @param {Array} orderedMessages
   * @returns {string}
   */
  applyFallback(systemContent, orderedMessages = []) {
    if (orderedMessages.length === 0 && systemContent.length === 0) {
      logger.info('[InstructionsBuilder] Applied fallback systemContent for new chat');
      return this.fallbackPrompt;
    }
    return systemContent;
  }

  /**
   * Sanitizes instructions content
   * @param {string} content
   * @returns {string}
   */
  sanitize(content) {
    if (!content || typeof content !== 'string') {
      return '';
    }

    const cleaned = content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    return cleaned.replace(/\s+/g, ' ').trim();
  }

  /**
   * Validates instructions
   * @param {string} content
   * @param {Object} options
   * @returns {{valid: boolean, errors: string[]}}
   */
  validate(content, options = {}) {
    const errors = [];
    const maxLength = options.maxLength || 100000;
    const minLength = options.minLength || 0;

    if (typeof content !== 'string') {
      errors.push('Instructions must be a string');
      return { valid: false, errors };
    }

    if (content.length < minLength) {
      errors.push(`Instructions too short (min: ${minLength})`);
    }

    if (content.length > maxLength) {
      errors.push(`Instructions too long (max: ${maxLength})`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

module.exports = InstructionsBuilder;
