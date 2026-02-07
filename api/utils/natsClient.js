'use strict';

const { connect, StringCodec, StorageType } = require('nats');
const { logger } = require('@librechat/data-schemas');
const { retryAsync } = require('~/utils/async');
const config = require('~/server/services/Config/ConfigService');

const sc = StringCodec();

let connectionPromise = null;
let nc = null;
let js = null;
let jsm = null;
let shuttingDown = false;

function getNatsConfig() {
  return config.getSection('nats');
}

function getRetrySettings(runtimeConfig = getNatsConfig()) {
  return {
    connectRetries: runtimeConfig.connectRetries,
    retryDelayMs: runtimeConfig.retryDelayMs,
    retryMaxDelayMs: runtimeConfig.retryMaxDelayMs,
    retryFactor: runtimeConfig.retryFactor,
    retryJitter: runtimeConfig.retryJitter,
  };
}

/**
 * Проверяет актуальное состояние включения NATS, читая конфиг каждый вызов.
 * Это важно для сценариев динамической перезагрузки, чтобы не «замораживать» значение.
 */
function isEnabled() {
  const runtimeConfig = getNatsConfig();
  return Boolean(runtimeConfig?.enabled);
}

function resetConnectionState() {
  connectionPromise = null;
  nc = null;
  js = null;
  jsm = null;
}

async function connectOnce(runtimeConfig) {
  const servers = runtimeConfig.servers;
  if (!servers.length) {
    logger.warn('[natsClient] NATS_ENABLED=true, но NATS_SERVERS не задан');
    throw new Error('NATS_SERVERS is empty');
  }

  const connection = await connect({
    servers,
    name: runtimeConfig.clientName,
    reconnectTimeWait: runtimeConfig.reconnectTimeWait,
    maxReconnectAttempts: -1,
    user: runtimeConfig.auth.user,
    pass: runtimeConfig.auth.password,
  });

  connection.closed().then((err) => {
    if (err) {
      logger.warn('[natsClient] Соединение закрыто с ошибкой: %s', err.message);
    } else {
      logger.info('[natsClient] Соединение закрыто');
    }
    resetConnectionState();
  });

  logger.info(`[natsClient] Подключение установлено (${servers.join(', ')})`);
  return connection;
}

async function ensureConnection() {
  const runtimeConfig = getNatsConfig();
  if (!runtimeConfig.enabled || shuttingDown) {
    return null;
  }

  if (nc && !nc.isClosed()) {
    return nc;
  }

  if (!connectionPromise) {
    const retrySettings = getRetrySettings(runtimeConfig);
    connectionPromise = retryAsync(
      async () => {
        if (shuttingDown) {
          throw new Error('NATS shutdown in progress');
        }
        const freshConfig = getNatsConfig();
        return connectOnce(freshConfig);
      },
      {
        retries: retrySettings.connectRetries,
        minDelay: retrySettings.retryDelayMs,
        maxDelay: retrySettings.retryMaxDelayMs,
        factor: retrySettings.retryFactor,
        jitter: retrySettings.retryJitter,
        onRetry: async (error, attempt) => {
          logger.warn(
            '[natsClient] попытка #%d подключения не удалась: %s',
            attempt,
            error.message,
          );
        },
      },
    ).catch((error) => {
      logger.error('[natsClient] Не удалось подключиться к NATS: %s', error.message);
      resetConnectionState();
      return null;
    });
  }

  nc = await connectionPromise;
  return nc;
}

async function getJetStream() {
  const connection = await ensureConnection();
  if (!connection) {
    return null;
  }

  if (!js) {
    js = connection.jetstream();
  }
  return js;
}

async function getJetStreamManager() {
  const connection = await ensureConnection();
  if (!connection) {
    return null;
  }

  if (!jsm) {
    jsm = await connection.jetstreamManager();
  }
  return jsm;
}

function ttlToNanosNumber(ttlMs) {
  if (!ttlMs || ttlMs <= 0) {
    return undefined;
  }
  return ttlMs * 1e6;
}

async function getOrCreateStream(configInput) {
  const manager = await getJetStreamManager();
  if (!manager) {
    return null;
  }

  try {
    return await manager.streams.info(configInput.name);
  } catch (error) {
    const message = error.message || '';
    if (
      error.code === '404' ||
      error.code === '503' ||
      /stream .+ not found/i.test(message)
    ) {
      logger.info('[natsClient] Создаём стрим %s', configInput.name);
      await manager.streams.add(configInput);
      return manager.streams.info(configInput.name);
    }
    throw error;
  }
}

function resolveKvNames(name) {
  const bucket = String(name || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_');
  const stream = `KV_${bucket}`;
  const subject = `_KV.${bucket}.>`;
  return { bucket, stream, subject };
}

async function ensureKvStream(manager, bucketName) {
  const { stream } = resolveKvNames(bucketName);
  try {
    return await manager.streams.info(stream);
  } catch (error) {
    const message = error?.message || '';
    if (error?.code === '404' || /not found/i.test(message)) {
      return null;
    }
    throw error;
  }
}

async function createKvStream(manager, bucketName, options = {}) {
  const { stream, subject } = resolveKvNames(bucketName);
  logger.info('[natsClient] creating KV stream %s', stream);
  await manager.streams.add({
    name: stream,
    subjects: [subject],
    storage: options.storage ?? StorageType.File,
    num_replicas: options.replicaCount,
    max_age: ttlToNanosNumber(options.ttl),
    max_msgs_per_subject: options.history ?? 1,
    max_msg_size: options.maxValueSize ?? 1024,
    max_bytes: options.maxBucketSize,
    allow_rollup_hdrs: true,
    discard: options.discardPolicy,
  });
  return manager.streams.info(stream);
}

async function getOrCreateKV(name, options = {}) {
  const manager = await getJetStreamManager();
  const jetstream = await getJetStream();

  if (!manager || !jetstream) {
    logger.warn('[natsClient] JetStream manager unavailable, KV %s skipped', name);
    return null;
  }

  const runtimeConfig = getNatsConfig();
  const replicas = options.replicaCount ?? runtimeConfig.streamReplicas;
  const storage = options.storage ?? StorageType.File;
  const ttlMs = options.ttl ?? 0;
  const history = options.history ?? 1;
  const maxValueSize = options.maxValueSize ?? 1024;
  const maxBucketSize = options.maxBucketSize;

  const { bucket } = resolveKvNames(name);

  let streamInfo = await ensureKvStream(manager, bucket);
  if (!streamInfo) {
    streamInfo = await createKvStream(manager, bucket, {
      storage,
      ttl: ttlMs,
      history,
      maxValueSize,
      maxBucketSize,
      replicaCount: replicas,
    });
  }

  if (!streamInfo) {
    throw new Error(`[natsClient] Не удалось получить или создать KV stream для ${bucket}`);
  }

  return jetstream.views.kv(bucket);
}

async function publish(subject, payload, opts = {}) {
  const jetstream = await getJetStream();
  if (!jetstream) {
    throw new Error('JetStream недоступен');
  }

  const data = Buffer.isBuffer(payload) ? payload : sc.encode(JSON.stringify(payload));
  await jetstream.publish(subject, data, opts);
}

async function subscribe(subject, consumerOpts) {
  const jetstream = await getJetStream();
  if (!jetstream) {
    throw new Error('JetStream недоступен');
  }

  return jetstream.subscribe(subject, consumerOpts);
}

async function close() {
  shuttingDown = true;

  if (nc && !nc.isClosed()) {
    try {
      await nc.drain();
    } catch (error) {
      logger.warn('[natsClient] Ошибка при drain(): %s', error.message);
      try {
        await nc.close();
      } catch (closeError) {
        logger.error('[natsClient] Ошибка при close(): %s', closeError.message);
      }
    }
  }

  resetConnectionState();
  shuttingDown = false;
}

module.exports = {
  isEnabled,
  sc,
  getJetStream,
  getJetStreamManager,
  resolveKvNames,
  ensureKvStream,
  createKvStream,
  getOrCreateStream,
  getOrCreateKV,
  publish,
  subscribe,
  close,
};
