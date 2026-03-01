const { getLogger } = require('../../../utils/logger');
const { buildContext, getRequestContext } = require('../../../utils/logContext');
const { configService } = require('../Config/ConfigService');

/**
 * Базовый класс для всех сервисов
 */
class BaseService {
  /**
   * @param {Object} options
   * @param {string} options.serviceName - Имя сервиса для логирования
   * @param {Object} [options.config] - Дополнительная конфигурация
   */
  constructor(options = {}) {
    const { serviceName, config = {}, skipConfig = false } = options;
    
    if (!serviceName) {
      throw new Error('Service name is required');
    }

    this.serviceName = serviceName;
    this.logger = getLogger(`services.${serviceName}`);
    
    // Загрузка конфигурации из ConfigService с возможностью переопределения
    if (!skipConfig) {
      this.config = {
        ...configService.getSection(serviceName),
        ...config
      };
    } else {
      this.config = config;
    }
  }

  /**
   * Создает контекст для логирования
   * @param {Object} req - Express request объект
   * @param {Object} additionalContext - Дополнительный контекст
   * @returns {Object} Контекст для логирования
   */
  buildLogContext(req, additionalContext = {}) {
    const requestContext = getRequestContext(req);
    return buildContext(requestContext, {
      service: this.serviceName,
      ...additionalContext
    });
  }

  /**
   * Получает значение таймаута для операции
   * @param {string} operationKey - Ключ операции
   * @returns {number} Таймаут в миллисекундах
   */
  getOperationTimeout(operationKey) {
    const defaultTimeout = 30000; // 30 секунд по умолчанию
    const timeouts = this.config.timeouts || {};
    return timeouts[operationKey] || defaultTimeout;
  }

  /**
   * Получает лимит для операции
   * @param {string} limitKey - Ключ лимита
   * @returns {number} Значение лимита
   */
  getOperationLimit(limitKey) {
    const defaultLimit = 1000;
    const limits = this.config.limits || {};
    return limits[limitKey] || defaultLimit;
  }
}

module.exports = {
  BaseService
};
