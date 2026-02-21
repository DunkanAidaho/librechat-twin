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
const DEFAULT_STRUCTURED_OPTIONS = {
  depthLimit: 2,
  maxArrayItems: 20,
  maxObjectKeys: 25,
};
const CONTEXT_STRUCTURED_OPTIONS = {
  depthLimit: 3,
  maxArrayItems: 20,
  maxObjectKeys: 25,
};
const loggingConfigCache = {
  hash: null,
  logger: null,
  rawConfig: null,
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

function buildPrettyFormat(loggingConfig) {
  const formats = [format.timestamp(), format.errors({ stack: true })];
  if (loggingConfig.console?.colorize) {
    formats.push(format.colorize({ all: true }));
  }

  formats.push(
    format.printf(({ timestamp, level, message, scope, ...rest }) => {
      const meta = { ...rest };
      let context = '';
      if (meta.context != null) {
        if (typeof meta.context === 'object') {
          try {
            context = JSON.stringify(meta.context);
          } catch (_) {
            context = '[context:unserializable]';
          }
        } else {
          context = String(meta.context);
        }
      }
      delete meta.context;

      let remaining = '';
      if (Object.keys(meta).length > 0) {
        try {
          remaining = JSON.stringify(meta);
        } catch (_) {
          remaining = '[meta:unserializable]';
        }
      }

      return [timestamp, scope ? `[${scope}]` : '', level + ':', message, context, remaining]
        .filter(Boolean)
        .join(' ');
    }),
  );

  return format.combine(...formats);
}

function buildFormats(loggingConfig) {
  if (loggingConfig.format === 'json') {
    return format.combine(format.timestamp(), format.errors({ stack: true }), format.json());
  }
  return buildPrettyFormat(loggingConfig);
}

function buildTransports(loggingConfig) {
  const transportList = [];

  transportList.push(
    new transports.Console({
      level: loggingConfig.globalLevel,
      format: buildFormats(loggingConfig),
    }),
  );

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
    loggingConfigCache.rawConfig = loggingConfig;
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
  loggingConfigCache.rawConfig = loggingConfig;
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

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value) || isPlainObject(value)) {
    return sanitizePlainObject(value, DEFAULT_STRUCTURED_OPTIONS);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const label = value.constructor?.name || 'Object';
  return `[object:${label}]`;
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return undefined;
  }

  const safeMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key === 'context') {
      safeMeta[key] = sanitizePlainObject(value, CONTEXT_STRUCTURED_OPTIONS);
      continue;
    }
    safeMeta[key] = coerceMetaValue(value, DEFAULT_STRUCTURED_OPTIONS);
  }
  return safeMeta;
}

function isPlainObject(value) {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizePlainObject(value, options = {}, state) {
  const merged = {
    depthLimit: options.depthLimit ?? DEFAULT_STRUCTURED_OPTIONS.depthLimit,
    maxArrayItems: options.maxArrayItems ?? DEFAULT_STRUCTURED_OPTIONS.maxArrayItems,
    maxObjectKeys: options.maxObjectKeys ?? DEFAULT_STRUCTURED_OPTIONS.maxObjectKeys,
  };

  const contextState = state || {
    depth: 0,
    path: '$',
    visited: new WeakSet(),
  };

  return sanitizeStructured(value, merged, contextState);
}

function sanitizeStructured(value, options, state) {
  if (value == null) {
    return value;
  }

  const valueType = typeof value;

  if (value instanceof Error) {
    return formatError(value);
  }

  if (valueType === 'string' || Buffer.isBuffer(value)) {
    return sanitizeUserString(value);
  }

  if (valueType === 'number' || valueType === 'boolean') {
    return value;
  }

  if (valueType === 'bigint') {
    return value.toString();
  }

  if (valueType === 'symbol') {
    return value.toString();
  }

  if (valueType === 'function') {
    return `[function:${value.name || 'anonymous'}]`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (valueType !== 'object') {
    return value;
  }

  if (state.visited.has(value)) {
    return { __type: 'circular', ref: state.path };
  }

  if (Array.isArray(value)) {
    if (state.depth >= options.depthLimit) {
      return { __type: 'array', length: value.length };
    }

    state.visited.add(value);
    try {
      if (value.length > options.maxArrayItems) {
        return { __type: 'array', length: value.length, truncated: true };
      }

      return value.map((item, index) =>
        sanitizeStructured(item, options, {
          ...state,
          depth: state.depth + 1,
          path: `${state.path}[${index}]`,
        }),
      );
    } finally {
      state.visited.delete(value);
    }
  }

  if (isPlainObject(value)) {
    if (state.depth >= options.depthLimit) {
      return { __type: 'object', keys: Object.keys(value).length };
    }

    state.visited.add(value);
    try {
      const keys = Object.keys(value);
      if (keys.length > options.maxObjectKeys) {
        return { __type: 'truncated', keys: keys.length };
      }

      const result = {};
      for (const key of keys) {
        result[key] = sanitizeStructured(value[key], options, {
          ...state,
          depth: state.depth + 1,
          path: `${state.path}.${key}`,
        });
      }
      return result;
    } finally {
      state.visited.delete(value);
    }
  }

  const label = value.constructor?.name || 'Object';
  return `[object:${label}]`;
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
  const loggingConfig = loggingConfigCache.rawConfig || configService.getSection('logging');
  return Boolean(loggingConfig.tracePipeline || loggingConfig.features?.tracePipeline);
}

function getLoggingConfig() {
  return loggingConfigCache.rawConfig || configService.getSection('logging');
}

module.exports = {
  getLogger,
  createScopedLogger,
  sanitizeMeta,
  sanitizeUserString,
  sanitizePlainObject,
  isTraceEnabled,
  getLoggingConfig,
};