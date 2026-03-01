const BaseService = require('../Base/BaseService');
const { ValidationError } = require('../Base/ErrorHandler');
const { Tokenizer } = require('@librechat/api');

/**
 * Сервис для управления токенами
 * - Подсчет токенов для текста и сообщений
 * - Валидация лимитов токенов
 * - Нормализация текста
 */
class TokenManager extends BaseService {
  /**
   * @param {Object} options
   * @param {string} options.serviceName - Имя сервиса
   * @param {string} [options.defaultEncoding='o200k_base'] - Кодировка по умолчанию
   */
  constructor(options = {}) {
    super({ serviceName: options.serviceName || 'tokens', ...options });
    this.defaultEncoding = options.defaultEncoding || 'o200k_base';
  }

  /**
   * Подсчитывает токены для текста
   * @param {string} text - Текст для подсчета токенов
   * @param {string} [encoding] - Кодировка токенизатора
   * @returns {number} Количество токенов
   */
  getTokenCount(text, encoding = this.defaultEncoding) {
    const context = { encoding };

    try {
      if (!text) {
        return 0;
      }

      return Tokenizer.getTokenCount(text, encoding);
    } catch (error) {
      this.log('warn', '[tokens.count.error]', {
        ...context,
        error: error.message,
        textLength: text?.length
      });
      // Фоллбэк: используем длину строки как приближение
      return text.length;
    }
  }

  /**
   * Подсчитывает токены для сообщения
   * @param {Object} message - Сообщение
   * @param {string} [encoding] - Кодировка токенизатора
   * @returns {number} Количество токенов
   */
  getMessageTokenCount(message, encoding = this.defaultEncoding) {
    const context = { messageId: message?.messageId };

    try {
      if (!message) {
        return 0;
      }

      // Подсчет токенов для текста сообщения
      let totalTokens = 0;

      // Обработка обычного текста
      if (typeof message.text === 'string') {
        totalTokens += this.getTokenCount(message.text, encoding);
      }

      // Обработка контента в виде массива
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            totalTokens += this.getTokenCount(part.text, encoding);
          }
        }
      }

      // Обработка контента в виде строки
      if (typeof message.content === 'string') {
        totalTokens += this.getTokenCount(message.content, encoding);
      }

      // Добавляем токены для метаданных роли
      if (message.role) {
        totalTokens += this.getTokenCount(message.role, encoding);
      }

      return totalTokens;
    } catch (error) {
      this.log('error', '[tokens.message.error]', {
        ...context,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Подсчитывает токены для массива сообщений
   * @param {Array<Object>} messages - Массив сообщений
   * @param {string} [encoding] - Кодировка токенизатора
   * @returns {number} Общее количество токенов
   */
  getMessagesTokenCount(messages, encoding = this.defaultEncoding) {
    if (!Array.isArray(messages)) {
      return 0;
    }

    return messages.reduce((total, message) => 
      total + this.getMessageTokenCount(message, encoding), 0);
  }

  /**
   * Проверяет, не превышает ли количество токенов лимит
   * @param {number} tokenCount - Количество токенов
   * @param {number} limit - Лимит токенов
   * @returns {boolean} В пределах лимита или нет
   */
  validateTokenLimit(tokenCount, limit) {
    return tokenCount <= limit;
  }

  /**
   * Проверяет сообщения на соответствие лимиту токенов
   * @param {Array<Object>} messages - Массив сообщений
   * @param {number} limit - Лимит токенов
   * @param {string} [encoding] - Кодировка токенизатора
   * @throws {ValidationError} Если превышен лимит токенов
   */
  validateMessages(messages, limit, encoding = this.defaultEncoding) {
    const tokenCount = this.getMessagesTokenCount(messages, encoding);
    
    if (!this.validateTokenLimit(tokenCount, limit)) {
      throw new ValidationError('Token limit exceeded', {
        tokenCount,
        limit,
        encoding
      });
    }
  }

  /**
   * Нормализует текст для подсчета токенов
   * @param {string} text - Исходный текст
   * @returns {string} Нормализованный текст
   */
  normalizeText(text) {
    if (!text) {
      return '';
    }

    try {
      // Нормализация Unicode
      let normalized = text.normalize('NFC');
      
      // Удаление невидимых управляющих символов
      normalized = normalized.replace(
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
        ''
      );

      // Замена множественных пробелов и переносов строк
      normalized = normalized
        .replace(/\s+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      return normalized;
    } catch (error) {
      this.log('warn', '[tokens.normalize.error]', {
        error: error.message,
        textLength: text.length
      });
      return text;
    }
  }

  /**
   * Получает кодировку токенизатора
   * @returns {string} Текущая кодировка
   */
  getEncoding() {
    return this.defaultEncoding;
  }
}

module.exports = TokenManager;