'use strict';

const {
  connect,
  StringCodec,
  StorageType,
} = require('nats');
const { logger } = require('@librechat/data-schemas');
const { retryAsync } = require('~/utils/async');

const isEnabled =
  (process.env.NATS_ENABLED || '').toLowerCase() === 'true';

const sc = StringCodec();

const DEFAULT_RETRIES = parseInt(process.env.NATS_CONNECT_RETRIES || '5', 10);
const BASE_DELAY_MS = parseInt(process.env.NATS_RETRY_DELAY_MS || '1000', 10);
const MAX_DELAY_MS = parseInt(process.env.NATS_RETRY_MAX_DELAY_MS || '15000', 10);

let connectionPromise = null;
let nc = null;
let js = null;
let jsm = null;
let shuttingDown = false;

function resetConnectionState() {
  connectionPromise = null;
  nc = null;
  js = null;
  jsm = null;
}

async function connectOnce() {
  const servers = (process.env.NATS_SERVERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!servers.length) {
    logger.warn('[natsClient] NATS_ENABLED=true, но NATS_SERVERS не задан');
    throw new Error('NATS_SERVERS is empty');
  }

  const reconnectTimeWait = parseInt(process.env.NATS_RECONNECT_WAIT_MS || '2000', 10);
  const name = process.env.NATS_CLIENT_NAME || 'librechat-api';

  const connection = await connect({
    servers,
    name,
    reconnectTimeWait,
    maxReconnectAttempts: -1,
    user: process.env.NATS_USER || undefined,
    pass: process.env.NATS_PASSWORD || undefined,
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
  if (!isEnabled || shuttingDown) {
    return null;
  }

  if (nc && !nc.isClosed()) {
    return nc;
  }

  if (!connectionPromise) {
    connectionPromise = retryAsync(
      async () => {
        if (shuttingDown) {
          throw new Error('NATS shutdown in progress');
        }
        return connectOnce();
      },
      {
        retries: DEFAULT_RETRIES,
        minDelay: BASE_DELAY_MS,
        maxDelay: MAX_DELAY_MS,
        factor: 2,
        jitter: 0.4,
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
  return ttlMs * 1e6; // миллисекунды → наносекунды (в формате number)
}

async function getOrCreateStream(config) {
  const manager = await getJetStreamManager();
  if (!manager) {
    return null;
  }

  try {
    return await manager.streams.info(config.name);
  } catch (error) {
    const message = error.message || '';
    if (
      error.code === '404' ||
      error.code === '503' ||
      /stream .+ not found/i.test(message)
    ) {
      logger.info('[natsClient] Создаём стрим %s', config.name);
      await manager.streams.add(config);
      return manager.streams.info(config.name);
    }
    throw error;
  }
}

async function getOrCreateKV(name, options = {}) {
  const manager = await getJetStreamManager();
  const jetstream = await getJetStream();
  if (!manager || !jetstream) {
    return null;
  }

  try {
    const info = await manager.kv.stream(name);
    if (info) {
      return jetstream.views.kv(name);
    }
  } catch (error) {
    const message = error.message || '';
    if (
      error.code !== '404' &&
      error.code !== '503' &&
      !/not found/i.test(message)
    ) {
      throw error;
    }
  }

  const replicas = options.replicaCount
    || parseInt(process.env.NATS_STREAM_REPLICAS || '1', 10);

  const bucketConfig = {
    name,
    history: options.history || 1,
    ttl: ttlToNanosNumber(options.ttl || 0),
    storage: options.storage || StorageType.File,
    replicas,
    maxValueSize: options.maxValueSize || 1024,
    maxBucketSize: options.maxBucketSize || undefined,
  };

  logger.info('[natsClient] Создаём KV bucket %s', name);
  await manager.kv.add(bucketConfig);
  return jetstream.views.kv(name);
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
  getOrCreateStream,
  getOrCreateKV,
  publish,
  subscribe,
  close,
};
