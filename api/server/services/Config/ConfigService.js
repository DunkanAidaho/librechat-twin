'use strict';
const fs = require('fs');
const yaml = require('js-yaml');

// Простая функция для логирования, чтобы избежать циклических зависимостей
const log = {
  info: (msg) => console.log(`[ConfigService] ${msg}`),
  warn: (msg) => console.warn(`[ConfigService] ${msg}`),
  error: (msg, err) => console.error(`[ConfigService] ${msg}`, err),
  debug: (msg) => process.env.NODE_ENV !== 'production' && console.log(`[ConfigService] ${msg}`)
};

class ConfigService {
  constructor() {
    if (!ConfigService.instance) {
      this.config = {};
      this.loadConfig();
      ConfigService.instance = this;
    }
    return ConfigService.instance;
  }

  loadConfig() {
    try {
      // Загрузка конфигурации из файла
      const configPath = process.env.CONFIG_PATH || './config/librechat.yaml';
      if (fs.existsSync(configPath)) {
        this.config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
        log.info('Configuration loaded successfully');
      } else {
        log.warn(`Config file not found at ${configPath}, using defaults`);
      }

      // Загрузка переменных окружения
      this.loadEnvVars();
    } catch (error) {
      log.error('Error loading configuration:', error);
      this.config = {};
    }
  }

  loadEnvVars() {
    // Добавляем базовые секции, если их нет
    this.config.logging = this.config.logging || {};
    this.config.logging.branch = this.config.logging.branch || {};
    
    // Устанавливаем значения по умолчанию для логирования
    this.config.logging.branch.enabled = process.env.ENABLE_BRANCH_LOGGING === 'true' || false;
    this.config.logging.branch.level = process.env.BRANCH_LOG_LEVEL || 'info';
    
    // Другие настройки по умолчанию
    this.config.memory = this.config.memory || {};
    this.config.features = this.config.features || {};
    this.config.agents = this.config.agents || {};
  }

  /**
   * Получает секцию конфигурации по имени
   * @param {string} name - Имя секции
   * @returns {Object} Конфигурация секции
   */
  getSection(name) {
    if (!name) {
      log.warn('Attempted to get config section with empty name');
      return {};
    }

    const section = this.config[name];
    if (!section) {
      log.debug(`Config section "${name}" not found, returning empty object`);
      return {};
    }

    return section;
  }

  /**
   * Получает числовое значение из конфигурации
   * @param {string} path - Путь к значению (например, "memory.maxSize")
   * @param {number} defaultValue - Значение по умолчанию
   * @returns {number} Значение из конфигурации или значение по умолчанию
   */
  getNumber(path, defaultValue) {
    const value = this.getValue(path);
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  /**
   * Получает булево значение из конфигурации
   * @param {string} path - Путь к значению
   * @param {boolean} defaultValue - Значение по умолчанию
   * @returns {boolean} Значение из конфигурации или значение по умолчанию
   */
  getBoolean(path, defaultValue) {
    const value = this.getValue(path);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true' || value === '1';
    }
    return defaultValue;
  }

  /**
   * Получает значение по пути в конфигурации
   * @param {string} path - Путь к значению
   * @returns {any} Значение из конфигурации
   */
  getValue(path) {
    if (!path) return undefined;
    
    const parts = path.split('.');
    let current = this.config;
    
    for (const part of parts) {
      if (current === undefined || current === null) return undefined;
      current = current[part];
    }
    
    return current;
  }
}

// Создаем и экспортируем единственный экземпляр ConfigService
const configService = new ConfigService();

// Экспортируем как объект для совместимости с другими сервисами
module.exports = {
  configService,
  ConfigService // Экспортируем также класс для тестирования
};
