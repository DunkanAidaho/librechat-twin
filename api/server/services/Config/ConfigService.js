'use strict';

const { z } = require('zod');
const { logger } = require('@librechat/data-schemas');

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'y']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'n']);

function parseOptionalBool(value) {
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

function parseOptionalInt(value) {
  if (value == null || value === '') {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseOptionalFloat(value) {
  if (value == null || value === '') {
    return undefined;
  }
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function splitStringList(value) {
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

function sanitizeOptionalString(value) {
  if (value == null) {
    return undefined;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

const agentOperationSchema = z.object({
  timeoutMs: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
});

const ragProvidersSchema = z
  .object({
    condenseProvider: z.string().min(1).optional(),
    summarizerType: z.string().min(1).optional(),
    fallbackProvider: z.string().min(1).optional(),
    fallbackModel: z.string().min(1).optional(),
    condenseModel: z.string().min(1).optional(),
    allowLocalFallback: z.boolean().optional(),
    openrouter: z
      .object({
        apiKey: z.string().min(1).optional(),
        baseUrl: z.string().min(1).optional(),
        summaryModel: z.string().min(1).optional(),
        titleModel: z.string().min(1).optional(),
        referer: z.string().min(1).optional(),
        appName: z.string().min(1).optional(),
      })
      .optional(),
    ollama: z
      .object({
        url: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        legacyFlag: z.boolean().optional(),
      })
      .optional(),
  })
  .optional();

class ConfigService {
  constructor(env = process.env) {
    this.env = env;
    this.schemas = this.#buildSchemas();
    this.cache = new Map();
    this.reloadAll();
    this.#assertCritical();
  }

  #buildSchemas() {
    const coreSchema = z.object({
      environment: z.string().default('development'),
      logLevel: z.string().default('info'),
      serverDomain: z.string().min(1).optional(),
      publicServerDomain: z.string().min(1).optional(),
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

    const queuesSchema = z.object({
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
      providers: ragProvidersSchema,
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

    const memorySchema = z.object({
      temporalEnabled: z.boolean(),
      graphWorkflowEnabled: z.boolean(),
      useGraphContext: z.boolean(),
      graphContextMode: z.string().min(1).nullable(),
    });

    const agentsSchema = z.object({
      resilience: z.object({
        minDelayMs: z.number().int().nonnegative(),
        maxDelayMs: z.number().int().nonnegative(),
        backoffFactor: z.number().positive(),
        jitter: z.number().min(0).max(1),
        operations: z.object({
          initializeClient: agentOperationSchema,
          sendMessage: agentOperationSchema,
          memoryQueue: agentOperationSchema,
          summaryEnqueue: agentOperationSchema,
          graphEnqueue: agentOperationSchema,
          saveConvo: agentOperationSchema,
        }),
      }),
      thresholds: z.object({
        maxUserMessageChars: z.number().int().positive(),
        googleNoStreamThreshold: z.number().int().positive(),
      }),
    });

    return {
      core: {
        schema: coreSchema,
        loader: () => ({
          environment: this.env.NODE_ENV || 'development',
          logLevel: this.env.LOG_LEVEL || 'info',
          serverDomain: sanitizeOptionalString(this.env.SERVER_DOMAIN),
          publicServerDomain: sanitizeOptionalString(this.env.PUBLIC_SERVER_DOMAIN),
        }),
      },
      mongo: {
        schema: mongoSchema,
        loader: () => ({
          uri: this.env.MONGO_URI || '',
          maxPoolSize: parseOptionalInt(this.env.MONGO_MAX_POOL_SIZE),
          minPoolSize: parseOptionalInt(this.env.MONGO_MIN_POOL_SIZE),
          maxConnecting: parseOptionalInt(this.env.MONGO_MAX_CONNECTING),
          maxIdleTimeMS: parseOptionalInt(this.env.MONGO_MAX_IDLE_TIME_MS),
          waitQueueTimeoutMS: parseOptionalInt(this.env.MONGO_WAIT_QUEUE_TIMEOUT_MS),
          autoIndex: parseOptionalBool(this.env.MONGO_AUTO_INDEX),
          autoCreate: parseOptionalBool(this.env.MONGO_AUTO_CREATE),
        }),
      },
      nats: {
        schema: natsSchema,
        loader: () => ({
          enabled: parseOptionalBool(this.env.NATS_ENABLED) ?? false,
          servers: splitStringList(this.env.NATS_SERVERS),
          auth: {
            user: sanitizeOptionalString(this.env.NATS_USER),
            password: sanitizeOptionalString(this.env.NATS_PASSWORD),
          },
          clientName: sanitizeOptionalString(this.env.NATS_CLIENT_NAME) || 'librechat-api',
          reconnectTimeWait: parseOptionalInt(this.env.NATS_RECONNECT_WAIT_MS) ?? 2000,
          connectRetries: parseOptionalInt(this.env.NATS_CONNECT_RETRIES) ?? 5,
          retryDelayMs: parseOptionalInt(this.env.NATS_RETRY_DELAY_MS) ?? 1000,
          retryMaxDelayMs: parseOptionalInt(this.env.NATS_RETRY_MAX_DELAY_MS) ?? 15000,
          retryFactor: parseOptionalFloat(this.env.NATS_RETRY_FACTOR) ?? 2,
          retryJitter: parseOptionalFloat(this.env.NATS_RETRY_JITTER) ?? 0.4,
          streamReplicas: parseOptionalInt(this.env.NATS_STREAM_REPLICAS) ?? 1,
        }),
      },
      queues: {
        schema: queuesSchema,
        loader: () => ({
          toolsGatewayUrl: sanitizeUrl(this.env.TOOLS_GATEWAY_URL),
          httpTimeoutMs: parseOptionalInt(this.env.TOOLS_GATEWAY_TIMEOUT_MS) ?? 15000,
          subjects: {
            memory: sanitizeOptionalString(this.env.NATS_MEMORY_SUBJECT) ?? null,
            graph: sanitizeOptionalString(this.env.NATS_GRAPH_SUBJECT) ?? null,
            summary: sanitizeOptionalString(this.env.NATS_SUMMARY_SUBJECT) ?? null,
            delete: sanitizeOptionalString(this.env.NATS_DELETE_SUBJECT) ?? null,
          },
        }),
      },
      cache: {
        schema: cacheSchema,
        loader: () => ({
          kv: {
            rag: {
              bucket: this.env.RAG_CACHE_BUCKET || 'rag_context',
              l1: {
                ttlMs: parseOptionalInt(this.env.RAG_CACHE_L1_TTL_MS) ?? 300_000,
                maxSize: parseOptionalInt(this.env.RAG_CACHE_L1_MAX) ?? 500,
              },
              l2: {
                ttlSeconds: parseOptionalInt(this.env.RAG_CACHE_L2_TTL_SEC) ?? 86_400,
              },
            },
            graph: {
              bucket: this.env.GRAPH_CACHE_BUCKET || 'graph_context',
              l1: {
                ttlMs: parseOptionalInt(this.env.GRAPH_CACHE_L1_TTL_MS) ?? 300_000,
                maxSize: parseOptionalInt(this.env.GRAPH_CACHE_L1_MAX) ?? 500,
              },
              l2: {
                ttlSeconds: parseOptionalInt(this.env.GRAPH_CACHE_L2_TTL_SEC) ?? 86_400,
              },
            },
            summaries: {
              bucket: this.env.SUMMARY_CACHE_BUCKET || 'rag_summaries',
              l1: {
                ttlMs: parseOptionalInt(this.env.SUMMARY_CACHE_L1_TTL_MS) ?? 600_000,
                maxSize: parseOptionalInt(this.env.SUMMARY_CACHE_L1_MAX) ?? 200,
              },
              l2: {
                ttlSeconds: parseOptionalInt(this.env.SUMMARY_CACHE_L2_TTL_SEC) ?? 604_800,
              },
            },
          },
        }),
      },
      rag: {
        schema: ragSchema,
        loader: () => ({
          url: sanitizeUrl(this.env.RAG_URL || this.env.RAG_SERVICE_URL),
          context: {
            maxChars: parseOptionalInt(this.env.RAG_CONTEXT_MAX_CHARS) ?? 60_000,
            topK: parseOptionalInt(this.env.RAG_CONTEXT_TOPK) ?? 12,
            summaryLineLimit: parseOptionalInt(this.env.GRAPH_CONTEXT_SUMMARY_LINE_LIMIT) ?? 10,
            summaryHintMaxChars:
              parseOptionalInt(this.env.GRAPH_CONTEXT_SUMMARY_HINT_MAX_CHARS) ?? 1000,
            includeGraphInSummary:
              parseOptionalBool(this.env.GRAPH_CONTEXT_INCLUDE_IN_SUMMARY) ?? true,
          },
          condense: {
            timeoutMs: parseOptionalInt(this.env.RAG_CONDENSE_TIMEOUT_MS) ?? 180_000,
            concurrency: parseOptionalInt(this.env.CONDENSE_CONCURRENCY) ?? 4,
            cacheTtlSeconds: parseOptionalInt(this.env.CONDENSE_CACHE_TTL_SEC) ?? 604_800,
            debug: parseOptionalBool(this.env.DEBUG_CONDENSE) ?? false,
          },
          providers: {
            condenseProvider: sanitizeOptionalString(this.env.RAG_CONDENSE_PROVIDER),
            summarizerType: sanitizeOptionalString(this.env.RAG_SUMMARIZER_LLM_TYPE),
            fallbackProvider: sanitizeOptionalString(this.env.RAG_FALLBACK_PROVIDER),
            fallbackModel: sanitizeOptionalString(this.env.RAG_FALLBACK_MODEL),
            condenseModel: sanitizeOptionalString(this.env.RAG_CONDENSE_MODEL),
            allowLocalFallback: parseOptionalBool(this.env.RAG_ALLOW_LOCAL_FALLBACK),
            openrouter: {
              apiKey: sanitizeOptionalString(this.env.OPENROUTER_API_KEY),
              baseUrl: sanitizeUrl(this.env.OPENROUTER_BASE_URL) || undefined,
              summaryModel: sanitizeOptionalString(this.env.OPENROUTER_SUMMARY_MODEL),
              titleModel: sanitizeOptionalString(this.env.OPENROUTER_TITLE_MODEL),
              referer: sanitizeOptionalString(
                this.env.OPENROUTER_REFERRER ||
                this.env.SERVER_DOMAIN ||
                this.env.PUBLIC_SERVER_DOMAIN,
              ),
              appName: sanitizeOptionalString(this.env.OPENROUTER_APP_NAME),
            },
            ollama: {
              url: sanitizeUrl(
                this.env.OLLAMA_SUMMARIZATION_URL ||
                this.env.OLLAMA_URL ||
                undefined,
              ) || undefined,
              model: sanitizeOptionalString(this.env.OLLAMA_SUMMARIZATION_MODEL_NAME),
              legacyFlag: parseOptionalBool(this.env.USE_OLLAMA_FOR_SUMMARIZATION),
            },
          },
        }),
      },
      summaries: {
        schema: summariesSchema,
        loader: () => ({
          threshold: parseOptionalInt(this.env.SUMMARIZATION_THRESHOLD) ?? 10,
          maxMessagesPerSummary: parseOptionalInt(this.env.MAX_MESSAGES_PER_SUMMARY) ?? 40,
          lockTtlSeconds: parseOptionalInt(this.env.SUMMARIZATION_LOCK_TTL) ?? 20,
          overlap: parseOptionalInt(this.env.SUMMARY_OVERLAP) ?? 5,
        }),
      },
      ingestion: {
        schema: ingestionSchema,
        loader: () => ({
          dedupeBucket: this.env.INGEST_DEDUP_BUCKET_NAME || 'ingest_dedupe',
          dedupeLocalTtlMs: parseOptionalInt(this.env.INGEST_DEDUP_LOCAL_TTL_MS) ?? 600_000,
          dedupeLocalMax: parseOptionalInt(this.env.INGEST_DEDUP_LOCAL_MAX) ?? 5000,
          dedupeKvTtlMs: parseOptionalInt(this.env.INGEST_DEDUP_KV_TTL_MS) ?? 259_200_000,
        }),
      },
      features: {
        schema: featuresSchema,
        loader: () => ({
          useConversationMemory: parseOptionalBool(this.env.USE_CONVERSATION_MEMORY) ?? false,
          headlessStream: parseOptionalBool(this.env.HEADLESS_STREAM) ?? false,
          debugCondense: parseOptionalBool(this.env.DEBUG_CONDENSE) ?? false,
        }),
      },
      pricing: {
        schema: pricingSchema,
        loader: () => ({
          tokensPerKiloPrice: parseOptionalFloat(this.env.TOKENS_PER_KILO_PRICE),
        }),
      },
      memory: {
        schema: memorySchema,
        loader: () => ({
          temporalEnabled: parseOptionalBool(this.env.TEMPORAL_MEMORY_ENABLED) ?? false,
          graphWorkflowEnabled:
            parseOptionalBool(this.env.MEMORY_GRAPHWORKFLOW_ENABLED) ?? false,
          useGraphContext: parseOptionalBool(this.env.USE_GRAPH_CONTEXT) ?? true,
          graphContextMode: sanitizeOptionalString(this.env.GRAPH_CONTEXT_MODE) || null,
        }),
      },
      agents: {
        schema: agentsSchema,
        loader: () => ({
          resilience: {
            minDelayMs: parseOptionalInt(this.env.AGENT_RETRY_MIN_DELAY_MS) ?? 200,
            maxDelayMs:
              parseOptionalInt(this.env.AGENT_RETRY_MAX_DELAY_MS) ??
              Math.max(200, parseOptionalInt(this.env.AGENT_RETRY_MIN_DELAY_MS) ?? 200),
            backoffFactor: parseOptionalFloat(this.env.AGENT_RETRY_BACKOFF_FACTOR) ?? 2,
            jitter: parseOptionalFloat(this.env.AGENT_RETRY_JITTER) ?? 0.2,
            operations: {
              initializeClient: {
                timeoutMs: parseOptionalInt(this.env.AGENT_INIT_CLIENT_TIMEOUT_MS) ?? 15_000,
                retries: parseOptionalInt(this.env.AGENT_INIT_CLIENT_RETRIES) ?? 2,
              },
              sendMessage: {
                timeoutMs: parseOptionalInt(this.env.AGENT_SEND_MESSAGE_TIMEOUT_MS) ?? 120_000,
                retries: parseOptionalInt(this.env.AGENT_SEND_MESSAGE_RETRIES) ?? 1,
              },
              memoryQueue: {
                timeoutMs: parseOptionalInt(this.env.AGENT_MEMORY_QUEUE_TIMEOUT_MS) ?? 15_000,
                retries: parseOptionalInt(this.env.AGENT_MEMORY_QUEUE_RETRIES) ?? 2,
              },
              summaryEnqueue: {
                timeoutMs: parseOptionalInt(this.env.AGENT_SUMMARY_EN_QUEUE_TIMEOUT_MS) ?? 15_000,
                retries: parseOptionalInt(this.env.AGENT_SUMMARY_ENQUEUE_RETRIES) ?? 2,
              },
              graphEnqueue: {
                timeoutMs: parseOptionalInt(this.env.AGENT_GRAPH_ENQUEUE_TIMEOUT_MS) ?? 15_000,
                retries: parseOptionalInt(this.env.AGENT_GRAPH_ENQUEUE_RETRIES) ?? 2,
              },
              saveConvo: {
                timeoutMs: parseOptionalInt(this.env.AGENT_SAVE_CONVO_TIMEOUT_MS) ?? 10_000,
                retries: parseOptionalInt(this.env.AGENT_SAVE_CONVO_RETRIES) ?? 1,
              },
            },
          },
          thresholds: {
            maxUserMessageChars: parseOptionalInt(this.env.MAX_USER_MSG_TO_MODEL_CHARS) ?? 200_000,
            googleNoStreamThreshold:
              parseOptionalInt(this.env.GOOGLE_NOSTREAM_THRESHOLD) ?? 120_000,
          },
        }),
      },
    };
  }

  #loadSection(name, options = { force: false }) {
    if (!options.force && this.cache.has(name)) {
      return this.cache.get(name);
    }

    const entry = this.schemas[name];
    if (!entry) {
      throw new Error(`[ConfigService] Unknown section "${name}"`);
    }

    try {
      const parsed = entry.schema.parse(entry.loader());
      const frozen = deepFreeze(parsed);
      this.cache.set(name, frozen);
      return frozen;
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.error(
          '[ConfigService] Validation error in section %s: %o',
          name,
          error.flatten().fieldErrors,
        );
      } else {
        logger.error('[ConfigService] Failed to load section %s: %s', name, error.message);
      }
      throw error;
    }
  }

  reloadSection(name) {
    return this.#loadSection(name, { force: true });
  }

  reloadAll() {
    this.cache.clear();
    Object.keys(this.schemas).forEach((section) => {
      this.#loadSection(section, { force: true });
    });
  }

  getSection(name) {
    return this.#loadSection(name);
  }

  get(path, defaultValue = undefined) {
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
    } catch {
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

  getBoolean(path, defaultValue = false) {
    const value = this.get(path, defaultValue);
    return Boolean(value);
  }

  getNumber(path, defaultValue = undefined) {
    const value = this.get(path, defaultValue);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  }

  listSections() {
    return Object.keys(this.schemas);
  }

  #assertCritical() {
    const mongo = this.getSection('mongo');
    if (!mongo.uri) {
      throw new Error('MONGO_URI is required but not configured.');
    }

    if (this.env.MONGODB_URI && !this.env.MONGO_URI) {
      logger.warn(
        '[ConfigService] MONGODB_URI detected. Please migrate to MONGO_URI and remove the legacy variable.',
      );
    }

    const nats = this.getSection('nats');
    if (nats.enabled && nats.servers.length === 0) {
      throw new Error('NATS_SERVERS must be configured when NATS_ENABLED=true.');
    }

    const queues = this.getSection('queues');
    if (!queues.toolsGatewayUrl) {
      logger.warn(
        '[ConfigService] toolsGatewayUrl is not configured. Temporal HTTP fallback may be unavailable.',
      );
    }

    const rag = this.getSection('rag');
    if (!rag.url) {
      logger.warn(
        '[ConfigService] RAG service URL is not configured. RAG context enrichment may fail.',
      );
    }
  }
}

const configService = new ConfigService();

module.exports = configService;
module.exports.ConfigService = ConfigService;

