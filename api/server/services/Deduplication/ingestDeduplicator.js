'use strict';

const LRU = require('lru-cache');
const { StringCodec, KVOperation } = require('nats');
const { logger } = require('@librechat/data-schemas');
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

const DEFAULT_BUCKET = process.env.INGEST_DEDUP_BUCKET_NAME || 'ingest_dedupe';
const LOCAL_TTL = parseInt(process.env.INGEST_DEDUP_LOCAL_TTL_MS || '600000', 10);
const LOCAL_MAX = parseInt(process.env.INGEST_DEDUP_LOCAL_MAX || '5000', 10);
const KV_TTL_MS = parseInt(process.env.INGEST_DEDUP_KV_TTL_MS || '259200000', 10);
const KV_TTL_NS = KV_TTL_MS > 0 ? KV_TTL_MS * 1e6 : undefined;

let kvBucket = null;
let watcherHandle = null;
let initialized = false;
let initializingPromise = null;

const stats = {
  hits: { memory: 0, jetstream: 0, fallback: 0 },
  misses: { memory: 0, jetstream: 0, fallback: 0 },
};

const cache = new LRU({
  max: Number.isFinite(LOCAL_MAX) && LOCAL_MAX > 0 ? LOCAL_MAX : 5000,
  ttl: Number.isFinite(LOCAL_TTL) && LOCAL_TTL > 0 ? LOCAL_TTL : 600000,
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
    logger.warn('[ingestDeduplicator] Ошибка отправки метрики hit: %s', error.message);
  }
}

function markMiss(mode) {
  const label = safeLabel(mode, 'unknown');
  stats.misses[label] = (stats.misses[label] || 0) + 1;
  try {
    recordIngestDedupeMiss(label);
  } catch (error) {
    logger.warn('[ingestDeduplicator] Ошибка отправки метрики miss: %s', error.message);
  }
}

async function stopWatcher() {
  if (watcherHandle) {
    try {
      await watcherHandle.stop();
    } catch (error) {
      logger.warn('[ingestDeduplicator] Ошибка при остановке watcher: %s', error.message);
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
            cache.delete(entry.key);
            continue;
          }

          try {
            const value = entry.value ? sc.decode(entry.value) : '';
            if (value === '1') {
              cache.set(entry.key, true);
            }
          } catch (error) {
            logger.warn('[ingestDeduplicator] Не удалось декодировать KV значение %s: %s', entry.key, error.message);
          }
        }
      } catch (error) {
        logger.warn('[ingestDeduplicator] Watcher завершился с ошибкой: %s', error.message);
        initialized = false;
        kvBucket = null;
      } finally {
        watcherHandle = null;
      }
    })().catch((error) => {
      logger.error('[ingestDeduplicator] Watcher аварийно завершился: %s', error.message);
      initialized = false;
      kvBucket = null;
      watcherHandle = null;
    });
  } catch (error) {
    logger.error('[ingestDeduplicator] Не удалось запустить watcher: %s', error.message);
    initialized = false;
    kvBucket = null;
  }
}

async function initialize() {
  if (initialized && kvBucket) {
    return true;
  }

  if (initializingPromise) {
    return initializingPromise;
  }

  initializingPromise = (async () => {
    if (!isNatsEnabled()) {
      logger.warn('[ingestDeduplicator] NATS отключён -> работаем только локально');
      initialized = false;
      kvBucket = null;
      return false;
    }

    const jetstream = await getJetStream();
    if (!jetstream) {
      logger.warn('[ingestDeduplicator] JetStream недоступен -> fallback на локальный кэш');
      initialized = false;
      kvBucket = null;
      return false;
    }

    try {
      kvBucket = await getOrCreateKV(DEFAULT_BUCKET, {
        ttl: KV_TTL_MS,
        history: 1,
        maxValueSize: 64,
      });

      if (!kvBucket) {
        initialized = false;
        return false;
      }

      await startWatcher();
      initialized = true;
      logger.info('[ingestDeduplicator] Инициализация завершена (bucket=%s)', DEFAULT_BUCKET);
      return true;
    } catch (error) {
      logger.error('[ingestDeduplicator] Ошибка инициализации KV: %s', error.message);
      initialized = false;
      kvBucket = null;
      return false;
    }
  })();

  const result = await initializingPromise;
  initializingPromise = null;
  return result;
}

async function markAsIngested(key) {
  if (!key) {
    return { deduplicated: false, mode: 'fallback' };
  }

  if (cache.has(key)) {
    markHit('memory');
    return { deduplicated: true, mode: 'memory' };
  }

  markMiss('memory');

  const kvReady = await initialize();
  if (!kvReady || !kvBucket) {
    markMiss('fallback');
    cache.set(key, true);
    return { deduplicated: false, mode: 'fallback' };
  }

  try {
    const entry = await kvBucket.get(key);
    if (entry?.value) {
      markHit('jetstream');
      cache.set(key, true);
      return { deduplicated: true, mode: 'jetstream' };
    }

    markMiss('jetstream');
    const options = KV_TTL_NS ? { ttl: KV_TTL_NS } : undefined;
    await kvBucket.put(key, sc.encode('1'), options);
    cache.set(key, true);
    return { deduplicated: false, mode: 'jetstream' };
  } catch (error) {
    logger.warn('[ingestDeduplicator] Ошибка KV при markAsIngested(%s): %s', key, error.message);
    markMiss('fallback');
    cache.set(key, true);
    return { deduplicated: false, mode: 'fallback' };
  }
}

async function clearIngestedMark(key) {
  if (!key) {
    return;
  }

  cache.delete(key);

  if (!kvBucket) {
    return;
  }

  try {
    await kvBucket.delete(key);
  } catch (error) {
    logger.warn('[ingestDeduplicator] Не удалось удалить KV ключ %s: %s', key, error.message);
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
