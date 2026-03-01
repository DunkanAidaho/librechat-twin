const BaseService = require('../Base/BaseService');
const { ValidationError } = require('../Base/ErrorHandler');

/**
 * Сервис для обработки сообщений
 * - Обработка истории сообщений
 * - Подготовка сообщений для индексации
 * - Управление окном сообщений
 */
class MessageProcessor extends BaseService {
  /**
   * @param {Object} options
   * @param {TokenManager} options.tokenManager - Менеджер токенов
   * @param {ContextCompressor} options.compressor - Компрессор контекста
   */
  constructor(options = {}) {
    super({ serviceName: 'messages', ...options });
    
    if (!options.tokenManager) {
      throw new ValidationError('TokenManager is required');
    }
    if (!options.compressor) {
      throw new ValidationError('ContextCompressor is required');
    }

    this.tokenManager = options.tokenManager;
    this.compressor = options.compressor;
    this.metrics = options.metrics;
  }

  /**
   * Обрабатывает историю сообщений
   * @param {Object} options
   * @param {Array<Object>} options.orderedMessages - Упорядоченные сообщения
   * @param {string} options.conversationId - ID диалога
   * @param {string} options.userId - ID пользователя
   * @param {number} options.histLongUserToRag - Порог для длинных сообщений пользователя
   * @param {number} options.assistLongToRag - Порог для длинных сообщений ассистента
   * @param {number} options.assistSnippetChars - Размер сниппета для длинных сообщений
   * @param {number} options.dontShrinkLastN - Количество последних сообщений, которые не нужно сжимать
   * @param {Object} options.trimmer - Инструмент для обрезки истории
   * @param {number} options.tokenBudget - Бюджет токенов
   * @param {number} options.contextHeadroom - Запас контекста
   * @returns {Promise<Object>} Результат обработки
   */
  async processMessageHistory(options) {
    const {
      orderedMessages,
      conversationId,
      userId,
      histLongUserToRag,
      assistLongToRag,
      assistSnippetChars,
      dontShrinkLastN,
      trimmer,
      tokenBudget,
      contextHeadroom
    } = options;

    const context = this.buildLogContext(null, {
      conversationId,
      userId,
      messageCount: orderedMessages.length
    });

    this.log('debug', '[messages.process.start]', context);

    try {
      // Подготовка сообщений для индексации
      const toIngest = [];
      const modifiedMessages = [...orderedMessages];
      let liveWindowStats = null;

      // Обработка длинных сообщений
      for (let i = 0; i < modifiedMessages.length; i++) {
        const message = modifiedMessages[i];
        const isUser = message.isCreatedByUser || message.role === 'user';
        const text = this.extractMessageText(message);
        const isLongMessage = isUser 
          ? text.length > histLongUserToRag
          : text.length > assistLongToRag;

        if (isLongMessage) {
          // Создаем задачу для индексации
          toIngest.push({
            type: 'add_turn',
            payload: {
              conversation_id: conversationId,
              message_id: message.messageId,
              role: isUser ? 'user' : 'assistant',
              content: text,
              user_id: userId,
              created_at: message.createdAt || new Date().toISOString()
            }
          });

          // Для сообщений ассистента оставляем сниппет
          if (!isUser && assistSnippetChars > 0) {
            modifiedMessages[i] = {
              ...message,
              text: text.slice(0, assistSnippetChars) + '...',
              isMemoryStored: true
            };
          }
        }
      }

      // Применяем сжатие истории если нужно
      if (trimmer && tokenBudget > 0) {
        const compressionResult = await this.compressor.compress(modifiedMessages, {
          keepLastN: dontShrinkLastN,
          tokenBudget,
          contextHeadroom
        });

        modifiedMessages.splice(0, modifiedMessages.length, ...compressionResult.messages);
        liveWindowStats = {
          mode: 'compressed',
          kept: compressionResult.keptCount,
          dropped: compressionResult.droppedCount
        };

        this.log('info', '[messages.compress.complete]', {
          ...context,
          keptCount: compressionResult.keptCount,
          droppedCount: compressionResult.droppedCount,
          compressionRatio: compressionResult.compressionRatio
        });
      }

      // Собираем метрики
      if (this.metrics) {
        const tokenCount = this.tokenManager.getMessagesTokenCount(modifiedMessages);
        this.metrics.observeTokens({
          segment: 'messages',
          tokens: tokenCount,
          type: liveWindowStats ? 'compressed' : 'raw'
        });
      }

      this.log('info', '[messages.process.complete]', {
        ...context,
        ingestCount: toIngest.length,
        finalCount: modifiedMessages.length
      });

      return {
        toIngest,
        modifiedMessages,
        liveWindowStats
      };
    } catch (error) {
      this.handleError(error, context);
    }
  }

  /**
   * Извлекает текст из сообщения
   * @param {Object} message - Сообщение
   * @param {Object} [options] - Опции
   * @returns {string} Текст сообщения
   */
  extractMessageText(message, options = {}) {
    const { silent = false } = options;
    const context = { messageId: message?.messageId };

    try {
      if (!message) {
        if (!silent) {
          this.log('warn', '[messages.extract.empty]', context);
        }
        return '';
      }

      // Проверяем text
      if (typeof message.text === 'string') {
        const trimmedText = message.text.trim();
        if (trimmedText.length > 0) {
          return message.text;
        }
      }

      // Проверяем content как строку
      if (typeof message.content === 'string') {
        const trimmedContent = message.content.trim();
        if (trimmedContent.length > 0) {
          return message.content;
        }
      }

      // Проверяем content как массив
      if (Array.isArray(message.content)) {
        return message.content
          .filter(part => part?.type === 'text' && typeof part.text === 'string')
          .map(part => part.text)
          .join('\n');
      }

      if (!silent) {
        this.log('warn', '[messages.extract.empty]', {
          ...context,
          contentType: typeof message.content
        });
      }
      return '';
    } catch (error) {
      if (!silent) {
        this.log('error', '[messages.extract.error]', {
          ...context,
          error: error.message
        });
      }
      return '';
    }
  }

  /**
   * Нормализует текст сообщения
   * @param {string} text - Исходный текст
   * @param {string} logPrefix - Префикс для логов
   * @returns {string} Нормализованный текст
   */
  normalizeMessageText(text, logPrefix = '[messages.normalize]') {
    if (text == null) {
      return '';
    }

    if (typeof text !== 'string') {
      this.log('warn', `${logPrefix}.invalid_type`, {
        type: typeof text
      });
      return '';
    }

    try {
      return this.tokenManager.normalizeText(text);
    } catch (error) {
      this.log('warn', `${logPrefix}.error`, {
        error: error.message
      });
      return text.trim();
    }
  }
}

module.exports = MessageProcessor;