/**
 * Базовый класс для ошибок сервисов
 */
class ServiceError extends Error {
  /**
   * @param {string} message - Сообщение об ошибке
   * @param {string} code - Код ошибки
   * @param {Object} context - Контекст ошибки
   */
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Создает объект для логирования
   * @returns {Object} Объект с информацией об ошибке
   */
  toLog() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      stack: this.stack
    };
  }
}

/**
 * Ошибка валидации
 */
class ValidationError extends ServiceError {
  constructor(message, context = {}) {
    super(message, 'VALIDATION_ERROR', context);
    this.name = 'ValidationError';
  }
}

/**
 * Ошибка конфигурации
 */
class ConfigurationError extends ServiceError {
  constructor(message, context = {}) {
    super(message, 'CONFIGURATION_ERROR', context);
    this.name = 'ConfigurationError';
  }
}

/**
 * Ошибка ресурса (например, файл не найден)
 */
class ResourceError extends ServiceError {
  constructor(message, context = {}) {
    super(message, 'RESOURCE_ERROR', context);
    this.name = 'ResourceError';
  }
}

/**
 * Ошибка таймаута
 */
class TimeoutError extends ServiceError {
  constructor(message, context = {}) {
    super(message, 'TIMEOUT_ERROR', context);
    this.name = 'TimeoutError';
  }
}

/**
 * Ошибка очереди
 */
class QueueError extends ServiceError {
  constructor(message, context = {}) {
    super(message, 'QUEUE_ERROR', context);
    this.name = 'QueueError';
  }
}

/**
 * Ошибка кэша
 */
class CacheError extends ServiceError {
  constructor(message, context = {}) {
    super(message, 'CACHE_ERROR', context);
    this.name = 'CacheError';
  }
}

/**
 * Ошибка внешнего сервиса
 */
class ExternalServiceError extends ServiceError {
  constructor(message, context = {}) {
    super(message, 'EXTERNAL_SERVICE_ERROR', context);
    this.name = 'ExternalServiceError';
  }
}

/**
 * Ошибка состояния
 */
class StateError extends ServiceError {
  constructor(message, context = {}) {
    super(message, 'STATE_ERROR', context);
    this.name = 'StateError';
  }
}

/**
 * Утилиты для обработки ошибок
 */
const ErrorUtils = {
  /**
   * Оборачивает асинхронную функцию для обработки ошибок
   * @param {Function} fn - Асинхронная функция
   * @param {Object} context - Контекст для ошибки
   * @returns {Function} Обернутая функция
   */
  wrapAsync(fn, context = {}) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        if (error instanceof ServiceError) {
          throw error;
        }
        throw new ServiceError(error.message, 'INTERNAL_ERROR', {
          ...context,
          originalError: error
        });
      }
    };
  },

  /**
   * Проверяет, является ли ошибка определенного типа
   * @param {Error} error - Объект ошибки
   * @param {string} errorType - Тип ошибки
   * @returns {boolean} Является ли ошибка указанного типа
   */
  isErrorType(error, errorType) {
    return error instanceof ServiceError && error.code === errorType;
  },

  /**
   * Создает ошибку из ответа HTTP запроса
   * @param {Object} response - Ответ HTTP запроса
   * @param {Object} context - Дополнительный контекст
   * @returns {ServiceError} Ошибка соответствующего типа
   */
  fromResponse(response, context = {}) {
    const status = response?.status;
    const data = response?.data;

    const errorContext = {
      status,
      data,
      ...context
    };

    if (status === 400) {
      return new ValidationError(data?.message || 'Bad Request', errorContext);
    }
    if (status === 404) {
      return new ResourceError(data?.message || 'Not Found', errorContext);
    }
    if (status === 408 || status === 504) {
      return new TimeoutError(data?.message || 'Request Timeout', errorContext);
    }
    if (status >= 500) {
      return new ExternalServiceError(data?.message || 'Server Error', errorContext);
    }

    return new ServiceError(data?.message || 'Unknown Error', 'HTTP_ERROR', errorContext);
  }
};

module.exports = {
  ServiceError,
  ValidationError,
  ConfigurationError,
  ResourceError,
  TimeoutError,
  QueueError,
  CacheError,
  ExternalServiceError,
  StateError,
  ErrorUtils
};