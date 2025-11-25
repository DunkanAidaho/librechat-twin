'use strict';

const configService = require('~/server/services/Config/ConfigService');
const { logger } = require('@librechat/data-schemas');
const { Tokenizer } = require('@librechat/api');

const DEFAULT_ENCODING = configService.get('agents.encoding.defaultTokenizerEncoding', 'o200k_base');

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
        logger.warn('%s Не удалось получить кодировку: %s', logPrefix, error?.message || error);
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
      logger.warn('%s Ошибка подсчёта токенов (%s): %s', logPrefix, encoding, error?.message || error);
    }
    return text.length;
  };

  if (rawInstructions == null) {
    return { content: '', tokenCount: 0 };
  }

  if (typeof rawInstructions === 'object') {
    if (typeof rawInstructions.content !== 'string' || rawInstructions.content.length === 0) {
      logger.warn('%s Объект инструкций без корректного поля content.', logPrefix);
      return { content: '', tokenCount: 0 };
    }
    const tokenCount = computeTokens(rawInstructions.content);
    if (rawInstructions.tokenCount != null && rawInstructions.tokenCount !== tokenCount) {
      logger.info(
        '%s Пересчитано количество токенов: было %d, стало %d.',
        logPrefix,
        rawInstructions.tokenCount,
        tokenCount,
      );
    }
    return {
      content: rawInstructions.content,
      tokenCount,
    };
  }

  if (typeof rawInstructions !== 'string') {
    logger.warn('%s Неподдерживаемый тип инструкций: %s', logPrefix, typeof rawInstructions);
    return { content: '', tokenCount: 0 };
  }

  const trimmed = rawInstructions.trim();
  if (!trimmed.length) {
    return { content: '', tokenCount: 0 };
  }

  const tokenCount = computeTokens(trimmed);
  logger.info(
    '%s Инструкции преобразованы в строку. Символов: %d, токенов: %d.',
    logPrefix,
    trimmed.length,
    tokenCount,
  );

  return {
    content: trimmed,
    tokenCount,
  };
}

module.exports = {
  normalizeInstructionsPayload,
};
