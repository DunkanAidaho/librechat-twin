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
    this.lastPutAt = 0;
    this.lastPutValue = 0;
    this.pendingPut = null;
    this.pendingTimer = null;
    this.backoffUntil = 0;
  }

  getConfig() {
    return resolveLastProcessedConfig();
  }

  getBucketConfig() {
    return this.getConfig();
  }

  getThrottleConfig() {
    const cfg = this.getConfig();
    return {
      minPutIntervalMs: Math.max(Number(cfg.minPutIntervalMs ?? 3000), 0),
      minPutDeltaMs: Math.max(Number(cfg.minPutDeltaMs ?? 2000), 0),
      backoffMaxMs: Math.max(Number(cfg.backoffMaxMs ?? 5000), 0),
    };
  }

  applyBackoff(error) {
    const { backoffMaxMs } = this.getThrottleConfig();
    if (!backoffMaxMs) {
      return;
    }
    const now = Date.now();
    const base = 200;
    const jitter = Math.floor(Math.random() * 200);
    const nextDelay = Math.min(backoffMaxMs, Math.max(base, this.backoffUntil - now + base) + jitter);
    this.backoffUntil = now + nextDelay;
    logger.warn(
      `[nats.last_processed] KV put backoff ${nextDelay}ms (error=${error?.message || error})`,
    );
  }

  schedulePut(conversationId, timestamp) {
    const { minPutIntervalMs } = this.getThrottleConfig();
    this.pendingPut = { conversationId, timestamp };
    if (this.pendingTimer) {
      return;
    }
    const now = Date.now();
    const delay = Math.max(minPutIntervalMs - (now - this.lastPutAt), 0);
    this.pendingTimer = setTimeout(async () => {
      this.pendingTimer = null;
      const pending = this.pendingPut;
      this.pendingPut = null;
      if (!pending) return;
      await this.performPut(pending.conversationId, pending.timestamp, true);
    }, delay);
  }

  async performPut(conversationId, timestamp, isDeferred = false) {
    const now = Date.now();
    if (now < this.backoffUntil) {
      if (!isDeferred) {
        this.schedulePut(conversationId, timestamp);
      }
      return false;
    }

    const kv = await this.ensureKv();
    if (!kv) {
      incNatsKvError('put', 'kv_unavailable');
      return false;
    }

    const key = `dialog.${conversationId}`;
    logger.debug(
      `[nats.last_processed] KV put key=${key} bucket=${this.getBucketConfig().bucket} deferred=${isDeferred} ts=${timestamp}`,
    );
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
      this.lastPutAt = Date.now();
      this.lastPutValue = timestamp;
      this.backoffUntil = 0;
      return true;
    } catch (error) {
      observeNatsKvLatency('put', Date.now() - start);
      const code = error?.code || error?.status || error?.statusCode || 'n/a';
      const message = error?.message || error;
      if (error?.name === 'AbortError') {
        incNatsKvError('put', 'timeout');
        logger.warn(`[withTimeout] Операция прервана по таймауту: KV put`);
      } else {
        incNatsKvError('put', error?.name || 'unknown');
        logger.error(
          `[nats.last_processed] KV put failed (key=${key}, bucket=${this.getBucketConfig().bucket}, code=${code}): ${message}`,
        );
      }
      if (typeof this.cache.delete === 'function') {
        this.cache.delete(conversationId);
      } else if (typeof this.cache.del === 'function') {
        this.cache.del(conversationId);
      }
      this.applyBackoff(error);
      return false;
    }
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
            logger.info(
              `[nats.last_processed] KV init attempt ${attempt} (bucket=${bucket}, ttlMs=${ttlMs}, maxValueSize=${maxValueSize})`,
            );
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
              `[nats.last_processed] Попытка ${attempt} инициализации KV не удалась (bucket=${bucket}, code=${error?.code || 'n/a'}): ${error.message}`,
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

    const key = `dialog.${conversationId}`;
    logger.debug(`[nats.last_processed] KV get key=${key}`);
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

    const { minPutIntervalMs, minPutDeltaMs } = this.getThrottleConfig();
    const now = Date.now();
    const sinceLast = now - this.lastPutAt;
    const delta = Math.abs(timestamp - this.lastPutValue);

    if (minPutIntervalMs && sinceLast < minPutIntervalMs) {
      logger.debug(
        `[nats.last_processed] KV put skipped (rate_limit) delta=${delta}ms interval=${sinceLast}ms`,
      );
      this.schedulePut(conversationId, timestamp);
      return false;
    }

    if (minPutDeltaMs && delta < minPutDeltaMs) {
      logger.debug(
        `[nats.last_processed] KV put skipped (delta) delta=${delta}ms minDelta=${minPutDeltaMs}ms`,
      );
      this.schedulePut(conversationId, timestamp);
      return false;
    }

    return await this.performPut(conversationId, timestamp);
  }
}

module.exports = { NatsKvLastProcessed };
