'use strict';
const fs = require('fs');
const yaml = require('js-yaml');

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

// Поддерживаемые форматы logging.tokenUsageReportMode.
const TOKEN_USAGE_REPORT_MODES = ['json', 'table', 'disabled'];

class ConfigService {
  constructor(env = process.env) {
    this.env = env;
    this.schemas = this.#buildSchemas();
    this.cache = new Map();
    this.missingDefaults = new Set();
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
      redisMemoryQueueName: z.string().min(1).nullable().optional(),
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
      cache: z
        .object({
          ttl: z.number().int().nonnegative(),
        })
        .optional(),
      gateway: z
        .object({
          url: z.string().url().nullable(),
          timeoutMs: z.number().int().positive(),
        })
        .optional(),
      query: z
        .object({
          maxChars: z.number().int().positive(),
        })
        .optional(),
      graph: z
        .object({
          maxLines: z.number().int().positive(),
          maxLineChars: z.number().int().positive(),
          summaryLineLimit: z.number().int().positive(),
          summaryHintMaxChars: z.number().int().nonnegative(),
        })
        .optional(),
      vector: z
        .object({
          maxChunks: z.number().int().positive(),
          maxChars: z.number().int().positive(),
          topK: z.number().int().positive(),
          embeddingModel: z.string().min(1).optional(),
          recentTurns: z.number().int().nonnegative().optional(),
        })
        .optional(),
      summarization: z
        .object({
          enabled: z.boolean(),
          budgetChars: z.number().int().positive(),
          chunkChars: z.number().int().positive(),
          provider: z.string().optional(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
      history: z
        .object({
          histLongUserToRag: z.number().int().nonnegative(),
          ocrToRagThreshold: z.number().int().nonnegative(),
          waitForIngestMs: z.number().int().nonnegative(),
          assistLongToRag: z.number().int().nonnegative(),
          assistSnippetChars: z.number().int().nonnegative(),
        })
        .optional(),
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
      textDedupeBucket: z.string().min(1),
    });

    const featuresSchema = z.object({
      useConversationMemory: z.boolean(),
      headlessStream: z.boolean(),
      debugCondense: z.boolean(),
      branchLogging: z.boolean().optional(),
      useOllamaForTitles: z.boolean().optional(),
      googleChainBuffer: z.string().min(1).optional(),
      geminiChainWindow: z.number().int().nonnegative().optional(),
    });

    const pricingSchema = z.object({
      tokensPerKiloPrice: z.number().positive().optional(),
      apiKey: z.string().min(1).optional(),
      url: z.string().min(1).optional(),
      refreshIntervalSec: z.number().int().positive().optional(),
      cachePath: z.string().min(1).optional(),
    });
    
    const securitySchema = z.object({
      ragInternalKey: z.string().optional(),
    });
    
    const limitsSchema = z.object({
      request: z.record(z.number().int().positive()).optional(),
      token: z.object({
        maxMessageTokens: z.number().int().nonnegative(),
        truncateLongMessages: z.boolean(),
      }).optional(),
      maxUserMsgToModelChars: z.number().int().nonnegative().optional(),
      promptPerMsgMax: z.number().int().nonnegative().optional(),
      dontShrinkLastN: z.number().int().nonnegative().optional(),
    });

    const historyCompressionSchema = z.object({
      enabled: z.boolean(),
      layer1Ratio: z.number().min(0).max(1),
      layer2Ratio: z.number().min(0).max(1),
      contextHeadroom: z.number().int().nonnegative(),
    });

    const multiStepRagSchema = z.object({
      enabled: z.boolean(),
      maxEntities: z.number().int().positive(),
      maxPasses: z.number().int().positive(),
      graphRetryLimit: z.number().int().nonnegative(),
      followUpTimeoutMs: z.number().int().positive(),
    });

    const memorySchema = z.object({
      temporalEnabled: z.boolean(),
      graphWorkflowEnabled: z.boolean(),
      useGraphContext: z.boolean(),
      graphContextMode: z.string().min(1).nullable(),
      useConversationMemory: z.boolean(),
      enableMemoryCache: z.boolean().optional(),
      activationThreshold: z.number().int().nonnegative(),
      history: z.object({
        tokenBudget: z.number().int().nonnegative(),
      }),
      queue: z.object({
        taskTimeoutMs: z.number().int().nonnegative(),
        historySyncBatchSize: z.number().int().positive(),
        enqueueBatchSize: z.number().int().positive().optional(),
        enqueueConcurrency: z.number().int().positive().optional(),
        enqueueMaxTotalMs: z.number().int().positive().optional(),
        failOpen: z.boolean().optional(),
      }),
      graphContext: z
        .object({
          maxLines: z.number().int().positive(),
          maxLineChars: z.number().int().positive(),
          requestTimeoutMs: z.number().int().nonnegative(),
          summaryLineLimit: z.number().int().positive(),
          summaryHintMaxChars: z.number().int().nonnegative(),
        })
        .optional(),
      ragQuery: z
        .object({
          maxChars: z.number().int().positive(),
        })
        .optional(),
      longTextMaxChars: z.number().int().positive().optional(),
    });

    const searchSchema = z.object({
      enabled: z.boolean(),
      host: z.string().min(1).nullable(),
      masterKey: z.string().min(1).nullable(),
      syncThreshold: z.number().int().nonnegative(),
      noSync: z.boolean(),
    });

    const clientsSchema = z.object({
      base: z.object({
        timeoutMs: z.number().int().positive(),
        retryCount: z.number().int().nonnegative(),
        retryMinDelayMs: z.number().int().nonnegative(),
        retryMaxDelayMs: z.number().int().nonnegative(),
        retryFactor: z.number().positive(),
        retryJitter: z.number().min(0).max(1),
      }),
    });

    const loggingSchema = z.object({
      globalLevel: z.string().min(1),
      format: z.enum(['text', 'json']),
      console: z.object({
        colorize: z.boolean(),
      }),
      file: z.object({
        enabled: z.boolean(),
        path: z.string().min(1).optional(),
      }),
      branch: z.object({
        enabled: z.boolean(),
        level: z.string().min(1),
      }),
      debugSse: z.boolean(),
      tracePipeline: z.boolean(),
      tokenUsageReportMode: z.enum(TOKEN_USAGE_REPORT_MODES),
      tokenBreakdown: z.object({
        enabled: z.boolean(),
        level: z.string().min(1),
      }),
    });

    const providersSchema = z.object({
      openai: z.object({
        apiKey: z.string().min(1).optional(),
        organization: z.string().min(1).optional(),
        azureDefaultModel: z.string().min(1).optional(),
        forcePrompt: z.boolean(),
        titleModel: z.string().min(1).optional(),
        summaryModel: z.string().min(1).optional(),
      }),
      anthropic: z.object({
        apiKey: z.string().min(1).optional(),
        defaultModel: z.string().min(1).optional(),
        titleModel: z.string().min(1).optional(),
      }),
      google: z.object({
        location: z.string().min(1),
        titleModel: z.string().min(1).optional(),
      }),
      ollama: z.object({
        url: z.string().min(1).optional(),
        titleModel: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      }).optional(),
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
      encoding: z.object({
        defaultTokenizerEncoding: z.string().min(1),
      }),
      titles: z.object({
        enabled: z.boolean(),
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
      search: {
        schema: searchSchema,
        loader: () => ({
          enabled: parseOptionalBool(this.env.SEARCH) ?? false,
          host: sanitizeOptionalString(this.env.MEILI_HOST) ?? null,
          masterKey: sanitizeOptionalString(this.env.MEILI_MASTER_KEY) ?? null,
          syncThreshold: parseOptionalInt(this.env.MEILI_SYNC_THRESHOLD) ?? 1000,
          noSync: parseOptionalBool(this.env.MEILI_NO_SYNC) ?? false,
        }),
      },
      queues: {
        schema: queuesSchema,
        loader: () => ({
          toolsGatewayUrl: sanitizeUrl(this.env.TOOLS_GATEWAY_URL),
          httpTimeoutMs: parseOptionalInt(this.env.TOOLS_GATEWAY_TIMEOUT_MS) ?? 15000,
          redisMemoryQueueName: sanitizeOptionalString(this.env.REDIS_MEMORY_QUEUE_NAME) ?? null,
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
        loader: () => {
          const toolsGatewayUrl = sanitizeUrl(this.env.TOOLS_GATEWAY_URL);
          if (!toolsGatewayUrl) {
            logger.warn(
              '[ConfigService] rag.gateway.url не настроен; функции tools-gateway отключены.',
            );
          }
	  const ragCacheTtl = parseOptionalInt(this.env.RAG_CACHE_TTL) ?? 900;
          const toolsGatewayTimeout =
            parseOptionalInt(this.env.TOOLS_GATEWAY_TIMEOUT_MS) ?? 20_000;

          const fallbackGraphLines = parseOptionalInt(this.env.RAG_GRAPH_MAX_LINES);
          const ragGraphMaxLines =
            parseOptionalInt(this.env.GRAPH_CONTEXT_LINE_LIMIT) ??
            fallbackGraphLines ??
            8;
          const ragGraphMaxLineChars =
            parseOptionalInt(this.env.GRAPH_CONTEXT_MAX_LINE_CHARS) ?? 200;
          const ragGraphSummaryLineLimit =
            parseOptionalInt(this.env.GRAPH_CONTEXT_SUMMARY_LINE_LIMIT) ??
            Math.min(ragGraphMaxLines, 8);
          const ragGraphSummaryHintMaxChars =
            parseOptionalInt(this.env.GRAPH_CONTEXT_SUMMARY_HINT_MAX_CHARS) ?? 2_000;

          const ragVectorMaxChunks = parseOptionalInt(this.env.RAG_VECTOR_MAX_CHUNKS) ?? 3;
          const ragVectorMaxChars = parseOptionalInt(this.env.RAG_VECTOR_MAX_CHARS) ?? 2_000;
          const ragVectorTopK = parseOptionalInt(this.env.RAG_CONTEXT_TOPK) ?? 12;
          const ragVectorEmbedding =
            sanitizeOptionalString(this.env.RAG_SEARCH_MODEL) || 'mxbai';
          const ragVectorRecentTurns = parseOptionalInt(this.env.RAG_VECTOR_RECENT_TURNS) ?? 6;

          const ragSummaryBudget = parseOptionalInt(this.env.RAG_SUMMARY_BUDGET) ?? 12_000;
          const ragSummaryChunk = parseOptionalInt(this.env.RAG_CHUNK_CHARS) ?? 20_000;
          const ragSummaryEnabled =
            parseOptionalBool(this.env.RAG_SUMMARIZE_IF_OVER) ?? true;
          const ragSummaryProvider = sanitizeOptionalString(
            this.env.RAG_VECTOR_SUMMARY_PROVIDER,
          );
          const ragSummaryTimeout = parseOptionalInt(this.env.RAG_SUMMARY_TIMEOUT_MS) ?? 125000;

          const ragQueryMaxChars =
            parseOptionalInt(this.env.RAG_QUERY_MAX_CHARS) ?? 6_000;

          const historyHistLongUser =
            parseOptionalInt(this.env.HIST_LONG_USER_TO_RAG) ?? 20_000;
          const historyOcrThreshold =
            parseOptionalInt(this.env.OCR_TO_RAG_THRESHOLD) ?? 15_000;
          const historyWaitForIngest =
            parseOptionalInt(this.env.WAIT_FOR_RAG_INGEST_MS) ?? 0;
          const historyAssistLong =
            parseOptionalInt(this.env.ASSIST_LONG_TO_RAG) ?? 15_000;
          const historyAssistSnippet =
            parseOptionalInt(this.env.ASSIST_SNIPPET_CHARS) ?? 1_500;

          const ragConfig = {
            url: sanitizeUrl(this.env.RAG_URL || this.env.RAG_SERVICE_URL),
            context: {
              maxChars: parseOptionalInt(this.env.RAG_CONTEXT_MAX_CHARS) ?? 60_000,
              topK: parseOptionalInt(this.env.RAG_CONTEXT_TOPK) ?? 12,
              summaryLineLimit:
                parseOptionalInt(this.env.GRAPH_CONTEXT_SUMMARY_LINE_LIMIT) ?? 10,
              summaryHintMaxChars:
                parseOptionalInt(this.env.GRAPH_CONTEXT_SUMMARY_HINT_MAX_CHARS) ?? 1_000,
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
            cache: {
              ttl: ragCacheTtl,
            },
            gateway: toolsGatewayUrl
              ? {
                  url: toolsGatewayUrl,
                  timeoutMs: toolsGatewayTimeout,
                }
              : undefined,
            query: {
              maxChars: ragQueryMaxChars,
            },
            graph: {
              maxLines: ragGraphMaxLines,
              maxLineChars: ragGraphMaxLineChars,
              summaryLineLimit: ragGraphSummaryLineLimit,
              summaryHintMaxChars: ragGraphSummaryHintMaxChars,
            },
            vector: {
              maxChunks: ragVectorMaxChunks,
              maxChars: ragVectorMaxChars,
              topK: ragVectorTopK,
              embeddingModel: ragVectorEmbedding,
              recentTurns: ragVectorRecentTurns,
            },
            summarization: {
              enabled: ragSummaryEnabled,
              budgetChars: ragSummaryBudget,
              chunkChars: ragSummaryChunk,
              provider: ragSummaryProvider || '',
              timeoutMs: ragSummaryTimeout,
            },
            history: {
              histLongUserToRag: historyHistLongUser,
              ocrToRagThreshold: historyOcrThreshold,
              waitForIngestMs: historyWaitForIngest,
              assistLongToRag: historyAssistLong,
              assistSnippetChars: historyAssistSnippet,
            },
          };

          // Diagnostic logging for RAG vector config (conditional)
          const diag = parseOptionalBool(this.env.RAG_DIAG) ?? false;
          if (diag && ragConfig.vector) {
            logger.info('[diag.config.rag.vector]', ragConfig.vector);
          }

          return ragConfig;
        },
      },
      summaries: {
        schema: summariesSchema,
        loader: () => ({
          threshold: parseOptionalInt(this.env.SUMMARIZATION_THRESHOLD) ?? 10,
          maxMessagesPerSummary: parseOptionalInt(this.env.MAX_MESSAGES_PER_SUMMARY) ?? 40,
          lockTtlSeconds: parseOptionalInt(this.env.SUMMARIZATION_LOCK_TTL) ?? 20,
          overlap: parseOptionalInt(this.env.SUMMARY_OVERLAP) ?? 5,
          maxPayloadBytes: parseOptionalInt(this.env.SUMMARIES_MAX_PAYLOAD_BYTES) ?? 900_000,
        }),
      },
      ingestion: {
        schema: ingestionSchema,
        loader: () => ({
          dedupeBucket: sanitizeOptionalString(this.env.INGEST_DEDUPE_BUCKET) || 'ingest_dedupe',
          dedupeLocalTtlMs: parseOptionalInt(this.env.INGEST_DEDUP_LOCAL_TTL_MS) ?? 600_000,
          dedupeLocalMax: parseOptionalInt(this.env.INGEST_DEDUP_LOCAL_MAX) ?? 5_000,
          dedupeKvTtlMs: parseOptionalInt(this.env.INGEST_DEDUP_KV_TTL_MS) ?? 259_200_000,
          textDedupeBucket:
            sanitizeOptionalString(this.env.TEXT_INGEST_DEDUPE_BUCKET) || 'text_ingest_dedupe',
        }),
      },
      pricing: {
        schema: pricingSchema,
        loader: () => {
          const apiKey = sanitizeOptionalString(this.env.OPENROUTER_PRICING_API_KEY) || '';
          const overrideUrl = sanitizeOptionalString(this.env.OPENROUTER_PRICING_URL);
          const baseUrl =
            sanitizeOptionalString(this.env.OPENROUTER_BASE_URL) || 'https://openrouter.ai/api/v1';
          const normalizedBase = baseUrl.replace(/\/+$|$/, '');
          const url = overrideUrl || `${normalizedBase}/models/user`;

          return {
            tokensPerKiloPrice: parseOptionalFloat(this.env.TOKENS_PER_KILO_PRICE),
            apiKey,
            url,
            refreshIntervalSec: parseOptionalInt(this.env.OPENROUTER_PRICING_REFRESH_SEC) ?? 86_400,
            cachePath:
              sanitizeOptionalString(this.env.OPENROUTER_PRICING_CACHE_PATH) ||
              './api/cache/openrouter_pricing.json',
          };
        },
      },
      security: {
        schema: securitySchema,
        loader: () => ({
          ragInternalKey: sanitizeOptionalString(this.env.INTERNAL_RAG_PROXY_KEY) || '',
        }),
      },
      features: {
        schema: featuresSchema,
        loader: () => ({
          useConversationMemory: parseOptionalBool(this.env.USE_CONVERSATION_MEMORY) ?? false,
          headlessStream: parseOptionalBool(this.env.HEADLESS_STREAM) ?? false,
          debugCondense: parseOptionalBool(this.env.DEBUG_CONDENSE) ?? false,
          branchLogging: parseOptionalBool(this.env.ENABLE_BRANCH_LOGGING) ?? false,
          useOllamaForTitles: parseOptionalBool(this.env.USE_OLLAMA_FOR_TITLES) ?? false,
          googleChainBuffer:
            (sanitizeOptionalString(this.env.GOOGLE_CHAIN_BUFFER) || 'off').toLowerCase(),
          geminiChainWindow: parseOptionalInt(this.env.GEMINI_CHAIN_WINDOW) ?? 5,
        }),
      },
      historyCompression: {
        schema: historyCompressionSchema,
        loader: () => ({
          enabled:
            parseOptionalBool(this.env.CONTEXT_GRADUAL_COMPRESSION) ??
            parseOptionalBool(this.env.CONTEXT_HISTORY_COMPRESSION_ENABLED) ??
            false,
          layer1Ratio: parseOptionalFloat(this.env.CONTEXT_LAYER1_RATIO) ?? 0.35,
          layer2Ratio: parseOptionalFloat(this.env.CONTEXT_LAYER2_RATIO) ?? 0.25,
          contextHeadroom: parseOptionalInt(this.env.CONTEXT_HEADROOM_TOKENS) ?? 1024,
        }),
      },
      multiStepRag: {
        schema: multiStepRagSchema,
        loader: () => ({
          enabled: parseOptionalBool(this.env.MULTISTEP_RAG_ENABLED) ?? false,
          maxEntities: parseOptionalInt(this.env.MULTISTEP_RAG_MAX_ENTITIES) ?? 3,
          maxPasses: parseOptionalInt(this.env.MULTISTEP_RAG_MAX_PASSES) ?? 2,
          graphRetryLimit:
            parseOptionalInt(this.env.MULTISTEP_RAG_GRAPH_RETRY_LIMIT) ?? 2,
          followUpTimeoutMs:
            parseOptionalInt(this.env.MULTISTEP_RAG_FOLLOWUP_TIMEOUT_MS) ?? 20000,
        }),
      },
      memory: {
        schema: memorySchema,
        loader: () => {
          const useConversationMemory =
            parseOptionalBool(this.env.USE_CONVERSATION_MEMORY) ?? true;
          const enableMemoryCache = parseOptionalBool(this.env.ENABLE_MEMORY_CACHE);

          const fallbackGraphLines = parseOptionalInt(this.env.RAG_GRAPH_MAX_LINES);
          const graphMaxLines =
            parseOptionalInt(this.env.GRAPH_CONTEXT_LINE_LIMIT) ??
            fallbackGraphLines ??
            8;
          const graphSummaryLineLimit =
            parseOptionalInt(this.env.GRAPH_CONTEXT_SUMMARY_LINE_LIMIT) ??
            Math.min(graphMaxLines, 8);
          const graphSummaryHintMaxChars =
            parseOptionalInt(this.env.GRAPH_CONTEXT_SUMMARY_HINT_MAX_CHARS) ?? 2_000;
          const graphMaxLineChars =
            parseOptionalInt(this.env.GRAPH_CONTEXT_MAX_LINE_CHARS) ?? 200;
          const graphRequestTimeoutMs =
            parseOptionalInt(this.env.GRAPH_REQUEST_TIMEOUT_MS) ?? 10_000;

          const ragQueryMaxChars =
            parseOptionalInt(this.env.RAG_QUERY_MAX_CHARS) ?? 6_000;

          const longTextChunkBucket =
            sanitizeOptionalString(this.env.LONG_TEXT_CHUNK_BUCKET) || 'long_text_chunks';
          const longTextChunkMaxChars =
            parseOptionalInt(this.env.MEMORY_LONG_TEXT_CHUNK_MAXCHARS) ?? 4_000;
          const longTextChunkMinChars =
            parseOptionalInt(this.env.MEMORY_LONG_TEXT_CHUNK_MINCHARS) ?? 1_500;
          const longTextChunkAdaptiveDeltaMs =
            parseOptionalInt(this.env.MEMORY_LONG_TEXT_CHUNK_ADAPTIVE_DELTA_MS) ?? 5_000;
          const longTextChunkMaxTimeoutMs =
            parseOptionalInt(this.env.MEMORY_LONG_TEXT_CHUNK_MAX_TIMEOUT_MS) ?? 300_000;

          return {
            temporalEnabled: parseOptionalBool(this.env.TEMPORAL_MEMORY_ENABLED) ?? false,
            graphWorkflowEnabled:
              parseOptionalBool(this.env.MEMORY_GRAPHWORKFLOW_ENABLED) ?? false,
            useGraphContext: parseOptionalBool(this.env.USE_GRAPH_CONTEXT) ?? true,
            graphContextMode: sanitizeOptionalString(this.env.GRAPH_CONTEXT_MODE) || null,
            useConversationMemory,
            enableMemoryCache: enableMemoryCache ?? useConversationMemory,
            activationThreshold: parseOptionalInt(this.env.MEMORY_ACTIVATION_THRESHOLD) ?? 6,
            history: {
              tokenBudget: parseOptionalInt(this.env.HISTORY_TOKEN_BUDGET) ?? 8_000,
            },
            queue: {
              taskTimeoutMs: parseOptionalInt(this.env.MEMORY_TASK_TIMEOUT_MS) ?? 30_000,
              historySyncBatchSize:
                parseOptionalInt(this.env.HISTORY_SYNC_BATCH_SIZE) ?? 20,
              enqueueBatchSize: parseOptionalInt(this.env.MEMORY_QUEUE_ENQUEUE_BATCH_SIZE) ?? 25,
              enqueueConcurrency: parseOptionalInt(this.env.MEMORY_QUEUE_ENQUEUE_CONCURRENCY) ?? 1,
              enqueueMaxTotalMs: parseOptionalInt(this.env.MEMORY_QUEUE_ENQUEUE_MAX_TOTAL_MS) ?? 60000,
              failOpen: parseOptionalBool(this.env.MEMORY_QUEUE_FAIL_OPEN) ?? true,
            },
            graphContext: {
              maxLines: graphMaxLines,
              maxLineChars: graphMaxLineChars,
              requestTimeoutMs: graphRequestTimeoutMs,
              summaryLineLimit: graphSummaryLineLimit,
              summaryHintMaxChars: graphSummaryHintMaxChars,
            },
            ragQuery: {
              maxChars: ragQueryMaxChars,
            },
            longTextMaxChars: parseOptionalInt(this.env.LONG_TEXT_MAX_CHARS) ?? undefined,
            longTextChunk: {
              bucket: longTextChunkBucket,
              maxChars: longTextChunkMaxChars,
              minChars: Math.min(longTextChunkMaxChars, Math.max(1, longTextChunkMinChars)),
              adaptiveDeltaMs: Math.max(1, longTextChunkAdaptiveDeltaMs),
              maxTimeoutMs: Math.max(1, longTextChunkMaxTimeoutMs),
            },
          };
        },
      },
      clients: {
        schema: clientsSchema,
        loader: () => ({
          base: {
            timeoutMs: parseOptionalInt(this.env.LLM_CLIENT_TIMEOUT_MS) ?? 120_000,
            retryCount: parseOptionalInt(this.env.LLM_CLIENT_RETRY_COUNT) ?? 1,
            retryMinDelayMs: parseOptionalInt(this.env.LLM_CLIENT_RETRY_MIN_DELAY_MS) ?? 200,
            retryMaxDelayMs: parseOptionalInt(this.env.LLM_CLIENT_RETRY_MAX_DELAY_MS) ?? 2_000,
            retryFactor: parseOptionalFloat(this.env.LLM_CLIENT_RETRY_FACTOR) ?? 2,
            retryJitter: parseOptionalFloat(this.env.LLM_CLIENT_RETRY_JITTER) ?? 0.2,
          },
        }),
      },
      logging: {
        schema: loggingSchema,
        loader: () => {
          const tokenUsageMode = sanitizeOptionalString(this.env.TOKEN_USAGE_REPORT_MODE);
          const normalizedMode = tokenUsageMode ? tokenUsageMode.toLowerCase() : undefined;
          const resolvedMode =
            normalizedMode && TOKEN_USAGE_REPORT_MODES.includes(normalizedMode)
              ? normalizedMode
              : 'json';

          const rawFormat = (sanitizeOptionalString(this.env.LOGGING_FORMAT) || 'text').toLowerCase();
          const format = rawFormat === 'json' ? 'json' : 'text';
          const consoleColorize =
            parseOptionalBool(this.env.LOGGING_CONSOLE_COLORIZE) ??
            (this.env.NODE_ENV !== 'production');
          const fileEnabled = parseOptionalBool(this.env.LOGGING_FILE_ENABLED) ?? false;
          const filePath = sanitizeOptionalString(this.env.LOGGING_FILE_PATH) || './logs/librechat.log';

          const tokenBreakdownEnabled =
            parseOptionalBool(this.env.LOGGING_TOKEN_BREAKDOWN_ENABLED) ?? true;
          const tokenBreakdownLevel =
            sanitizeOptionalString(this.env.LOGGING_TOKEN_BREAKDOWN_LEVEL) || 'info';

          return {
            globalLevel:
              sanitizeOptionalString(this.env.LOGGING_LEVEL) ||
              sanitizeOptionalString(this.env.LOG_LEVEL) ||
              'info',
            format,
            console: {
              colorize: Boolean(consoleColorize),
            },
            file: {
              enabled: fileEnabled,
              path: fileEnabled ? filePath : undefined,
            },
            branch: {
              enabled: parseOptionalBool(this.env.ENABLE_BRANCH_LOGGING) ?? false,
              level: sanitizeOptionalString(this.env.BRANCH_LOG_LEVEL) || 'info',
            },
            debugSse: parseOptionalBool(this.env.DEBUG_SSE) ?? false,
            tracePipeline: parseOptionalBool(this.env.TRACE_PIPELINE) ?? false,
            tokenUsageReportMode: resolvedMode,
            tokenBreakdown: {
              enabled: tokenBreakdownEnabled,
              level: tokenBreakdownLevel,
            },
          };
        },
      },
      providers: {
        schema: providersSchema,
        loader: () => ({
          openai: {
            apiKey: sanitizeOptionalString(this.env.OPENAI_API_KEY),
            organization: sanitizeOptionalString(this.env.OPENAI_ORGANIZATION),
            azureDefaultModel: sanitizeOptionalString(this.env.AZURE_OPENAI_DEFAULT_MODEL),
            forcePrompt: parseOptionalBool(this.env.OPENAI_FORCE_PROMPT) ?? false,
            titleModel: sanitizeOptionalString(this.env.OPENAI_TITLE_MODEL),
            summaryModel: sanitizeOptionalString(this.env.OPENAI_SUMMARY_MODEL),
          },
          anthropic: {
            apiKey: sanitizeOptionalString(this.env.ANTHROPIC_API_KEY),
            defaultModel: sanitizeOptionalString(this.env.ANTHROPIC_DEFAULT_MODEL),
            titleModel: sanitizeOptionalString(this.env.ANTHROPIC_TITLE_MODEL),
          },
          google: {
            location: sanitizeOptionalString(this.env.GOOGLE_LOC) || 'us-central1',
            titleModel: sanitizeOptionalString(this.env.GOOGLE_TITLE_MODEL),
          },
          ollama: {
            url: sanitizeUrl(this.env.OLLAMA_URL) || undefined,
            titleModel: sanitizeOptionalString(this.env.OLLAMA_TITLE_MODEL),
            model: sanitizeOptionalString(this.env.OLLAMA_MODEL),
          },
        }),
      },
      limits: {
        schema: limitsSchema,
        loader: () => {
          const requestLimits = {};
          for (const [key, value] of Object.entries(this.env)) {
            if (!key.startsWith('LIMITS_REQUEST_')) {
              continue;
            }
            const limitName = key.slice('LIMITS_REQUEST_'.length);
            if (!limitName) {
              continue;
            }
            const parsed = parseOptionalInt(value);
            if (parsed == null || parsed <= 0) {
              continue;
            }
            requestLimits[limitName] = parsed;
          }

          return {
            request: requestLimits,
            token: {
              maxMessageTokens: parseOptionalInt(this.env.MAX_MESSAGE_TOKENS) ?? 0,
              truncateLongMessages:
                parseOptionalBool(this.env.TRUNCATE_LONG_MESSAGES) ?? true,
            },
            maxUserMsgToModelChars:
              parseOptionalInt(this.env.MAX_USER_MSG_TO_MODEL_CHARS) ?? 0,
            promptPerMsgMax: parseOptionalInt(this.env.PROMPT_PER_MSG_MAX) ?? 0,
            dontShrinkLastN: parseOptionalInt(this.env.DONT_SHRINK_LAST_N) ?? 4,
          };
        },
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
          encoding: {
            defaultTokenizerEncoding:
              sanitizeOptionalString(this.env.DEFAULT_TOKENIZER_ENCODING) || 'o200k_base',
          },
          titles: {
            enabled: parseOptionalBool(this.env.TITLE_CONVO) ?? true,
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
      throw new Error(`[ConfigService] Неизвестная секция "${name}"`);
    }

    try {
      const parsed = entry.schema.parse(entry.loader());
      const frozen = deepFreeze(parsed);
      this.cache.set(name, frozen);
      return frozen;
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.error(
          `[ConfigService] Ошибка валидации в секции ${name}:`,
          error.flatten().fieldErrors,
        );
      } else {
        logger.error(`[ConfigService] Не удалось загрузить секцию ${name}: ${error.message}`);
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
    // [CUSTOM PATCH] START: YAML config loading logic
    const configPath = this.env.ENDPOINTS_CONFIG_PATH;
    if (configPath && fs.existsSync(configPath)) {
      try {
        const fileContents = fs.readFileSync(configPath, 'utf8');
        const fileConfig = yaml.load(fileContents);

        if (fileConfig && typeof fileConfig === 'object') {
          // Загружаем секцию 'endpoints' из YAML и кешируем ее
          if (fileConfig.endpoints) {
            this.cache.set('endpoints', deepFreeze(fileConfig.endpoints));
            logger.info(`[ConfigService] Успешно загружена секция 'endpoints' из YAML: ${configPath}`);
          }

          // Загружаем также другие корневые секции из YAML, если они есть (например, fileConfig)
          if (fileConfig.fileConfig) {
            this.cache.set('fileConfig', deepFreeze(fileConfig.fileConfig));
            logger.info(`[ConfigService] Успешно загружена секция 'fileConfig' из YAML: ${configPath}`);
          }
        }
      } catch (e) {
        logger.error(`[ConfigService] Не удалось загрузить или распарсить YAML конфиг по пути ${configPath}`, e);
      }
    }
    // [CUSTOM PATCH] END: YAML config loading logic

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
      return this.#useDefault(path, defaultValue);
    }

    for (const key of rest) {
      if (value == null || typeof value !== 'object' || !(key in value)) {
        return this.#useDefault(path, defaultValue);
      }
      value = value[key];
    }

    if (value === undefined) {
      return this.#useDefault(path, defaultValue);
    }

    return value ?? defaultValue;
  }

  getBoolean(path, defaultValue = false) {
    const rawValue = this.get(path, undefined);
    const parsed = parseOptionalBool(rawValue);
    if (parsed !== undefined) {
      return parsed;
    }

    if (typeof rawValue === 'boolean') {
      return rawValue;
    }

    if (rawValue !== undefined && rawValue !== null) {
      if (typeof rawValue === 'number') {
        return rawValue !== 0;
      }
      if (typeof rawValue === 'string') {
        const normalized = rawValue.trim().toLowerCase();
        if (TRUE_VALUES.has(normalized)) {
          return true;
        }
        if (FALSE_VALUES.has(normalized)) {
          return false;
        }
      }
    }

    const fallbackParsed = parseOptionalBool(defaultValue);
    if (fallbackParsed !== undefined) {
      return fallbackParsed;
    }

    return Boolean(defaultValue);
  }

  getNumber(path, defaultValue = undefined) {
    const value = this.get(path, defaultValue);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  }

  listSections() {
    return Object.keys(this.schemas);
  }

  #useDefault(path, defaultValue) {
    // Suppress warning for ollama section when not configured
    if (path === 'ollama' && defaultValue !== undefined) {
      return defaultValue;
    }
    
    if (!this.missingDefaults.has(path)) {
      this.missingDefaults.add(path);
      logger.debug(
        `[ConfigService] Значение для "${path}" отсутствует; используется дефолт (${JSON.stringify(defaultValue)})`,
      );
    }
    return defaultValue;
  }

  #assertCritical() {
    const mongo = this.getSection('mongo');
    if (!mongo.uri) {
      throw new Error('MONGO_URI обязателен, но не настроен.');
    }

    if (this.env.MONGODB_URI && !this.env.MONGO_URI) {
      logger.warn(
        '[ConfigService] Обнаружен MONGODB_URI. Пожалуйста, мигрируйте на MONGO_URI и удалите устаревшую переменную.',
      );
    }

    const nats = this.getSection('nats');
    if (nats.enabled && nats.servers.length === 0) {
      throw new Error('NATS_SERVERS должен быть настроен когда NATS_ENABLED=true.');
    }

    const queues = this.getSection('queues');
    if (!queues.toolsGatewayUrl) {
      logger.warn(
        '[ConfigService] toolsGatewayUrl не настроен. Temporal HTTP fallback может быть недоступен.',
      );
    }

    const rag = this.getSection('rag');
    if (!rag.url) {
      logger.warn(
        '[ConfigService] URL сервиса RAG не настроен. Обогащение контекста RAG может не работать.',
      );
    }
  }
}

const configService = new ConfigService();

module.exports = configService;
module.exports.ConfigService = ConfigService;
