"use strict";

const { TextDecoder, TextEncoder } = require('util');
const LRU = require('lru-cache');
const { logger } = require('@librechat/data-schemas');
const { resolveLastProcessedConfig } = require('~/server/services/agents/lastProcessedConfig');
const { getOrCreateKV, isEnabled: isNatsEnabled } = require('~/utils/natsClient');
const {
  observeNatsKvLatency,
  incNatsKvError,
  incLastProcessedHit,
  incLastProcessedMiss,
  incLastProcessedPut,
} = require('~/utils/metrics');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DEFAULT_TIMEOUT_MS = 5000;

async function withTimeout(promise, timeoutMs, label) {
  const controller = new AbortController();
  const timeoutPromise = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timeout`));
    }, timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer));
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    controller.abort();
  }
}

class NatsKvLastProcessed {
  constructor() {
    this.kv = null;
    this.initializing = null;
    this.cache = new LRU({ max: 1000, ttl: 30_000 });
  }

  getConfig() {
    return resolveLastProcessedConfig();
  }

  getBucketConfig() {
    return this.getConfig();
  }

  async ensureKv() {
    if (this.kv) {
      return this.kv;
    }

    if (this.initializing) {
      return this.initializing;
    }

    this.initializing = (async () => {
      if (!isNatsEnabled()) {
        logger.warn('[nats.last_processed] NATS отключён → KV недоступен');
        this.kv = null;
        return null;
      }

      const { bucket, ttlMs, maxValueSize } = this.getBucketConfig();
      try {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            const kv = await withTimeout(
              getOrCreateKV(bucket, {
                ttl: ttlMs,
                history: 1,
                maxValueSize,
              }),
              DEFAULT_TIMEOUT_MS,
              'KV create',
            );
            this.kv = kv;
            if (!kv) {
              logger.error(`[nats.last_processed] KV bucket недоступен (bucket=${bucket})`);
            }
            logger.info(`[nats.last_processed] KV bucket создан/получен: ${bucket}`);
            return kv;
          } catch (error) {
            logger.warn(
              `[nats.last_processed] Попытка ${attempt} инициализации KV не удалась: ${error.message}`,
            );
            if (attempt === 3) {
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
          }
        }
      } catch (error) {
        logger.error(
          `[nats.last_processed] Ошибка инициализации KV (bucket=${bucket}): ${error.message}`,
        );
        this.kv = null;
        return null;
      } finally {
        if (this.kv) {
          this.initializing = null;
        }
      }
    })();

    return this.initializing;
  }

  async getLastProcessed(conversationId) {
    if (!conversationId) {
      incLastProcessedMiss('missing_id');
      return 0;
    }

    const cached = this.cache.get(conversationId);
    if (cached !== undefined) {
      if (cached === -1) {
        incLastProcessedMiss('cache_miss');
        return 0;
      }
      incLastProcessedHit('cache_hit');
      return cached;
    }

    const kv = await this.ensureKv();
    if (!kv) {
      incLastProcessedMiss('kv_unavailable');
      return 0;
    }

    const key = `dialog:${conversationId}`;
    const start = Date.now();
    try {
      const entry = await withTimeout(
        kv.get(key),
        DEFAULT_TIMEOUT_MS,
        'KV get',
      );
      observeNatsKvLatency('get', Date.now() - start);
      if (!entry?.value) {
        this.cache.set(conversationId, -1, 5000);
        incLastProcessedMiss('not_found');
        return 0;
      }
      const raw = decoder.decode(entry.value);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        incLastProcessedMiss('invalid_value');
        return 0;
      }
      incLastProcessedHit('kv_hit');
      this.cache.set(conversationId, parsed);
      return parsed;
    } catch (error) {
      observeNatsKvLatency('get', Date.now() - start);
      if (error?.name === 'AbortError') {
        incNatsKvError('get', 'timeout');
        logger.warn(`[withTimeout] Операция прервана по таймауту: KV get`);
      } else {
        incNatsKvError('get', error?.name || 'unknown');
        logger.error(
          `[nats.last_processed] KV get failed (key=${key}): ${error.message}`,
        );
      }
      return 0;
    }
  }

  async updateLastProcessed(conversationId, timestamp) {
    if (!conversationId) {
      return false;
    }

    if (!Number.isFinite(timestamp) || timestamp < 0) {
      logger.warn(
        `[nats.last_processed] Некорректный timestamp для ${conversationId}: ${timestamp}`,
      );
      return false;
    }

    const kv = await this.ensureKv();
    if (!kv) {
      incNatsKvError('put', 'kv_unavailable');
      return false;
    }

    const key = `dialog:${conversationId}`;
    const start = Date.now();
    try {
      await withTimeout(
        kv.put(key, encoder.encode(String(timestamp))),
        DEFAULT_TIMEOUT_MS,
        'KV put',
      );
      observeNatsKvLatency('put', Date.now() - start);
      incLastProcessedPut('ok');
      this.cache.set(conversationId, timestamp);
      return true;
    } catch (error) {
      observeNatsKvLatency('put', Date.now() - start);
      if (error?.name === 'AbortError') {
        incNatsKvError('put', 'timeout');
        logger.warn(`[withTimeout] Операция прервана по таймауту: KV put`);
      } else {
        incNatsKvError('put', error?.name || 'unknown');
        logger.error(
          `[nats.last_processed] KV put failed (key=${key}): ${error.message}`,
        );
      }
      this.cache.delete(conversationId);
      return false;
    }
  }
}

module.exports = { NatsKvLastProcessed };
