'use strict';

const path = require('path');
const fs = require('fs');
const { createLogger, format, transports, addColors } = require('winston');

const configService = require('~/server/services/Config/ConfigService');
const { sanitizeInput } = require('../security');

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

addColors({
  error: 'bold red',
  warn: 'yellow',
  info: 'green',
  debug: 'blue',
  trace: 'magenta',
});

const DEFAULT_STRING_LIMIT = 2000;
const loggingConfigCache = {
  hash: null,
  logger: null,
};

function ensureDirectory(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[logger] Failed to ensure log directory', error);
  }
}

function buildFormats(loggingConfig) {
  if (loggingConfig.format === 'json') {
    return format.combine(format.timestamp(), format.errors({ stack: true }), format.json());
  }

  const formats = [format.timestamp(), format.errors({ stack: true })];
  if (loggingConfig.console?.colorize) {
    formats.push(format.colorize({ all: true }));
  }
  formats.push(
    format.printf(({ timestamp, level, message, scope, ...rest }) => {
      const meta = { ...rest };
      const context = meta.context ? JSON.stringify(meta.context) : '';
      delete meta.context;
      const remaining = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
      return [timestamp, scope ? `[${scope}]` : '', level + ':', message, context, remaining]
        .filter(Boolean)
        .join(' ');
    }),
  );

  return format.combine(...formats);
}

function buildTransports(loggingConfig) {
  const transportList = [
    new transports.Console({
      level: loggingConfig.globalLevel,
      format: buildFormats(loggingConfig),
    }),
  ];

  if (loggingConfig.file?.enabled) {
    const filePath = loggingConfig.file.path || './logs/librechat.log';
    ensureDirectory(filePath);
    transportList.push(
      new transports.File({
        filename: filePath,
        level: loggingConfig.globalLevel,
        format: format.combine(format.timestamp(), format.errors({ stack: true }), format.json()),
      }),
    );
  }

  return transportList;
}

function getLoggingConfigHash(loggingConfig) {
  return JSON.stringify({
    level: loggingConfig.globalLevel,
    format: loggingConfig.format,
    consoleColorize: loggingConfig.console?.colorize,
    file: loggingConfig.file,
  });
}

function baseLogger() {
  const loggingConfig = configService.getSection('logging');
  const hash = getLoggingConfigHash(loggingConfig);

  if (loggingConfigCache.logger && loggingConfigCache.hash === hash) {
    return loggingConfigCache.logger;
  }

  const logger = createLogger({
    levels: LOG_LEVELS,
    level: loggingConfig.globalLevel,
    defaultMeta: { service: 'librechat-api' },
    transports: buildTransports(loggingConfig),
  });

  loggingConfigCache.logger = logger;
  loggingConfigCache.hash = hash;
  return logger;
}

function clipString(value, limit = DEFAULT_STRING_LIMIT) {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}…`;
}

function sanitizeUserString(input) {
  return clipString(sanitizeInput(input));
}

function formatError(err) {
  return {
    name: err.name,
    message: sanitizeUserString(err.message || ''),
    stack: err.stack ? clipString(err.stack, 4000) : undefined,
  };
}

function coerceMetaValue(value) {
  if (value == null) {
    return value;
  }

  if (value instanceof Error) {
    return formatError(value);
  }

  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    return sanitizeUserString(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return value;
    }
    if (value.every((item) => typeof item === 'string')) {
      return sanitizeUserString(value.join('\n'));
    }
    return `[array:${value.length}]`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'object') {
    const label = value.constructor?.name || 'Object';
    return `[object:${label}]`;
  }

  return value;
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return undefined;
  }

  const safeMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    safeMeta[key] = coerceMetaValue(value);
  }
  return safeMeta;
}

function wrapLogger(loggerInstance) {
  const proxy = {};

  const logFn = (level, message, meta) => {
    const safeMeta = sanitizeMeta(meta);
    if (safeMeta) {
      loggerInstance.log(level, message, safeMeta);
    } else {
      loggerInstance.log(level, message);
    }
  };

  for (const level of Object.keys(LOG_LEVELS)) {
    proxy[level] = (message, meta) => logFn(level, message, meta);
  }

  proxy.log = (level, message, meta) => logFn(level, message, meta);
  proxy.child = (defaults = {}) => wrapLogger(loggerInstance.child(defaults));
  proxy.raw = loggerInstance;

  return proxy;
}

function createScopedLogger(scope, defaults = {}) {
  const logger = baseLogger().child({ scope, ...defaults });
  return wrapLogger(logger);
}

function getLogger(scope = 'app') {
  return createScopedLogger(scope);
}

function isTraceEnabled() {
  const loggingConfig = configService.getSection('logging');
  return Boolean(loggingConfig.tracePipeline || loggingConfig.features?.tracePipeline);
}

module.exports = {
  getLogger,
  createScopedLogger,
  sanitizeMeta,
  sanitizeUserString,
  isTraceEnabled,
};