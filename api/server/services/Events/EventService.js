const BaseService = require('../Base/BaseService');

/**
 * Сервис для отправки событий клиенту через SSE
 */
class EventService extends BaseService {
  constructor() {
    super({ serviceName: 'EventService' });
  }

  /**
   * Отправляет событие клиенту
   * @param {Response} res - Express response объект
   * @param {Object} event - Событие для отправки
   */
  sendEvent(res, event) {
    if (!res || !event) {
      this.logger.error('Invalid event parameters', { event });
      return;
    }

    try {
      const formattedEvent = this.formatEvent(event);
      res.write(formattedEvent);
      this.logger.debug('Event sent successfully', { event });
    } catch (error) {
      this.logger.error('Failed to send event', { error, event });
    }
  }

  /**
   * Форматирует событие для отправки
   * @param {Object} event - Событие для форматирования
   * @returns {String} Форматированное событие
   */
  formatEvent(event) {
    const eventString = JSON.stringify(event);
    return `event: message\ndata: ${eventString}\n\n`;
  }

  /**
   * Отправляет событие завершения
   * @param {Response} res - Express response объект
   */
  sendCompletionEvent(res) {
    this.sendEvent(res, { type: 'done' });
  }

  /**
   * Отправляет событие ошибки
   * @param {Response} res - Express response объект
   * @param {Error} error - Объект ошибки
   */
  sendErrorEvent(res, error) {
    const errorEvent = {
      type: 'error',
      error: {
        message: error.message,
        code: error.code || 'UNKNOWN_ERROR',
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      }
    };
    
    this.sendEvent(res, errorEvent);
  }

  /**
   * Отправляет событие подтверждения
   * @param {Response} res - Express response объект
   * @param {Object} metadata - Метаданные для подтверждения
   */
  sendAcknowledgement(res, metadata = {}) {
    const ackEvent = {
      type: 'acknowledgement',
      ...metadata
    };
    
    this.sendEvent(res, ackEvent);
  }
}

module.exports = {
  EventService
};