const {
  observeSendMessage,
  incSendMessageFailure,
  observeMemoryQueueLatency,
  incMemoryQueueFailure,
  observeSummaryEnqueue,
  incSummaryEnqueueFailure,
  observeSegmentTokens,
  setContextLength,
  observeCache,
  observeCost
} = require('~/utils/metrics');

/**
 * Сервис для сбора и отправки метрик
 */
class MetricsCollector {
  /**
   * @param {Object} options
   * @param {string} options.serviceName - Имя сервиса для префикса метрик
   */
  constructor(options = {}) {
    this.serviceName = options.serviceName;
  }

  /**
   * Нормализует метки для метрик
   * @param {Object} labels - Исходные метки
   * @returns {Object} Нормализованные метки
   */
  normalizeLabels(labels = {}) {
    const normalized = {};
    for (const [key, value] of Object.entries(labels)) {
      normalized[key] = String(value)
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .slice(0, 100);
    }
    return normalized;
  }

  /**
   * Наблюдает за длительностью операции
   * @param {string} name - Имя метрики
   * @param {number} duration - Длительность в миллисекундах
   * @param {Object} labels - Метки
   */
  observeDuration(name, duration, labels = {}) {
    const normalizedLabels = this.normalizeLabels(labels);
    const metricName = `${this.serviceName}_${name}_duration_seconds`;
    const durationSeconds = duration / 1000;

    switch (name) {
      case 'send_message':
        observeSendMessage(normalizedLabels, durationSeconds);
        break;
      case 'memory_queue':
        observeMemoryQueueLatency(normalizedLabels, durationSeconds);
        break;
      case 'summary_enqueue':
        observeSummaryEnqueue(normalizedLabels, durationSeconds);
        break;
      default:
        // Для других метрик можно добавить свои обработчики
        break;
    }
  }

  /**
   * Увеличивает счетчик ошибок
   * @param {string} name - Имя метрики
   * @param {Object} labels - Метки
   */
  incrementErrorCount(name, labels = {}) {
    const normalizedLabels = this.normalizeLabels(labels);

    switch (name) {
      case 'send_message':
        incSendMessageFailure(normalizedLabels);
        break;
      case 'memory_queue':
        incMemoryQueueFailure(normalizedLabels);
        break;
      case 'summary_enqueue':
        incSummaryEnqueueFailure(normalizedLabels);
        break;
      default:
        // Для других метрик можно добавить свои обработчики
        break;
    }
  }

  /**
   * Наблюдает за использованием токенов
   * @param {Object} options
   * @param {string} options.segment - Сегмент (rag_graph, rag_vector и т.д.)
   * @param {number} options.tokens - Количество токенов
   * @param {string} options.endpoint - Эндпоинт
   * @param {string} options.model - Модель
   */
  observeTokens(options) {
    const { segment, tokens, endpoint, model } = options;
    observeSegmentTokens({ segment, tokens, endpoint, model });
  }

  /**
   * Устанавливает длину контекста
   * @param {Object} options
   * @param {string} options.segment - Сегмент
   * @param {number} options.length - Длина контекста
   * @param {string} options.endpoint - Эндпоинт
   * @param {string} options.model - Модель
   */
  setContextLength(options) {
    const { segment, length, endpoint, model } = options;
    setContextLength({ segment, length, endpoint, model });
  }

  /**
   * Наблюдает за кэшем
   * @param {string} status - Статус (hit/miss)
   */
  observeCache(status) {
    observeCache(status);
  }

  /**
   * Наблюдает за стоимостью
   * @param {Object} options
   * @param {string} options.endpoint - Эндпоинт
   * @param {string} options.model - Модель
   * @param {number} options.promptTokens - Токены промпта
   * @param {number} options.completionTokens - Токены ответа
   * @param {number} options.totalTokens - Общее количество токенов
   */
  observeCost(options) {
    const {
      endpoint,
      model,
      promptTokens,
      completionTokens,
      totalTokens
    } = options;

    observeCost({
      endpoint,
      model,
      promptTokens,
      completionTokens,
      totalTokens
    });
  }

  /**
   * Создает таймер для измерения длительности операции
   * @param {string} name - Имя метрики
   * @param {Object} labels - Метки
   * @returns {Function} Функция для остановки таймера
   */
  startTimer(name, labels = {}) {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      this.observeDuration(name, duration, labels);
      return duration;
    };
  }
}

module.exports = MetricsCollector;