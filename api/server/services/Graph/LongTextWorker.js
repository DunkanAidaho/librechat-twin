"use strict";

const crypto = require("crypto");
const EventEmitter = require("events");
const { sendEvent } = require("@librechat/api");
const configService = require("~/server/services/Config/ConfigService");
const { enqueueMemoryTasks } = require("~/server/services/RAG/memoryQueue");
const { incLongTextGraphChunk } = require("~/utils/metrics");
const { runWithResilience } = require("~/server/utils/resilience");
const {
  isEnabled: isNatsEnabled,
  getOrCreateKV,
  sc,
} = require("~/utils/natsClient");
const { enqueueGraphTask } = require("~/utils/temporalClient");
const { getLogger } = require("~/utils/logger");
const { buildContext } = require("~/utils/logContext");

/**
 * Конфигурация воркера chunk-инжеста длинных текстов в граф.
 */
const memoryConfig = configService.getSection("memory");
const graphConfig = memoryConfig.graphContext || {};
const longTextConfig = memoryConfig.longTextChunk || {};

const GRAPH_REQUEST_TIMEOUT_MS = graphConfig.requestTimeoutMs || 30_000;
const GRAPH_RELATIONS_LIMIT = configService.getNumber(
  "memory.graphContext.maxLines",
  40,
);
const GRAPH_CONTEXT_LINE_LIMIT = configService.getNumber(
  "memory.graphContext.maxLines",
  40,
);
const GRAPH_CONTEXT_MAX_LINE_CHARS = configService.getNumber(
  "memory.graphContext.maxLineChars",
  200,
);
const GRAPH_CONTEXT_SUMMARY_HINT_MAX_CHARS = configService.getNumber(
  "memory.graphContext.summaryHintMaxChars",
  2_000,
);

const CHUNK_MAX_CHARS = longTextConfig.maxChars || 4_000;
const CHUNK_MIN_CHARS = longTextConfig.minChars || 1_500;
const CHUNK_ADAPTIVE_DELTA_MS = longTextConfig.adaptiveDeltaMs || 5_000;
const CHUNK_TIMEOUT_MAX_MS = longTextConfig.maxTimeoutMs || 300_000;
const LONG_TEXT_CHUNK_BUCKET = longTextConfig.bucket || "long_text_chunks";

/**
 * Regex для мягкого разделения текста по предложениям/абзацам.
 */
const SENTENCE_DELIMITER = /(?<=[\.\!\?])\s+/; // точка/восклицательный/вопросительный знаки
const NEWLINE_DELIMITER = /\n{2,}/;

/**
 * Status ключи в KV
 */
const VECTOR_FLAG = "vectorizedAt";
const GRAPH_ENQUEUED_FLAG = "graphQueuedAt";
const GRAPH_DONE_FLAG = "graphProcessedAt";

/**
 * Вспомогательный event emitter (можно в дальнейшем переключить на NATS/SSE).
 */
const workerEvents = new EventEmitter();
const workerOptions = new WeakMap();
const logger = getLogger("rag.longTextWorker");

/**
 * Возвращает SHA1-хэш переданного текста.
 * @param {string} text
 * @returns {string}
 */
function sha1(text = "") {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex");
}

/**
 * Нарезает длинный текст на chunks размером 2–4к символов с уважением к границам предложений.
 * @param {string} text
 * @param {{ maxChars?: number, minChars?: number }} options
 * @returns {Array<{ idx: number, content: string, hash: string }>}
 */
function createChunks(text, options = {}) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw.length) {
    return [];
  }

  const maxChars = options.maxChars || CHUNK_MAX_CHARS;
  const minChars = options.minChars || CHUNK_MIN_CHARS;

  if (raw.length <= maxChars) {
    return [
      {
        idx: 0,
        content: raw,
        hash: sha1(raw),
      },
    ];
  }

  const segments = raw
    .split(NEWLINE_DELIMITER)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const sentences = segments.flatMap((segment) =>
    segment.split(SENTENCE_DELIMITER).filter(Boolean),
  );
  if (!sentences.length) {
    return [
      {
        idx: 0,
        content: raw.slice(0, maxChars),
        hash: sha1(raw.slice(0, maxChars)),
      },
    ];
  }

  const chunks = [];
  let buffer = "";

  const flush = () => {
    const chunkText = buffer.trim();
    if (!chunkText) {
      buffer = "";
      return;
    }
    chunks.push({ idx: chunks.length, content: chunkText, hash: sha1(chunkText) });
    buffer = "";
  };

  for (const sentence of sentences) {
    const candidate = buffer ? `${buffer} ${sentence}` : sentence;
    if (candidate.length >= maxChars) {
      flush();
      buffer = sentence;
      continue;
    }
    buffer = candidate;
  }

  if (buffer.trim().length) {
    if (buffer.length < minChars && chunks.length) {
      // приклеиваем хвост к предыдущему chunk-у
      const last = chunks[chunks.length - 1];
      last.content = `${last.content} ${buffer}`.trim();
      last.hash = sha1(last.content);
    } else {
      flush();
    }
  }

  return chunks;
}

/**
 * Создаёт адаптивный таймаут для chunk-а.
 * @param {number} chunkIndex
 * @param {number} baseTimeout
 * @returns {number}
 */
function calcAdaptiveTimeout(chunkIndex, baseTimeout = GRAPH_REQUEST_TIMEOUT_MS) {
  const adaptive = baseTimeout + chunkIndex * CHUNK_ADAPTIVE_DELTA_MS;
  return Math.min(adaptive, CHUNK_TIMEOUT_MAX_MS);
}

/**
 * Управление статусами chunk-ов через KV long_text_chunks.
 */
class ChunkStore {
  constructor() {
    this.kvPromise = null;
  }

  async init() {
    if (!isNatsEnabled()) {
      throw new Error("NATS недоступен: KV long_text_chunks нужен для chunkStore");
    }
    if (!this.kvPromise) {
      this.kvPromise = getOrCreateKV(LONG_TEXT_CHUNK_BUCKET, {
        history: 1,
      });
    }
    return this.kvPromise;
  }

  #createKey(conversationId, chunkHash) {
    if (!conversationId || !chunkHash) {
      throw new Error("conversationId и chunkHash обязательны для chunkStore");
    }
    const safeConversationId = sanitizeKeyPart(conversationId);
    const safeHash = sanitizeKeyPart(chunkHash);
    // JetStream KV требует ключи только из [A-Za-z0-9_-]
    return `chunk_status_${safeConversationId}_${safeHash}`;
  }

  async get(conversationId, chunkHash) {
    const kv = await this.init();
    const key = this.#createKey(conversationId, chunkHash);
    const entry = await kv.get(key);
    if (!entry?.value) {
      return {};
    }
    try {
      return JSON.parse(sc.decode(entry.value));
    } catch (error) {
      logger.warn(
        "rag.longText.chunk_store_error",
        buildContext({}, { key, err: error })
      );
      return {};
    }
  }

  async set(conversationId, chunkHash, data = {}) {
    const kv = await this.init();
    const key = this.#createKey(conversationId, chunkHash);
    const payload = JSON.stringify({ conversationId, chunkHash, ...(data || {}) });
    await kv.put(key, sc.encode(payload));
    return data;
  }

  async merge(conversationId, chunkHash, patch = {}) {
    const current = (await this.get(conversationId, chunkHash)) || {};
    const merged = { ...current, ...patch };
    await this.set(conversationId, chunkHash, merged);
    return merged;
  }
}

function sanitizeKeyPart(value = "") {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 256);
}

const chunkStore = new ChunkStore();

/**
 * Основной worker: принимает событие "indexed" и по-чанково проводит векторизацию и графовый enqueue.
 */
class LongTextGraphWorker {
  constructor() {
    this.initialized = false;
    this.queue = Promise.resolve();
    this.enabled = isNatsEnabled();
  }

  /**
   * Подписка на события — сейчас используем внутренний emitter (можно заменить на SSE/NATS позже).
   */
  start(options = {}) {
    if (this.initialized) {
      return;
    }
    if (!this.enabled) {
      logger.warn(
        "rag.longText.start_skip",
        buildContext({}, { reason: "nats_disabled" })
      );
      return;
    }
    workerOptions.set(this, { sendProgressEvents: options.sendProgressEvents !== false });
    workerEvents.on("long_text_indexed", (event) => {
      this.enqueue(event);
    });
    this.initialized = true;
    logger.info("rag.longText.start", buildContext({}, {}));
  }

  /**
   * Внешняя точка входа из AgentController: руками эмитим событие.
   */
  enqueue(event) {
    if (!this.enabled) {
      logger.debug(
        "rag.longText.enqueue_skip",
        buildContext({}, { reason: "nats_disabled" })
      );
      return;
    }
    if (!event || typeof event !== "object") {
      logger.warn(
        "rag.longText.enqueue_invalid",
        buildContext({}, { eventType: typeof event })
      );
      return;
    }
    this.queue = this.queue.finally(() => this.process(event));
  }

  async process({ conversationId, userId, messageId, text, dedupeKey, res }) {
    const baseContext = buildContext({ conversationId, userId, requestId: dedupeKey }, { messageId });
    if (!this.enabled) {
      logger.info(
        "rag.longText.skip",
        buildContext(baseContext, { reason: "nats_disabled", messageId })
      );
      return;
    }
    if (!conversationId || !userId) {
      logger.warn(
        "rag.longText.skip",
        buildContext(baseContext, { reason: "missing_ids", messageId })
      );
      return;
    }

    const rawText = typeof text === "string" && text.trim().length ? text : "";
    if (!rawText) {
      logger.warn(
        "rag.longText.skip",
        buildContext(baseContext, { reason: "empty_text", messageId })
      );
      return;
    }

    const chunks = createChunks(rawText);
    if (!chunks.length) {
      logger.warn(
        "rag.longText.skip",
        buildContext(baseContext, { reason: "no_chunks", messageId })
      );
      return;
    }

    logger.info(
      "rag.longText.chunk_start",
      buildContext(baseContext, { chunkCount: chunks.length })
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        await this.processChunk({
          chunk,
          chunks,
          conversationId,
          userId,
          dedupeKey: dedupeKey || messageId,
          originalMessageId: messageId,
        });
        this.emitProgress({
          res,
          conversationId,
          status: "graph_ingest_chunk",
          progress: {
            current: i + 1,
            total: chunks.length,
          },
        });
      } catch (error) {
        logger.error(
          "rag.longText.chunk_error",
          buildContext(baseContext, {
            chunkIdx: chunk.idx,
            chunkHash: chunk.hash,
            chunkChars: chunk.content.length,
            err: error,
          })
        );
      }
    }

    logger.info(
      "rag.longText.done",
      buildContext(baseContext, { chunkCount: chunks.length })
    );

    this.emitProgress({
      res,
      conversationId,
      status: "graph_ready",
      progress: {
        current: chunks.length,
        total: chunks.length,
      },
    });
  }

  async processChunk({ chunk, chunks, conversationId, userId, dedupeKey, originalMessageId }) {
    const { idx, content, hash } = chunk;
    const chunkContext = buildContext({ conversationId, userId }, { chunkIdx: idx, chunkHash: hash });
    const chunkStatus = await chunkStore.get(conversationId, hash);

    if (!chunkStatus[VECTOR_FLAG]) {
      try {
        await this.enqueueVectorChunk({ chunk, conversationId, userId, dedupeKey });
        await chunkStore.merge(conversationId, hash, { [VECTOR_FLAG]: new Date().toISOString() });
        incLongTextGraphChunk("vectorized");
      } catch (error) {
        logger.error(
          "rag.longText.vector_error",
          buildContext(chunkContext, { dedupeKey, err: error })
        );
        throw error;
      }
    }

    if (!chunkStatus[GRAPH_ENQUEUED_FLAG]) {
      try {
        await this.enqueueGraphChunk({
          chunk,
          chunkCount: chunks.length,
          conversationId,
          userId,
          dedupeKey,
          originalMessageId,
        });
        await chunkStore.merge(conversationId, hash, {
          [GRAPH_ENQUEUED_FLAG]: new Date().toISOString(),
        });
        incLongTextGraphChunk("graph_enqueued");
      } catch (error) {
        logger.error(
          "rag.longText.graph_error",
          buildContext(chunkContext, { dedupeKey, err: error })
        );
        throw error;
      }
    }
  }

  async enqueueVectorChunk({ chunk, conversationId, userId, dedupeKey }) {
    const { content, hash, idx } = chunk;
    const vectorKey = `vector:${conversationId}:${hash}`;
    const payload = {
      conversation_id: conversationId,
      message_id: `${vectorKey}`,
      user_id: userId,
      role: "system",
      content,
      created_at: new Date().toISOString(),
      ingest_dedupe_key: vectorKey,
    };

    logger.info(
      "rag.longText.vector_enqueue",
      buildContext({ conversationId, userId }, { chunkIdx: idx, chunkHash: hash, dedupeKey: vectorKey })
    );

    await enqueueMemoryTasks(
      [
        {
          type: "index_text",
          payload,
          meta: { dedupe_key: vectorKey },
        },
      ],
      {
        reason: "long_text_chunk",
        conversationId,
        userId,
        dedupeKey: vectorKey,
      },
    );
  }

  async enqueueGraphChunk({
    chunk,
    chunkCount,
    conversationId,
    userId,
    dedupeKey,
    originalMessageId,
  }) {
    const { idx, content, hash } = chunk;
    const graphKey = `graph:${conversationId}:${hash}`;
    const messageId = `${originalMessageId || dedupeKey || "chunk"}-${idx}`;

    const payload = {
      user_id: userId,
      conversation_id: conversationId,
      message_id: messageId,
      role: "system",
      content,
      context_flags: ["long_text_ingest"],
      entities: [],
      relations: [],
      created_at: new Date().toISOString(),
      metadata: {
        dedupe_key: graphKey,
        chunk_idx: idx,
        chunk_total: chunkCount,
        graph_limits: {
          GRAPH_RELATIONS_LIMIT,
          GRAPH_CONTEXT_LINE_LIMIT,
          GRAPH_CONTEXT_MAX_LINE_CHARS,
          GRAPH_CONTEXT_SUMMARY_HINT_MAX_CHARS,
        },
      },
    };

    const timeoutMs = calcAdaptiveTimeout(idx, GRAPH_REQUEST_TIMEOUT_MS);

    logger.info(
      "rag.longText.graph_enqueue",
      buildContext({ conversationId, userId }, {
        chunkIdx: idx,
        chunkCount,
        timeoutMs,
        graphKey,
        messageId,
      })
    );

    await runWithResilience(
      "enqueueGraphChunk",
      () => enqueueGraphTask(payload),
      {
        timeoutMs,
        retries: 3,
        minDelay: 500,
        maxDelay: 8_000,
      },
    );
  }

  emitProgress({ res, conversationId, status, progress }) {
    const { sendProgressEvents } = workerOptions.get(this) || {};
    if (!sendProgressEvents || !res || typeof sendEvent !== "function") {
      return;
    }

    try {
      sendEvent(res, {
        meta: {
          longTextInfo: {
            status,
            conversationId,
            progress,
          },
        },
      });
    } catch (error) {
      logger.debug(
        "rag.longText.sse_error",
        buildContext({ conversationId }, { status, err: error })
      );
    }
  }
}

const longTextGraphWorker = new LongTextGraphWorker();

module.exports = {
  chunkStore,
  createChunks,
  calcAdaptiveTimeout,
  LongTextGraphWorker: longTextGraphWorker,
  workerEvents,
};