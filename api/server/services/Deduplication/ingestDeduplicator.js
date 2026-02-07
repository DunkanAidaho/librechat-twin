'use strict';

const LRU = require('lru-cache');
const { StringCodec, KVOperation } = require('nats');
const { logger } = require('@librechat/data-schemas');
const config = require('~/server/services/Config/ConfigService');
const {
  getJetStream,
  getOrCreateKV,
  isEnabled: isNatsEnabled,
} = require('~/utils/natsClient');
const {
  recordIngestDedupeHit,
  recordIngestDedupeMiss,
} = require('~/utils/metrics');

const sc = StringCodec();

const ingestionConfig = config.getSection('ingestion');

const FILE_DEDUPE_BUCKET = ingestionConfig.dedupeBucket;
const TEXT_DEDUPE_BUCKET = ingestionConfig.textDedupeBucket || 'text_ingest_dedupe';
const LOCAL_TTL_MS = ingestionConfig.dedupeLocalTtlMs;
const LOCAL_MAX_ITEMS = ingestionConfig.dedupeLocalMax;
const KV_TTL_MS = ingestionConfig.dedupeKvTtlMs;
const KV_TTL_NS = KV_TTL_MS > 0 ? KV_TTL_MS * 1e6 : undefined;

let kvBucket = null;
let currentBucketName = FILE_DEDUPE_BUCKET;
let watcherHandle = null;
let initialized = false;
let initializingPromise = null;

const stats = {
  hits: { memory: 0, jetstream: 0, fallback: 0 },
  misses: { memory: 0, jetstream: 0, fallback: 0, jetstream_transient: 0 },
};

const cache = new LRU({
  max: Number.isFinite(LOCAL_MAX_ITEMS) && LOCAL_MAX_ITEMS > 0 ? LOCAL_MAX_ITEMS : 5000,
  ttl: Number.isFinite(LOCAL_TTL_MS) && LOCAL_TTL_MS > 0 ? LOCAL_TTL_MS : 600000,
  updateAgeOnGet: true,
});

function safeLabel(mode, fallback) {
  return typeof mode === 'string' && mode.length ? mode : fallback;
}

function markHit(mode) {
  const label = safeLabel(mode, 'unknown');
  stats.hits[label] = (stats.hits[label] || 0) + 1;
  try {
    recordIngestDedupeHit(label);
  } catch (error) {
    logger.warn(`[ingestDeduplicator] Ошибка отправки метрики hit: ${error.message}`);
  }
}

function markMiss(mode) {
  const label = safeLabel(mode, 'unknown');
  stats.misses[label] = (stats.misses[label] || 0) + 1;
  try {
    recordIngestDedupeMiss(label);
  } catch (error) {
    logger.warn(`[ingestDeduplicator] Ошибка отправки метрики miss: ${error.message}`);
  }
}

function cacheDelete(key) {
  if (typeof cache.delete === 'function') {
    return cache.delete(key);
  }
  if (typeof cache.del === 'function') {
    return cache.del(key);
  }
  return undefined;
}

function isTransientKvError(error) {
  const message = String(error?.message || error || '');
  return error?.code === '503' || /\b503\b/.test(message) || /tempor/i.test(message);
}

async function retryTransient(operation, description) {
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      return await operation();
    } catch (error) {
      const isTransient = isTransientKvError(error);
      const isLastAttempt = i === attempts - 1;
      if (!isTransient || isLastAttempt) {
        throw error;
      }
      const delay = 150 + Math.random() * 150;
      logger.info(
        `[ingestDeduplicator] transient KV error during ${description}, retry ${i + 1}/${attempts - 1}: ${error.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return null;
}

async function stopWatcher() {
  if (watcherHandle) {
    try {
      await watcherHandle.stop();
    } catch (error) {
      logger.warn(`[ingestDeduplicator] Ошибка при остановке watcher: ${error.message}`);
    }
    watcherHandle = null;
  }
}

async function startWatcher() {
  await stopWatcher();

  if (!kvBucket) {
    return;
  }

  try {
    watcherHandle = await kvBucket.watch({ initialized: true });

    (async () => {
      try {
        for await (const entry of watcherHandle) {
          if (!entry) {
            continue;
          }

          if (entry.operation === KVOperation.DELETE || entry.operation === KVOperation.PURGE) {
            cacheDelete(entry.key);
            continue;
          }

          try {
            const value = entry.value ? sc.decode(entry.value) : '';
            if (value === '1') {
              cache.set(entry.key, true);
            }
          } catch (error) {
            logger.warn(
              `[ingestDeduplicator] Не удалось декодировать KV значение ${entry.key}: ${error.message}`,
            );
          }
        }
      } catch (error) {
        logger.warn(`[ingestDeduplicator] Watcher завершился с ошибкой: ${error.message}`);
        initialized = false;
        kvBucket = null;
      } finally {
        watcherHandle = null;
      }
    })().catch((error) => {
      logger.error(`[ingestDeduplicator] Watcher аварийно завершился: ${error.message}`);
      initialized = false;
      kvBucket = null;
      watcherHandle = null;
    });
  } catch (error) {
    logger.error(`[ingestDeduplicator] Не удалось запустить watcher: ${error.message}`);
    initialized = false;
    kvBucket = null;
  }
}

function getBucketName(taskType) {
  return taskType === 'index_text' ? TEXT_DEDUPE_BUCKET : FILE_DEDUPE_BUCKET;
}

async function initialize(bucketName = FILE_DEDUPE_BUCKET) {
  if (initialized && kvBucket) {
    return true;
  }

  if (initializingPromise) {
    return initializingPromise;
  }

  initializingPromise = (async () => {
    if (!isNatsEnabled()) {
      logger.warn('[ingestDeduplicator] NATS отключён → работаем только локально');
      initialized = false;
      kvBucket = null;
      return false;
    }

    try {
      kvBucket = await getOrCreateKV(bucketName, {
        ttl: KV_TTL_MS,
        history: 1,
        maxValueSize: 64,
      });

      if (!kvBucket) {
        logger.warn(`[ingestDeduplicator] KV bucket недоступен, fallback (bucket=${bucketName})`);
        initialized = false;
        return false;
      }

      currentBucketName = bucketName;
      await startWatcher();
      initialized = true;
      logger.info(
        `[ingestDeduplicator] Инициализация завершена (bucket=${bucketName})`,
      );
      return true;
    } catch (error) {
      logger.error(`[ingestDeduplicator] Ошибка инициализации KV: ${error.message}`);
      initialized = false;
      kvBucket = null;
      return false;
    }
  })();

  const result = await initializingPromise;
  initializingPromise = null;
  return result;
}

async function ensureBucket(taskType) {
  const targetBucket = getBucketName(taskType);
  if (currentBucketName !== targetBucket) {
    await shutdown();
    await initialize(targetBucket);
  } else if (!kvBucket) {
    await initialize(targetBucket);
  }
}

async function markAsIngested(key, taskType = 'index_file') {
  if (!key) {
    return { deduplicated: false, mode: 'fallback' };
  }

  if (cache.has(key)) {
    markHit('memory');
    return { deduplicated: true, mode: 'memory' };
  }

  markMiss('memory');

  await ensureBucket(taskType);
  const kvReady = Boolean(kvBucket);
  if (!kvReady || !kvBucket) {
    markMiss('fallback');
    cache.set(key, true);
    return { deduplicated: false, mode: 'fallback' };
  }

  try {
    const entry = await retryTransient(() => kvBucket.get(key), 'kv.get');
    if (entry?.value) {
      markHit('jetstream');
      cache.set(key, true);
      return { deduplicated: true, mode: 'jetstream' };
    }

    markMiss('jetstream');
    const options = KV_TTL_NS ? { ttl: KV_TTL_NS } : undefined;
    await retryTransient(() => kvBucket.put(key, sc.encode('1'), options), 'kv.put');
    cache.set(key, true);
    return { deduplicated: false, mode: 'jetstream' };
  } catch (error) {
    if (isTransientKvError(error)) {
      logger.info(
        `[ingestDeduplicator] transient KV failure (bucket=${currentBucketName}, key=${key}): ${error.message}`,
      );
      markMiss('jetstream_transient');
      cache.set(key, true);
      return { deduplicated: false, mode: 'fallback_transient' };
    }

    logger.warn(`[ingestDeduplicator] Ошибка KV при markAsIngested(${key}): ${error.message}`);
    markMiss('fallback');
    cache.set(key, true);
    return { deduplicated: false, mode: 'fallback' };
  }
}

async function clearIngestedMark(key) {
  if (!key) {
    return;
  }

  cacheDelete(key);

  if (!kvBucket) {
    logger.debug(`[ingestDeduplicator] KV bucket не инициализирован, пропускаем удаление ${key}`);
    return;
  }

  try {
    await retryTransient(() => kvBucket.delete(key), 'kv.delete');
  } catch (error) {
    if (isTransientKvError(error)) {
      logger.info(
        `[ingestDeduplicator] transient KV delete failure (bucket=${currentBucketName}, key=${key}): ${error.message}`,
      );
      markMiss('jetstream_transient');
    } else {
      logger.warn(`[ingestDeduplicator] Не удалось удалить KV ключ ${key}: ${error.message}`);
      markMiss('fallback');
    }
  }
}

async function getMetrics() {
  return {
    jetstreamAvailable: Boolean(kvBucket),
    cacheSize: cache.size,
    hits: { ...stats.hits },
    misses: { ...stats.misses },
  };
}

async function shutdown() {
  await stopWatcher();
  kvBucket = null;
  initialized = false;
}

module.exports = {
  initialize,
  markAsIngested,
  clearIngestedMark,
  getMetrics,
  shutdown,
};
