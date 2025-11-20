'use strict';

const { logger } = require('@librechat/data-schemas');
const { z } = require('zod');

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'y']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'n']);

function toOptionalBool(value) {
  if (value == null || value === '') {
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  return undefined;
}

function toOptionalInt(value) {
  if (value == null || value === '') {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toOptionalFloat(value) {
  if (value == null || value === '') {
    return undefined;
  }
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function splitList(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function sanitizeUrl(value) {
  if (!value) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, '');
}

function deepFreeze(target) {
  if (!target || typeof target !== 'object' || Object.isFrozen(target)) {
    return target;
  }
  Object.freeze(target);
  for (const key of Object.keys(target)) {
    deepFreeze(target[key]);
  }
  return target;
}

class ConfigService {
  constructor() {
    this.schemas = this._buildSchemas();
    this.cache = new Map();
    this.loadAll();
    this.assertCritical();
  }

  _buildSchemas() {
    const coreSchema = z.object({
      environment: z.string().default('development'),
      logLevel: z.string().default('info'),
    });

    const mongoSchema = z.object({
      uri: z.string().min(1, 'MONGO_URI is required'),
      maxPoolSize: z.number().int().positive().optional(),
      minPoolSize: z.number().int().nonnegative().optional(),
      maxConnecting: z.number().int().positive().optional(),
      maxIdleTimeMS: z.number().int().nonnegative().optional(),
      waitQueueTimeoutMS: z.number().int().nonnegative().optional(),
      autoIndex: z.boolean().optional(),
      autoCreate: z.boolean().optional(),
    });

    const natsSchema = z
      .object({
        enabled: z.boolean(),
        servers: z.array(z.string().min(1)),
        auth: z.object({
          user: z.string().min(1).optional(),
          password: z.string().min(1).optional(),
        }),
        clientName: z.string().min(1),
        reconnectTimeWait: z.number().int().nonnegative(),
        connectRetries: z.number().int().nonnegative(),
        retryDelayMs: z.number().int().nonnegative(),
        retryMaxDelayMs: z.number().int().nonnegative(),
        retryFactor: z.number().positive(),
        retryJitter: z.number().min(0).max(1),
        streamReplicas: z.number().int().positive(),
      })
      .superRefine((data, ctx) => {
        if (data.enabled && data.servers.length === 0) {
          ctx.addIssue({
            path: ['servers'],
            code: z.ZodIssueCode.custom,
            message: 'NATS_SERVERS must be provided when NATS_ENABLED=true',
          });
        }
      });

    const queueSchema = z.object({
      toolsGatewayUrl: z.string().url().nullable(),
      httpTimeoutMs: z.number().int().positive(),
      subjects: z.object({
        memory: z.string().min(1).nullable(),
        graph: z.string().min(1).nullable(),
        summary: z.string().min(1).nullable(),
        delete: z.string().min(1).nullable(),
      }),
    });

    const cacheSchema = z.object({
      kv: z.object({
        rag: z.object({
          bucket: z.string().min(1),
          l1: z.object({
            ttlMs: z.number().int().nonnegative(),
            maxSize: z.number().int().positive(),
          }),
          l2: z.object({
            ttlSeconds: z.number().int().nonnegative(),
          }),
        }),
        graph: z.object({
          bucket: z.string().min(1),
          l1: z.object({
            ttlMs: z.number().int().nonnegative(),
            maxSize: z.number().int().positive(),
          }),
          l2: z.object({
            ttlSeconds: z.number().int().nonnegative(),
          }),
        }),
        summaries: z.object({
          bucket: z.string().min(1),
          l1: z.object({
            ttlMs: z.number().int().nonnegative(),
            maxSize: z.number().int().positive(),
          }),
          l2: z.object({
            ttlSeconds: z.number().int().nonnegative(),
          }),
        }),
      }),
    });

    const ragSchema = z.object({
      url: z.string().url().nullable(),
      context: z.object({
        maxChars: z.number().int().positive(),
        topK: z.number().int().positive(),
        summaryLineLimit: z.number().int().nonnegative(),
        summaryHintMaxChars: z.number().int().positive(),
        includeGraphInSummary: z.boolean(),
      }),
      condense: z.object({
        timeoutMs: z.number().int().positive(),
        concurrency: z.number().int().positive(),
        cacheTtlSeconds: z.number().int().nonnegative(),
        debug: z.boolean(),
      }),
    });

    const summariesSchema = z.object({
      threshold: z.number().int().positive(),
      maxMessagesPerSummary: z.number().int().positive(),
      lockTtlSeconds: z.number().int().positive(),
      overlap: z.number().int().nonnegative(),
    });

    const ingestionSchema = z.object({
      dedupeBucket: z.string().min(1),
      dedupeLocalTtlMs: z.number().int().nonnegative(),
      dedupeLocalMax: z.number().int().positive(),
      dedupeKvTtlMs: z.number().int().nonnegative(),
    });

    const featuresSchema = z.object({
      useConversationMemory: z.boolean(),
      headlessStream: z.boolean(),
      debugCondense: z.boolean(),
    });

    const pricingSchema = z.object({
      tokensPerKiloPrice: z.number().positive().optional(),
    });

    return {
      core: {
        schema: coreSchema,
        loader: () => ({
          environment: process.env.NODE_ENV || 'development',
          logLevel: process.env.LOG_LEVEL || 'info',
        }),
      },
      mongo: {
        schema: mongoSchema,
        loader: () => ({
          uri: process.env.MONGO_URI || process.env.MONGODB_URI || '',
          maxPoolSize: toOptionalInt(process.env.MONGO_MAX_POOL_SIZE),
          minPoolSize: toOptionalInt(process.env.MONGO_MIN_POOL_SIZE),
          maxConnecting: toOptionalInt(process.env.MONGO_MAX_CONNECTING),
          maxIdleTimeMS: toOptionalInt(process.env.MONGO_MAX_IDLE_TIME_MS),
          waitQueueTimeoutMS: toOptionalInt(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS),
          autoIndex: toOptionalBool(process.env.MONGO_AUTO_INDEX),
          autoCreate: toOptionalBool(process.env.MONGO_AUTO_CREATE),
        }),
      },
      nats: {
        schema: natsSchema,
        loader: () => ({
          enabled: toOptionalBool(process.env.NATS_ENABLED) ?? false,
          servers: splitList(process.env.NATS_SERVERS),
          auth: {
            user: process.env.NATS_USER || undefined,
            password: process.env.NATS_PASSWORD || undefined,
          },
          clientName: process.env.NATS_CLIENT_NAME || 'librechat-api',
          reconnectTimeWait: toOptionalInt(process.env.NATS_RECONNECT_WAIT_MS) ?? 2000,
          connectRetries: toOptionalInt(process.env.NATS_CONNECT_RETRIES) ?? 5,
          retryDelayMs: toOptionalInt(process.env.NATS_RETRY_DELAY_MS) ?? 1000,
          retryMaxDelayMs: toOptionalInt(process.env.NATS_RETRY_MAX_DELAY_MS) ?? 15000,
          retryFactor: toOptionalFloat(process.env.NATS_RETRY_FACTOR) ?? 2,
          retryJitter: toOptionalFloat(process.env.NATS_RETRY_JITTER) ?? 0.4,
          streamReplicas: toOptionalInt(process.env.NATS_STREAM_REPLICAS) ?? 1,
        }),
      },
      queues: {
        schema: queueSchema,
        loader: () => ({
          toolsGatewayUrl: sanitizeUrl(process.env.TOOLS_GATEWAY_URL),
          httpTimeoutMs: toOptionalInt(process.env.TOOLS_GATEWAY_TIMEOUT_MS) ?? 15000,
          subjects: {
            memory: process.env.NATS_MEMORY_SUBJECT || null,
            graph: process.env.NATS_GRAPH_SUBJECT || null,
            summary: process.env.NATS_SUMMARY_SUBJECT || null,
            delete: process.env.NATS_DELETE_SUBJECT || null,
          },
        }),
      },
      cache: {
        schema: cacheSchema,
        loader: () => ({
          kv: {
            rag: {
              bucket: process.env.RAG_CACHE_BUCKET || 'rag_context',
              l1: {
                ttlMs: toOptionalInt(process.env.RAG_CACHE_L1_TTL_MS) ?? 5 * 60 * 1000,
                maxSize: toOptionalInt(process.env.RAG_CACHE_L1_MAX) ?? 500,
              },
              l2: {
                ttlSeconds: toOptionalInt(process.env.RAG_CACHE_L2_TTL_SEC) ?? 24 * 60 * 60,
              },
            },
            graph: {
              bucket: process.env.GRAPH_CACHE_BUCKET || 'graph_context',
              l1: {
                ttlMs: toOptionalInt(process.env.GRAPH_CACHE_L1_TTL_MS) ?? 5 * 60 * 1000,
                maxSize: toOptionalInt(process.env.GRAPH_CACHE_L1_MAX) ?? 500,
              },
              l2: {
                ttlSeconds: toOptionalInt(process.env.GRAPH_CACHE_L2_TTL_SEC) ?? 24 * 60 * 60,
              },
            },
            summaries: {
              bucket: process.env.SUMMARY_CACHE_BUCKET || 'rag_summaries',
              l1: {
                ttlMs: toOptionalInt(process.env.SUMMARY_CACHE_L1_TTL_MS) ?? 10 * 60 * 1000,
                maxSize: toOptionalInt(process.env.SUMMARY_CACHE_L1_MAX) ?? 200,
              },
              l2: {
                ttlSeconds: toOptionalInt(process.env.SUMMARY_CACHE_L2_TTL_SEC) ?? 7 * 24 * 60 * 60,
              },
            },
          },
        }),
      },
      rag: {
        schema: ragSchema,
        loader: () => ({
          url: sanitizeUrl(process.env.RAG_URL || process.env.RAG_SERVICE_URL),
          context: {
            maxChars: toOptionalInt(process.env.RAG_CONTEXT_MAX_CHARS) ?? 60000,
            topK: toOptionalInt(process.env.RAG_CONTEXT_TOPK) ?? 12,
            summaryLineLimit: toOptionalInt(process.env.GRAPH_CONTEXT_SUMMARY_LINE_LIMIT) ?? 10,
            summaryHintMaxChars:
              toOptionalInt(process.env.GRAPH_CONTEXT_SUMMARY_HINT_MAX_CHARS) ?? 1000,
            includeGraphInSummary:
              toOptionalBool(process.env.GRAPH_CONTEXT_INCLUDE_IN_SUMMARY) ?? true,
          },
          condense: {
            timeoutMs: toOptionalInt(process.env.RAG_CONDENSE_TIMEOUT_MS) ?? 180000,
            concurrency: toOptionalInt(process.env.CONDENSE_CONCURRENCY) ?? 4,
            cacheTtlSeconds: toOptionalInt(process.env.CONDENSE_CACHE_TTL_SEC) ?? 604800,
            debug: toOptionalBool(process.env.DEBUG_CONDENSE) ?? false,
          },
        }),
      },
      summaries: {
        schema: summariesSchema,
        loader: () => ({
          threshold: toOptionalInt(process.env.SUMMARIZATION_THRESHOLD) ?? 10,
          maxMessagesPerSummary: toOptionalInt(process.env.MAX_MESSAGES_PER_SUMMARY) ?? 40,
          lockTtlSeconds: toOptionalInt(process.env.SUMMARIZATION_LOCK_TTL) ?? 20,
          overlap: toOptionalInt(process.env.SUMMARY_OVERLAP) ?? 5,
        }),
      },
      ingestion: {
        schema: ingestionSchema,
        loader: () => ({
          dedupeBucket: process.env.INGEST_DEDUP_BUCKET_NAME || 'ingest_dedupe',
          dedupeLocalTtlMs: toOptionalInt(process.env.INGEST_DEDUP_LOCAL_TTL_MS) ?? 600000,
          dedupeLocalMax: toOptionalInt(process.env.INGEST_DEDUP_LOCAL_MAX) ?? 5000,
          dedupeKvTtlMs: toOptionalInt(process.env.INGEST_DEDUP_KV_TTL_MS) ?? 259200000,
        }),
      },
      features: {
        schema: featuresSchema,
        loader: () => ({
          useConversationMemory: toOptionalBool(process.env.USE_CONVERSATION_MEMORY) ?? false,
          headlessStream: toOptionalBool(process.env.HEADLESS_STREAM) ?? false,
          debugCondense: toOptionalBool(process.env.DEBUG_CONDENSE) ?? false,
        }),
      },
      pricing: {
        schema: pricingSchema,
        loader: () => ({
          tokensPerKiloPrice: toOptionalFloat(process.env.TOKENS_PER_KILO_PRICE),
        }),
      },
    };
  }

  loadSection(name, options = {}) {
    const { force = false } = options;
    if (!force && this.cache.has(name)) {
      return this.cache.get(name);
    }

    const entry = this.schemas[name];
    if (!entry) {
      throw new Error(`[ConfigService] Неизвестная секция "${name}"`);
    }

    try {
      const parsed = entry.schema.parse(entry.loader());
      const frozen = deepFreeze(parsed);
      this.cache.set(name, frozen);
      return frozen;
    } catch (error) {
      logger.error('[ConfigService] Ошибка загрузки секции %s: %s', name, error.message);
      throw error;
    }
  }

  loadAll() {
    Object.keys(this.schemas).forEach((name) => {
      this.loadSection(name, { force: true });
    });
  }

  reloadSection(name) {
    return this.loadSection(name, { force: true });
  }

  reloadAll() {
    this.cache.clear();
    this.loadAll();
  }

  getSection(name) {
    return this.loadSection(name);
  }

  get(path, defaultValue) {
    if (!path || typeof path !== 'string') {
      return defaultValue;
    }

    const [sectionName, ...rest] = path.split('.');
    if (!sectionName) {
      return defaultValue;
    }

    let value;
    try {
      value = this.getSection(sectionName);
    } catch (error) {
      return defaultValue;
    }

    for (const key of rest) {
      if (value == null) {
        return defaultValue;
      }
      if (typeof value !== 'object' || !(key in value)) {
        return defaultValue;
      }
      value = value[key];
    }

    return value ?? defaultValue;
  }

  listSections() {
    return Object.keys(this.schemas);
  }

  assertCritical() {
    const mongo = this.getSection('mongo');
    if (!mongo.uri) {
      throw new Error('MONGO_URI is required but not configured.');
    }

    const nats = this.getSection('nats');
    if (nats.enabled && nats.servers.length === 0) {
      throw new Error('NATS_SERVERS must be configured when NATS_ENABLED=true.');
    }

    const queues = this.getSection('queues');
    if (!queues.toolsGatewayUrl) {
      logger.warn(
        '[ConfigService] toolsGatewayUrl не настроен. HTTP fallback для Temporal может быть недоступен.',
      );
    }
  }
}

const configService = new ConfigService();

module.exports = configService;
module.exports.ConfigService = ConfigService;
