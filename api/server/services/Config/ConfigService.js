'use strict';
const fs = require('fs');
const yaml = require('js-yaml');
const { z } = require('zod');

// Простая функция для логирования, чтобы избежать циклических зависимостей
const log = {
  info: (msg) => console.log(`[ConfigService] ${msg}`),
  warn: (msg) => console.warn(`[ConfigService] ${msg}`),
  error: (msg, err) => console.error(`[ConfigService] ${msg}`, err),
  debug: (msg) => process.env.NODE_ENV !== 'production' && console.log(`[ConfigService] ${msg}`)
};

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'y']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'n']);

function parseOptionalBool(value) {
  if (value == null || value === '') {
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  return undefined;
}

function parseOptionalInt(value) {
  if (value == null || value === '') {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseOptionalFloat(value) {
  if (value == null || value === '') {
    return undefined;
  }
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function splitStringList(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

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
      const configPath = process.env.CONFIG_PATH || './config/librechat.yaml';
      if (fs.existsSync(configPath)) {
        this.config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
        log.info('Configuration loaded successfully');
      } else {
        log.warn(`Config file not found at ${configPath}, using defaults`);
      }
      this.loadEnvVars();
    } catch (error) {
      log.error('Error loading configuration:', error);
      this.config = {};
    }
  }

  loadEnvVars() {
    this.config = {
      ...this.config,
      logging: {
        ...this.config.logging,
        branch: {
          enabled: parseOptionalBool(process.env.ENABLE_BRANCH_LOGGING) ?? false,
          level: process.env.BRANCH_LOG_LEVEL || 'info',
          ...this.config.logging?.branch
        }
      },
      memory: {
        ...this.config.memory,
        maxSize: parseOptionalInt(process.env.MEMORY_MAX_SIZE) ?? 500000,
        ...this.config.memory
      },
      features: {
        ...this.config.features,
        ...this.config.features
      },
      agents: {
        ...this.config.agents,
        ...this.config.agents
      }
    };
  }

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

  getBoolean(path, defaultValue = false) {
    const value = this.getValue(path);
    if (value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (TRUE_VALUES.has(normalized)) return true;
      if (FALSE_VALUES.has(normalized)) return false;
    }
    return defaultValue;
  }

  getNumber(path, defaultValue = 0) {
    const value = this.getValue(path);
    if (value === undefined) return defaultValue;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  getString(path, defaultValue = '') {
    const value = this.getValue(path);
    if (value === undefined) return defaultValue;
    return String(value);
  }

  getStringList(path, defaultValue = []) {
    const value = this.getValue(path);
    if (value === undefined) return defaultValue;
    if (Array.isArray(value)) return value.map(String);
    return splitStringList(value);
  }

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

  validate(schema) {
    try {
      return schema.parse(this.config);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message
        }));
        log.error('Configuration validation failed:', { issues });
      }
      throw error;
    }
  }
}

// Создаем и экспортируем единственный экземпляр ConfigService
const configService = new ConfigService();

// Экспортируем как объект для совместимости с другими сервисами
module.exports = {
  configService,
  ConfigService
};
