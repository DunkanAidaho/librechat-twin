'use strict';

const { configService } = require('../../../server/services/Config/ConfigService');
const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');
const { Tokenizer } = require('@librechat/api');

// Загрузка конфигурации кодировки
let DEFAULT_ENCODING;
const logger = getLogger('clients.instructions');

try {
  DEFAULT_ENCODING = configService.get('agents.encoding.defaultTokenizerEncoding', 'o200k_base');
  logger.debug('Loaded default tokenizer encoding', { encoding: DEFAULT_ENCODING });
} catch (err) {
  logger.error('Failed to load default tokenizer encoding, using fallback', {
    error: err.message,
    fallbackEncoding: 'o200k_base'
  });
  DEFAULT_ENCODING = 'o200k_base';
}

/**
 * Преобразует произвольный формат инструкций в объект с содержимым и числом токенов.
 *
 * @param {string | {content: string, tokenCount?: number} | null | undefined} rawInstructions
 *   Исходное значение инструкций.
 * @param {(() => string) | string} encodingResolver
 *   Функция или строка с названием кодировки токенизатора (например, 'o200k_base').
 * @param {string} [logPrefix='[Instructions]']
 *   Префикс для сообщений журнала.
 * @returns {{ content: string, tokenCount: number }}
 *   Нормализованный объект инструкций.
 */
function normalizeInstructionsPayload(rawInstructions, encodingResolver, logPrefix = '[Instructions]') {
  const resolveEncoding = () => {
    if (typeof encodingResolver === 'function') {
      try {
        const resolved = encodingResolver();
        if (resolved) {
          return resolved;
        }
      } catch (error) {
        logger.warn(
          'clients.instructions.encoding_resolve_failed',
          buildContext({ logPrefix }, { err: { message: error?.message || String(error) } }),
        );
      }
    } else if (typeof encodingResolver === 'string' && encodingResolver.length > 0) {
      return encodingResolver;
    }
    return DEFAULT_ENCODING;
  };

  const encoding = resolveEncoding();

  /**
   * Вычисляет количество токенов для текста.
   *
   * @param {string} text
   * @returns {number}
   */
  const computeTokens = (text) => {
    if (!text) {
      return 0;
    }
    try {
      return Tokenizer.getTokenCount(text, encoding);
    } catch (error) {
      logger.warn(
        'clients.instructions.token_count_failed',
        buildContext({ logPrefix }, { encoding, err: { message: error?.message || String(error) } }),
      );
    }
    return text.length;
  };

  if (rawInstructions == null) {
    return { content: '', tokenCount: 0 };
  }

  if (typeof rawInstructions === 'object') {
    if (typeof rawInstructions.content !== 'string' || rawInstructions.content.length === 0) {
      logger.warn(
        'clients.instructions.content_missing',
        buildContext({ logPrefix }, {}),
      );
      return { content: '', tokenCount: 0 };
    }
    const tokenCount = computeTokens(rawInstructions.content);
    if (rawInstructions.tokenCount != null && rawInstructions.tokenCount !== tokenCount) {
      const previousTokens = rawInstructions.tokenCount;
      logger.info(
        'clients.instructions.tokens_recomputed',
        buildContext({ logPrefix }, { previousTokens, tokenCount, length: rawInstructions.content.length }),
      );
    }
    return {
      content: rawInstructions.content,
      tokenCount,
    };
  }

  if (typeof rawInstructions !== 'string') {
    logger.warn(
      'clients.instructions.type_unsupported',
      buildContext({ logPrefix }, { type: typeof rawInstructions }),
    );
    return { content: '', tokenCount: 0 };
  }

  const trimmed = rawInstructions.trim();
  if (!trimmed.length) {
    return { content: '', tokenCount: 0 };
  }

  const tokenCount = computeTokens(trimmed);
  logger.info(
    'clients.instructions.string_normalized',
    buildContext({ logPrefix }, { length: trimmed.length, tokenCount }),
  );

  return {
    content: trimmed,
    tokenCount,
  };
}

module.exports = {
  normalizeInstructionsPayload,
};
