'use strict';

const { logger } = require('@librechat/data-schemas');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parsePositiveInt(value, defaultValue) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : defaultValue;
}

function calculateTtlMs(ttlDays, defaultDays = 30) {
  const days = parsePositiveInt(ttlDays, defaultDays);
  return days * MS_PER_DAY;
}

function resolveLastProcessedConfig({ env = process.env } = {}) {
  const ttlDays = parsePositiveInt(env.RAG_LAST_PROCESSED_TTL_DAYS, 30);
  if (ttlDays > 365) {
    logger.warn(
      `[lastProcessedConfig] TTL ${ttlDays} дней превышает рекомендуемый максимум (365)`,
    );
  }
  const ttlMs = calculateTtlMs(ttlDays);
  const bucket = env.RAG_LAST_PROCESSED_BUCKET?.trim() || 'rag_last_processed';
  if (!env.RAG_LAST_PROCESSED_BUCKET || !env.RAG_LAST_PROCESSED_BUCKET.trim()) {
    logger.warn('[lastProcessedConfig] Bucket не может быть пустой строкой, используется дефолт');
  }
  const maxValueSize = parsePositiveInt(env.RAG_LAST_PROCESSED_MAX_VALUE_SIZE, 256);
  logger.info(
    `[lastProcessedConfig] Конфигурация KV: bucket=${bucket}, ttlMs=${ttlMs}, maxValueSize=${maxValueSize} (источник: ${env.RAG_LAST_PROCESSED_MAX_VALUE_SIZE ? 'ENV' : 'default'})`,
  );
  return {
    bucket,
    ttlMs,
    maxValueSize,
  };
}

module.exports = { resolveLastProcessedConfig };
