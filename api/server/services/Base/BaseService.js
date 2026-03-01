const { getLogger } = require('~/utils/logger');
const { buildContext, getRequestContext } = require('~/utils/logContext');
const configService = require('~/server/services/Config/ConfigService');

/**
 * Базовый класс для всех сервисов, обеспечивающий:
 * - Логирование через scoped логгер
 * - Обработку ошибок
 * - Доступ к конфигурации
 * - Построение контекста для логов
 */
class BaseService {
  /**
   * @param {Object} options
   * @param {string} options.serviceName - Имя сервиса для логирования
   * @param {Object} [options.config] - Дополнительная конфигурация
   */
  constructor(options = {}) {
    const { serviceName, config = {} } = options;
    
    if (!serviceName) {
      throw new Error('Service name is required');
    }

    this.serviceName = serviceName;
    this.logger = getLogger(`services.${serviceName}`);
    
    // Загрузка конфигурации из ConfigService с возможностью переопределения
    this.config = {
      ...configService.getSection(serviceName),
      ...config
    };
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
   * Логирование с контекстом
   * @param {string} level - Уровень логирования (debug/info/warn/error)
   * @param {string} message - Сообщение для лога
   * @param {Object} [context] - Дополнительный контекст
   */
  log(level, message, context = {}) {
    if (typeof this.logger[level] !== 'function') {
      this.logger.warn(`Invalid log level: ${level}`);
      return;
    }

    const logContext = {
      service: this.serviceName,
      ...context
    };

    this.logger[level](message, logContext);
  }

  /**
   * Обработка ошибок с контекстом
   * @param {Error} error - Объект ошибки
   * @param {Object} context - Контекст ошибки
   * @throws {Error} Проброс ошибки после логирования
   */
  handleError(error, context = {}) {
    const errorContext = {
      service: this.serviceName,
      error: error?.message || error,
      stack: error?.stack,
      code: error?.code,
      ...context
    };

    this.log('error', `[${this.serviceName}] Error`, errorContext);
    throw error;
  }

  /**
   * Безопасное получение значения конфигурации
   * @param {string} key - Ключ конфигурации
   * @param {*} defaultValue - Значение по умолчанию
   * @returns {*} Значение конфигурации или значение по умолчанию
   */
  getConfig(key, defaultValue) {
    return this.config[key] ?? defaultValue;
  }

  /**
   * Проверяет, включена ли определенная функциональность
   * @param {string} featureKey - Ключ функциональности
   * @returns {boolean} Включена ли функциональность
   */
  isFeatureEnabled(featureKey) {
    return Boolean(this.getConfig(`features.${featureKey}`, false));
  }

  /**
   * Получает таймаут для операции
   * @param {string} operationKey - Ключ операции
   * @returns {number} Таймаут в миллисекундах
   */
  getOperationTimeout(operationKey) {
    return Number(this.getConfig(`timeouts.${operationKey}`, 30000));
  }

  /**
   * Получает лимит для операции
   * @param {string} limitKey - Ключ лимита
   * @returns {number} Значение лимита
   */
  getOperationLimit(limitKey) {
    return Number(this.getConfig(`limits.${limitKey}`, 1000));
  }
}

module.exports = BaseService;
