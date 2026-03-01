const crypto = require("crypto");
const EventEmitter = require("events");
const { EventService } = require("../Events/EventService");
const { configService } = require("../Config/ConfigService");
const { enqueueMemoryTasks } = require("../RAG/memoryQueue");
const { incLongTextGraphChunk } = require("../../../utils/metrics");
const { runWithResilience } = require("../../utils/resilience");
const {
  isEnabled: isNatsEnabled,
  getOrCreateKV,
  sc,
} = require("../../../utils/natsClient");
const { enqueueGraphTask } = require("../../../utils/temporalClient");
const { getLogger } = require("../../../utils/logger");
const { buildContext } = require("../../../utils/logContext");

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
const eventService = new EventService(); // Создаем единственный экземпляр для всего воркера

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

  const chunks = [];
  let currentChunk = "";
  let currentIdx = 0;

  const sentences = raw
    .split(SENTENCE_DELIMITER)
    .flatMap((block) => block.split(NEWLINE_DELIMITER))
    .map((s) => s.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > maxChars && currentChunk.length >= minChars) {
      chunks.push({
        idx: currentIdx++,
        content: currentChunk.trim(),
        hash: sha1(currentChunk),
      });
      currentChunk = sentence;
    } else {
      currentChunk = currentChunk ? `${currentChunk} ${sentence}` : sentence;
    }
  }

  if (currentChunk) {
    chunks.push({
      idx: currentIdx,
      content: currentChunk.trim(),
      hash: sha1(currentChunk),
    });
  }

  return chunks;
}

class LongTextGraphWorker {
  static async processChunk(chunk, chunks, { conversationId, messageId, res }) {
    try {
      eventService.sendEvent(res, {
        meta: {
          longTextInfo: {
            status: "chunk_processed",
            chunkIndex: chunk.idx,
            totalChunks: chunks.length,
            conversationId,
            messageId,
          },
        },
      });
    } catch (error) {
      logger.error("[LongTextGraphWorker] Failed to send chunk progress", {
        error,
        chunkIndex: chunk.idx,
        conversationId,
        messageId,
      });
    }
  }

  static async enqueue({ text, conversationId, messageId, userId, res }) {
    const chunks = createChunks(text);
    if (!chunks.length) return;

    for (const chunk of chunks) {
      await this.processChunk(chunk, chunks, { conversationId, messageId, res });
      incLongTextGraphChunk();
    }
  }

  static start(options = {}) {
    workerOptions.set(this, options);
    return this;
  }
}

module.exports = {
  LongTextGraphWorker,
  createChunks,
};