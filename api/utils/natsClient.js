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

  const runtimeConfig = getNatsConfig();
  const replicas = options.replicaCount ?? runtimeConfig.streamReplicas;

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
