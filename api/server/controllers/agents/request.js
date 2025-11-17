// /opt/open-webui/request.js - ИСПРАВЛЕННАЯ ВЕРСИЯ
const {
  observeSendMessage,
  incSendMessageFailure,
  observeMemoryQueueLatency,
  incMemoryQueueFailure,
  observeSummaryEnqueue,
  incSummaryEnqueueFailure,
  incSummaryEnqueueTotal,
  observeGraphEnqueue,
  incGraphEnqueueFailure,
  incGraphEnqueueTotal,
  setTemporalStatus,
} = require('~/utils/metrics');

const { sendEvent } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const natsClient = require('~/utils/natsClient');
const { retryAsync, withTimeout } = require('~/utils/async');

const {
  handleAbortError,
  createAbortController,
} = require('~/server/middleware');
const { disposeClient, clientRegistry, requestDataMap } = require('~/server/cleanup');

const {
  saveMessage,
  getConvo,
  getMessages,
  getConvoTitle,
  saveConvo,
} = require('~/models');

const { enqueueMemoryTasks } = require('~/server/services/RAG/memoryQueue');
const ingestDeduplicator = require('~/server/services/Deduplication/ingestDeduplicator');
const { enqueueGraphTask, enqueueSummaryTask } = require('~/utils/temporalClient');



const HEADLESS_STREAM = (process.env.HEADLESS_STREAM || 'false').toLowerCase() === 'true';
const MAX_USER_MSG_TO_MODEL_CHARS = parseInt(process.env.MAX_USER_MSG_TO_MODEL_CHARS || '200000', 10);
const RAG_CONTEXT_MAX_CHARS = parseInt(process.env.RAG_CONTEXT_MAX_CHARS || '60000', 10);
const RAG_CONTEXT_TOPK = parseInt(process.env.RAG_CONTEXT_TOPK || '12', 10);
const GOOGLE_NOSTREAM_THRESHOLD = parseInt(process.env.GOOGLE_NOSTREAM_THRESHOLD || '120000', 10);

const SUMMARIZATION_THRESHOLD = parseInt(process.env.SUMMARIZATION_THRESHOLD || '10', 10);
const MAX_MESSAGES_PER_SUMMARY = parseInt(process.env.MAX_MESSAGES_PER_SUMMARY || '40', 10);
const SUMMARIZATION_LOCK_TTL = parseInt(process.env.SUMMARIZATION_LOCK_TTL || '20', 10);
const TEMPORAL_SUMMARY_REASON = 'summary_queue';
const TEMPORAL_GRAPH_REASON = 'graph_queue';

  /**
   * @description Parses environment variable as integer with fallback.
   * @param {string} name - Environment variable name.
   * @param {number} defaultValue - Default value if parsing fails.
   * @returns {number} Parsed integer or default.
   */
const getEnvInt = (name, defaultValue) => {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return defaultValue;
  }

  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
};

  /**
   * @description Parses environment variable as float with fallback.
   * @param {string} name - Environment variable name.
   * @param {number} defaultValue - Default value if parsing fails.
   * @returns {number} Parsed float or default.
   */
const getEnvFloat = (name, defaultValue) => {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return defaultValue;
  }

  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? defaultValue : parsed;
};

const RETRY_MIN_DELAY_MS = Math.max(0, getEnvInt('AGENT_RETRY_MIN_DELAY_MS', 200));
const RETRY_MAX_DELAY_MS = Math.max(RETRY_MIN_DELAY_MS, getEnvInt('AGENT_RETRY_MAX_DELAY_MS', 5000));
const RETRY_BACKOFF_FACTOR = Math.max(1, getEnvFloat('AGENT_RETRY_BACKOFF_FACTOR', 2));
const RETRY_JITTER = Math.min(Math.max(0, getEnvFloat('AGENT_RETRY_JITTER', 0.2)), 1);

const RESILIENCE_CONFIG = Object.freeze({
  initializeClient: {
    timeoutMs: Math.max(0, getEnvInt('AGENT_INIT_CLIENT_TIMEOUT_MS', 15000)),
    retries: Math.max(0, getEnvInt('AGENT_INIT_CLIENT_RETRIES', 2)),
  },
  sendMessage: {
    timeoutMs: Math.max(0, getEnvInt('AGENT_SEND_MESSAGE_TIMEOUT_MS', 120000)),
    retries: Math.max(0, getEnvInt('AGENT_SEND_MESSAGE_RETRIES', 1)),
  },
  memoryQueue: {
    timeoutMs: Math.max(0, getEnvInt('AGENT_MEMORY_QUEUE_TIMEOUT_MS', 15000)),
    retries: Math.max(0, getEnvInt('AGENT_MEMORY_QUEUE_RETRIES', 2)),
  },
  summaryEnqueue: {
    timeoutMs: Math.max(0, getEnvInt('AGENT_SUMMARY_ENQUEUE_TIMEOUT_MS', 15000)),
    retries: Math.max(0, getEnvInt('AGENT_SUMMARY_ENQUEUE_RETRIES', 2)),
  },
  graphEnqueue: {
    timeoutMs: Math.max(0, getEnvInt('AGENT_GRAPH_ENQUEUE_TIMEOUT_MS', 15000)),
    retries: Math.max(0, getEnvInt('AGENT_GRAPH_ENQUEUE_RETRIES', 2)),
  },
  saveConvo: {
    timeoutMs: Math.max(0, getEnvInt('AGENT_SAVE_CONVO_TIMEOUT_MS', 10000)),
    retries: Math.max(0, getEnvInt('AGENT_SAVE_CONVO_RETRIES', 1)),
  },
});

  /**
   * @description Retrieves resilience configuration for a given operation key.
   * @param {string} key - Configuration key (e.g., 'sendMessage').
   * @returns {Object} Configuration object with timeoutMs and retries.
   */
const getResilienceConfig = (key) => {
  const config = RESILIENCE_CONFIG[key];
  if (!config) {
    return { timeoutMs: 0, retries: 0 };
  }
  return { ...config };
};

  /**
   * @description Executes a function with resilience (retries, timeout, backoff).
   * @param {string} operationName - Name of the operation for logging.
   * @param {function} fn - Function to execute, receives {attempt}.
   * @param {Object} [options] - Resilience options.
   * @param {number} [options.timeoutMs=0] - Timeout in milliseconds.
   * @param {number} [options.retries=0] - Number of retries.
   * @param {string} [options.timeoutMessage] - Custom timeout message.
   * @param {AbortSignal} [options.signal] - Abort signal.
   * @param {number} [options.minDelay] - Min delay for retries.
   * @param {number} [options.maxDelay] - Max delay for retries.
   * @param {number} [options.factor] - Backoff factor.
   * @param {number} [options.jitter] - Jitter for randomization.
   * @param {function} [options.onRetry] - Callback on retry.
   * @returns {Promise<any>} Result of the function.
   * @throws {Error} If all attempts fail.
   * @example
   * await runWithResilience('sendMessage', async () => send(), { retries: 2 });
   */
async function runWithResilience(operationName, fn, options = {}) {
  const {
    timeoutMs = 0,
    retries = 0,
    timeoutMessage,
    signal,
    minDelay = RETRY_MIN_DELAY_MS,
    maxDelay = RETRY_MAX_DELAY_MS,
    factor = RETRY_BACKOFF_FACTOR,
    jitter = RETRY_JITTER,
    onRetry,
  } = options;

  const normalizedRetries = Math.max(0, retries);
  const normalizedMinDelay = Number.isFinite(minDelay) ? Math.max(0, minDelay) : RETRY_MIN_DELAY_MS;
  const normalizedMaxDelayRaw = Number.isFinite(maxDelay) ? Math.max(0, maxDelay) : RETRY_MAX_DELAY_MS;
  const normalizedMaxDelay = Math.max(normalizedMinDelay, normalizedMaxDelayRaw);
  const normalizedFactor = Number.isFinite(factor) && factor >= 1 ? factor : RETRY_BACKOFF_FACTOR;
  const normalizedJitter = Number.isFinite(jitter) ? Math.min(Math.max(0, jitter), 1) : RETRY_JITTER;
  const hasTimeout = Boolean(timeoutMs && timeoutMs > 0);
  const startedAt = Date.now();

  const attemptExecutor = (attempt) => {
    const promise = Promise.resolve(fn({ attempt }));
    if (!hasTimeout) {
      return promise;
    }
    return withTimeout(
      promise,
      timeoutMs,
      timeoutMessage || `Операция ${operationName} превысила таймаут`,
      signal,
    );
  };

  if (normalizedRetries <= 0) {
    return attemptExecutor(0);
  }

  const retryOptions = {
    retries: normalizedRetries,
    minDelay: normalizedMinDelay,
    maxDelay: normalizedMaxDelay,
    factor: normalizedFactor,
    jitter: normalizedJitter,
    signal,
    onRetry: async (error, attemptNumber) => {
      const nextAttempt = attemptNumber + 1;
      logger.warn(
        '[AgentController] Повторная попытка %s после ошибки в %s: %s',
        nextAttempt,
        operationName,
        error?.message || error,
      );
      if (typeof onRetry === 'function') {
        try {
          await onRetry(error, nextAttempt);
        } catch (hookErr) {
          logger.error(
            '[AgentController] Ошибка в пользовательском onRetry (%s): %s',
            operationName,
            hookErr?.message || hookErr,
          );
          throw hookErr;
        }
      }
    },
  };

  try {
    const result = await retryAsync(attemptExecutor, retryOptions);
    const durationMs = Date.now() - startedAt;
    logger.debug(
      '[AgentController] Операция %s завершена, попыток=%s, длительность=%sms',
      operationName,
      normalizedRetries + 1,
      durationMs,
    );
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logger.error(
      '[AgentController] Операция %s провалилась спустя %sms: %s',
      operationName,
      durationMs,
      err?.message || err,
    );
    throw err;
  }
}

  /**
   * @description Normalizes a label value, trimming and providing fallback.
   * @param {string} value - Value to normalize.
   * @param {string} [fallback='unknown'] - Fallback if value is invalid.
   * @returns {string} Normalized value or fallback.
   */
const normalizeLabelValue = (value, fallback = 'unknown') => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

  /**
   * @description Enqueues memory tasks with resilience and metrics.
   * @param {Array} tasks - Array of tasks to enqueue.
   * @param {Object} [meta={}] - Metadata for tasks.
   * @param {Object} [options={}] - Additional resilience options.
   * @returns {Promise<any>} Enqueue result.
   * @throws {Error} If enqueue fails after retries.
   */
async function enqueueMemoryTasksWithResilience(tasks, meta = {}, options = {}) {
  const startedAt = Date.now();
  const reasonLabel = normalizeLabelValue(meta?.reason);
  const config = getResilienceConfig('memoryQueue');
  const mergedOptions = { ...config, ...options };

  try {
    const result = await runWithResilience(
      'enqueueMemoryTasks',
      () => enqueueMemoryTasks(tasks, meta),
      mergedOptions,
    );
    observeMemoryQueueLatency({ reason: reasonLabel, status: 'success' }, Date.now() - startedAt);
    return result;
  } catch (error) {
    observeMemoryQueueLatency({ reason: reasonLabel, status: 'failure' }, Date.now() - startedAt);
    incMemoryQueueFailure(reasonLabel);
    throw error;
  }
}

  /**
   * @description Enqueues summary task with resilience and metrics.
   * @param {Object} job - Job payload for summary.
   * @param {Object} [options={}] - Additional resilience options.
   * @returns {Promise<any>} Enqueue result.
   * @throws {Error} If enqueue fails after retries.
   */
async function enqueueSummaryTaskWithResilience(job, options = {}) {
  const startedAt = Date.now();
  const config = getResilienceConfig('summaryEnqueue');
  const mergedOptions = { ...config, ...options };

  try {
    const result = await runWithResilience(
      'enqueueSummaryTask',
      () => enqueueSummaryTask(job),
      mergedOptions,
    );
    incSummaryEnqueueTotal();
    setTemporalStatus(TEMPORAL_SUMMARY_REASON, true);
    observeSummaryEnqueue({ status: 'success' }, Date.now() - startedAt);
    return result;
  } catch (error) {
    setTemporalStatus(TEMPORAL_SUMMARY_REASON, false);
    observeSummaryEnqueue({ status: 'failure' }, Date.now() - startedAt);
    incSummaryEnqueueFailure(normalizeLabelValue(error?.code || error?.name || error?.message));
    throw error;
  }
}

  /**
   * @description Enqueues graph task with resilience and metrics.
   * @param {Object} payload - Payload for graph task.
   * @param {Object} [options={}] - Additional resilience options.
   * @returns {Promise<any>} Enqueue result.
   * @throws {Error} If enqueue fails after retries.
   */
async function enqueueGraphTaskWithResilience(payload, options = {}) {
  const startedAt = Date.now();
  const config = getResilienceConfig('graphEnqueue');
  const mergedOptions = { ...config, ...options };

  try {
    const result = await runWithResilience(
      'enqueueGraphTask',
      () => enqueueGraphTask(payload),
      mergedOptions,
    );
    incGraphEnqueueTotal();
    setTemporalStatus(TEMPORAL_GRAPH_REASON, true);
    observeGraphEnqueue({ status: 'success' }, Date.now() - startedAt);
    return result;
  } catch (error) {
    setTemporalStatus(TEMPORAL_GRAPH_REASON, false);
    observeGraphEnqueue({ status: 'failure' }, Date.now() - startedAt);
    incGraphEnqueueFailure(normalizeLabelValue(error?.code || error?.name || error?.message));
    throw error;
  }
}

  /**
   * @description Saves conversation with resilience.
   * @param {Object} req - Request object.
   * @param {Object} data - Conversation data.
   * @param {Object} [options={}] - Save options.
   * @param {Object} [resilienceOptions={}] - Resilience options.
   * @returns {Promise<any>} Save result.
   * @throws {Error} If save fails after retries.
   */
async function saveConvoWithResilience(req, data, options = {}, resilienceOptions = {}) {
  const config = getResilienceConfig('saveConvo');
  const mergedOptions = { ...config, ...resilienceOptions };
  return runWithResilience(
    'saveConvo',
    () => saveConvo(req, data, options),
    mergedOptions,
  );
}

const summarizationLocks = new Map();
  /**
   * @description Acquires a lock for summarization to prevent duplicates.
   * @param {string} conversationId - Conversation ID.
   * @returns {boolean} True if lock acquired, false if already locked.
   */
function acquireSummarizationLock(conversationId) {
  const ttlMs = Math.max(1, SUMMARIZATION_LOCK_TTL) * 1000;
  const now = Date.now();
  const entry = summarizationLocks.get(conversationId);
  if (entry && now - entry.timestamp < ttlMs) {
    return false;
  }
  if (entry?.timeout) {
    clearTimeout(entry.timeout);
  }
  const timeout = setTimeout(() => summarizationLocks.delete(conversationId), ttlMs);
  summarizationLocks.set(conversationId, { timestamp: now, timeout });
  return true;
}
  /**
   * @description Releases the summarization lock.
   * @param {string} conversationId - Conversation ID.
   * @returns {void}
   */
function releaseSummarizationLock(conversationId) {
  const entry = summarizationLocks.get(conversationId);
  if (entry?.timeout) {
    clearTimeout(entry.timeout);
  }
  summarizationLocks.delete(conversationId);
}

  /**
   * @description Extracts deduplication keys from tasks.
   * @param {Array} [tasks=[]] - Array of tasks.
   * @returns {Array<string>} Array of dedupe keys.
   */
const extractDedupeKeys = (tasks = []) => {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return [];
  }
  const keys = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const payload = task.payload && typeof task.payload === 'object' ? task.payload : task;
      const key = task.meta?.dedupe_key || payload?.ingest_dedupe_key;
    if (key) keys.push(key);
  }
  return keys;
};


// Note: retrieveContext function is no longer needed here as logic is moved to client.js

  /**
   * @description Checks if response is writable.
   * @param {Object} res - Response object.
   * @returns {boolean} True if writable.
   */
function canWrite(res) {
  return Boolean(res) && res.writable !== false && !res.writableEnded;
}
  /**
   * @description Creates a detachable response wrapper.
   * @param {Object} res - Original response object.
   * @returns {Object} Detachable response object.
   */
function makeDetachableRes(res) {
  let detached = false;
  return {
    setDetached(v = true) { detached = v; },
    write(...args) { if (!detached && canWrite(res)) { try { return res.write(...args); } catch(_) { return true; } } return true; },

    end(...args) { if (!detached && canWrite(res)) { try { return res.end(...args); } catch(_) {} } },
    flushHeaders() { if (!detached && typeof res.flushHeaders === 'function') { try { res.flushHeaders(); } catch(_) {} } },
    get headersSent() { return detached ? true : res.headersSent; },
    get finished() { return detached ? true : res.finished; },
    on: (...args) => res.on(...args),
    removeListener: (...args) => res.removeListener(...args),
  };
}

  /**
   * @description Checks if response is finalized.
   * @param {Object} resLike - Response-like object.
   * @returns {boolean} True if finalized.
   */
function isResponseFinalized(resLike) {
  if (!resLike) return false;
  return Boolean(resLike.finished || resLike.headersSent);
}

// Генерим заголовок только при первом обмене и если title пустой/"New Chat"
  /**
   * @description Determines if title should be generated for conversation.
   * @param {Object} req - Request object.
   * @param {string} conversationId - Conversation ID.
   * @returns {Promise<boolean>} True if title should be generated.
   * @throws {Error} If check fails.
   */
async function shouldGenerateTitle(req, conversationId) {
  try {

    const convo = await getConvo(req.user.id, conversationId);
    const title = (convo?.title || '').trim();
    if (title && !/new chat/i.test(title)) return false;
    const msgs = await getMessages({ conversationId });
    return (msgs?.length || 0) <= 2; // user + первый assistant
  } catch (e) {
    logger.error(`[title] проверка не удалась`, e);
    return false;
  }
}

  /**
   * @description Main controller for agent requests, handling messages, RAG, and streaming.
   * @param {Object} req - Express request object.
   * @param {Object} res - Express response object.
   * @param {function} next - Express next function.
   * @param {function} initializeClient - Function to initialize client.
   * @param {function} addTitle - Function to add title.
   * @returns {Promise<void>}
   * @throws {Error} If processing fails.
   */
const AgentController = async (req, res, next, initializeClient, addTitle) => {
  let {
    text,
    isRegenerate,
    endpointOption,
    conversationId: initialConversationId,
    isContinued = false,
    editedContent = null,
    parentMessageId = null,
    overrideParentMessageId = null,
    responseMessageId: editedResponseMessageId = null,
  } = req.body;

  let conversationId = initialConversationId;
  const pendingIngestMarks = new Set();
    /**
     * @description Safely enqueues memory tasks with dedupe key management.
     * @param {Array} tasks - Array of tasks to enqueue.
     * @param {Object} [meta={}] - Metadata for tasks.
     * @param {Object} [options={}] - Additional options.
     * @returns {Promise<Object>} Result with success and error fields.
     */
  const enqueueMemoryTasksSafe = async (tasks, meta = {}, options = {}) => {
    const dedupeKeys = extractDedupeKeys(tasks);
    try {
      const result = await enqueueMemoryTasksWithResilience(tasks, meta, options);
      if (result?.status === 'queued' && dedupeKeys.length > 0) {
        for (const key of dedupeKeys) {
          try {
            if (natsClient) {
              await natsClient.publish('tasks.clear', { action: 'clearIngestedMark', key });
            }
            await ingestDeduplicator.clearIngestedMark(key);
            pendingIngestMarks.delete(key);
          } catch (err) {
            logger.warn('[MemoryQueue] Не удалось очистить дедуп-ключ %s: %s', key, err?.message || err);
          }
        }
      }
      return { success: true, error: null };
    } catch (err) {
      logger.error(
        `[MemoryQueue] Ошибка постановки задачи: причина=%s, диалог=%s, сообщение=%s.`,
        meta?.reason,
        meta?.conversationId,
        err?.message || err,
      );
      return { success: false, error: err };
    }
  };


      /**
       * @description Initializes client with resilience (retries, timeout).
       * @param {Object} args - Arguments for client initialization.
       * @param {Object} [resilienceOptions={}] - Resilience options.
       * @returns {Promise<any>} Initialized client.
       * @throws {Error} If initialization fails after retries.
       */
    const initializeClientWithResilience = async (args, resilienceOptions = {}) => {
      const config = getResilienceConfig('initializeClient');
      const mergedOptions = { ...config, ...resilienceOptions };
      return runWithResilience(
        'initializeClient',
        () => initializeClient(args),
        mergedOptions,
      );
    };

    const sendMessageWithResilience = async (
      clientInstance,
      payload,
      messageOptions,
      labels = {},
      resilienceOptions = {},
    ) => {
      if (!clientInstance || typeof clientInstance.sendMessage !== 'function') {
        throw new Error('client.sendMessage недоступен (client не инициализирован)');
      }

      const config = getResilienceConfig('sendMessage');
      const mergedOptions = { ...config, ...resilienceOptions };
      const startedAt = Date.now();
      const endpointLabel = normalizeLabelValue(labels.endpoint);
      const modelLabel = normalizeLabelValue(labels.model);

      try {
        const result = await runWithResilience(
          'client.sendMessage',
          () => clientInstance.sendMessage(payload, messageOptions),
          mergedOptions,
        );
        observeSendMessage(
          { endpoint: endpointLabel, model: modelLabel },
          Date.now() - startedAt,
        );
        return result;
      } catch (error) {
        incSendMessageFailure({
          endpoint: endpointLabel,
          model: modelLabel,
          reason: normalizeLabelValue(error?.code || error?.name || error?.message),
        });
        throw error;
      }
    };

      /**
       * @description Resolves labels for send message metrics.
       * @returns {Object} Object with endpoint and model labels.
       */
    const resolveSendMessageLabels = () => ({
      endpoint:
        endpointOption?.endpoint ||
        client?.options?.endpoint ||
        client?.endpoint ||
        'unknown',
      model:
        endpointOption?.model ||
        client?.options?.model ||
        client?.model ||
        'unknown',
    });

// =================================================================
// [НОВЫЙ ПАТЧ v2] "Удар на опережение" для индексации файлов
// =================================================================
if (req.body.files && req.body.files.length > 0) {
  try {
    const { encodeAndFormat } = require('../../services/Files/images/encode');
    const { files, text: ocrText } = await encodeAndFormat(req, req.body.files);

    const userId = req.user.id;
    const file = files && files[0];
    const isTextLike =
      file?.type &&
      (file.type.startsWith('text/') ||
        file.type.includes('html') ||
        file.type.includes('json') ||
        file.type.includes('javascript') ||
        file.type.includes('python'));

    const textToIndex = isTextLike ? ocrText : null;
    if (!textToIndex) {
      logger.info('[Pre-emptive Ingest] file_id=%s пропущен (тип=%s, текст отсутствует).', file?.file_id, file?.type);
    } else if (!conversationId) {
      logger.warn('[Pre-emptive Ingest] нет conversationId для file_id=%s, user=%s.', file.file_id, userId);
    } else {
      const dedupeKey = `ingest:file:${file.file_id}`;
      const dedupeResult = await ingestDeduplicator.markAsIngested(dedupeKey);
      if (dedupeResult.deduplicated) {
        logger.info('[Pre-emptive Ingest][dedup] file_id=%s пропущен (mode=%s).', file.file_id, dedupeResult.mode);
      } else {
        const task = {
          type: 'index_file',
          payload: {
            ingest_dedupe_key: dedupeKey,
            user_id: userId,
            conversation_id: conversationId,
            file_id: file.file_id,
            text_content: textToIndex,
            source_filename: file.originalname || file.filename || null,
            mime_type: file.type || null,
            file_size: file.size || null,
          },
          meta: { dedupe_key: dedupeKey },
        };

        pendingIngestMarks.add(dedupeKey);
        try {
          const enqueueResult = await enqueueMemoryTasksSafe(
            [task],
            {
              reason: 'index_file',
              conversationId,
              userId,
              fileId: file.file_id,
              textLength: textToIndex.length,
            },
          );
          if (!enqueueResult.success) {
            throw enqueueResult.error || new Error('Memory queue enqueue failed');
          }
        } catch (err) {
          logger.error(
            '[Pre-emptive Ingest] Ошибка постановки задачи (file=%s, conversation=%s): %s',
            file.file_id,
            conversationId,
            err?.message || err,
          );
          throw err;
        }
      }
    }
  } catch (e) {
    logger.error(`[Предв. индексация] Сбой подготовки файлов (conv=%s, user=%s): %s.`, conversationId, req.user?.id, e?.message || e);
  }
}
// =================================================================
// [КОНЕЦ ПАТЧА v2]
// =================================================================
  const useRagMemory = process.env.USE_CONVERSATION_MEMORY === 'true';
  const userId = req.user.id;

  let sender;
  let userMessage;
  let response;
  let promptTokens;
  let userMessageId;
  let responseMessageId;
  let userMessagePromise;
  let getAbortData;
  let client = null;
  let cleanupHandlers = [];
  let responseFinalized = false;

  let getReqData = (data = {}) => {
    for (let key in data) {
      if (key === 'userMessage') {
        userMessage = data[key];
        userMessageId = data[key].messageId;
      } else if (key === 'userMessagePromise') {
        userMessagePromise = data[key];
      } else if (key === 'responseMessageId') {
        responseMessageId = data[key];
      } else if (key === 'promptTokens') {
        promptTokens = data[key];
      } else if (key === 'sender') {
        sender = data[key];
      } else if (!conversationId && key === 'conversationId') {
        conversationId = data[key];
      }
    }
  };

      /**
       * @description Performs cleanup of resources and pending tasks.
       * @returns {Promise<void>}
       * @throws {Error} If cleanup handlers fail.
       */
    const performCleanup = async () => {
      if (Array.isArray(cleanupHandlers)) {
        for (const handler of cleanupHandlers) {
          try {
            if (typeof handler === 'function') {
              handler();
            }
          } catch (e) {
            logger.error('[AgentController] Ошибка в обработчике очистки.', e);
          }
        }
      }
      if (pendingIngestMarks.size > 0) {
        for (const key of Array.from(pendingIngestMarks)) {
          try {
            if (natsClient) {
              await natsClient.publish('tasks.clear', { action: 'clearIngestedMark', key });
            }
            await ingestDeduplicator.clearIngestedMark(key);
          } catch (err) {
            logger.warn('[AgentController] Не удалось очистить дедуп-ключ %s: %s', key, err?.message || err);
          }
        }
        pendingIngestMarks.clear();
      }
      requestDataMap.delete(req);
      if (client) {
        disposeClient(client);
        client = null;
      }
    };

  try {
    const originalUserText = text || '';
    if (originalUserText.length > MAX_USER_MSG_TO_MODEL_CHARS) {
      const convId = initialConversationId || req.body.conversationId;
      const fileId = `pasted-${Date.now()}`;
      try {
        if (convId) {
          const dedupeKey = `ingest:text:${fileId}`;
          const dedupeResult = await ingestDeduplicator.markAsIngested(dedupeKey);

          if (dedupeResult.deduplicated) {
            logger.info('[AgentController][large-text] Текст уже в обработке (dedupe mode=%s).', dedupeResult.mode);
          } else {
            const tasks = [{
              type: 'index_file',
              payload: {
                ingest_dedupe_key: dedupeKey,
                user_id: userId,
                conversation_id: convId,
                file_id: fileId,
                text_content: originalUserText,
                source_filename: 'pasted_text.txt',
                mime_type: 'text/plain',
                file_size: originalUserText.length,
              },
              meta: { dedupe_key: dedupeKey },
            }];

            pendingIngestMarks.add(dedupeKey);
            try {
              const enqueueResult = await enqueueMemoryTasksSafe(
                tasks,
                {
                  reason: 'index_file',
                  conversationId: convId,
                  userId,
                  fileId,
                  textLength: originalUserText.length,
                },
              );
              if (!enqueueResult.success) {
                throw enqueueResult.error || new Error('Memory queue enqueue failed');
              }
            } catch (err) {
              logger.error(
                '[AgentController][large-text] Не удалось поставить задачу на индексацию (conversation=%s): %s',
                convId,
                err?.message || err,
              );
              throw err;
            }

            triggerSummarization(req, convId).catch((err) =>
              logger.error('[Суммаризатор] Фоновый запуск завершился ошибкой', err),
            );
          }
        } else {
          logger.warn(`[AgentController] Нет conversationId для индексации большого текста.`);
        }
      } catch (e) {
        logger.error(`[AgentController] Не удалось поставить большой текст на индексацию.`, e);
      }

      const ackConversationId = convId || conversationId || initialConversationId;
      const ack = {
        text: `Принял большой фрагмент (~${(originalUserText.length/1024/1024).toFixed(2)} МБ). Индексация. Спросите по содержанию — отвечу через память (RAG).`,
        messageId: `ack-${Date.now()}`,
        createdAt: new Date().toISOString(),
      };

      sendEvent(res, {
        final: true,
        conversation: { id: ackConversationId },
        title: undefined,
        requestMessage: { text: '[Большой текст принят, отправлен в индексирование]', messageId: `usr-${Date.now()}` },
        responseMessage: ack,
      });
      try { res.end(); } catch {}
      return;
    }

    // [PATCHED-RAG-MOVE-OUT]
    // ----- RAG LOGIC MOVED TO client.js (see patch RAG-MOVE-IN) -----
    logger.info(`[DIAG] Контекст RAG пропускается (обрабатывается на клиенте).`);
    const originalTextForDisplay = text || '';
    // -----------------------------------------------------------------

    logger.info('[DEBUG-request] conversationId before build=%s', conversationId);
      if (!HEADLESS_STREAM) {
        const isGoogleEndpoint = (option) => option && option.endpoint === 'google';
        const prelimAbortController = new AbortController();
        const prelimCloseHandler = () => { try { prelimAbortController.abort(); } catch {} };
        res.once('close', prelimCloseHandler);
        req.once('aborted', prelimCloseHandler);

        try {
          const approxLen = text?.length || 0;
          if (isGoogleEndpoint(endpointOption) && approxLen > GOOGLE_NOSTREAM_THRESHOLD) {
            endpointOption.model_parameters = endpointOption.model_parameters || {};
            endpointOption.model_parameters.streaming = false;
            logger.info('[AgentController] Google: потоковый режим выключен (превышен лимит размера).');
          }
        } catch (_) {}

        let initResult = await initializeClientWithResilience(
          { req, res, endpointOption, signal: prelimAbortController.signal },
          { signal: prelimAbortController.signal },
        );

        try {
          res.removeListener('close', prelimAbortController);
          req.removeListener('aborted', prelimAbortController);
        } catch (_) {}

        if (!initResult || !initResult.client) throw new Error('Failed to initialize client (no result or client)');
        if (prelimAbortController.signal?.aborted) throw new Error('Request aborted before init');

        client = initResult.client;
        if (clientRegistry) clientRegistry.register(client, { userId }, client);
        requestDataMap.set(req, { client });

        const contentRef = new WeakRef(client.contentParts || []);
        getAbortData = () => ({
          sender,
          content: contentRef.deref() || [],
          userMessage,
          promptTokens,
          conversationId,
          userMessagePromise,
          messageId: responseMessageId,
          parentMessageId: overrideParentMessageId ?? userMessageId,
        });

        const { abortController, onStart } = createAbortController(req, res, getAbortData, getReqData);

        const onClose = () => {
          const closedAfterFinalize = responseFinalized || isResponseFinalized(res);
          if (closedAfterFinalize) {
            logger.debug('[AgentController] client connection closed after finalize (non-headless).');
            return;
          }
          if (!abortController.signal.aborted) {
            try {
              abortController.abort();
            } catch {}
            logger.info('[AgentController] Клиент разорвал соединение (аналог HTTP 499).');
          }
        };
        res.once('close', onClose);
        req.once('aborted', onClose);
        cleanupHandlers.push(() => {
          try { res.removeListener('close', onClose); } catch {}
          try { req.removeListener('aborted', onClose); } catch {}
        });

        const messageOptions = {
          user: userId,
          onStart,
          getReqData,
          isContinued,
          isRegenerate,
          editedContent,
          conversationId,
          parentMessageId,
          abortController,
          overrideParentMessageId,
          isEdited: !!editedContent,
          userMCPAuthMap: initResult.userMCPAuthMap,
          responseMessageId: editedResponseMessageId,
          progressOptions: { res },
        };

        const sendMessageLabels = resolveSendMessageLabels();

        try {
          response = await sendMessageWithResilience(
            client,
            text,
            messageOptions,
            sendMessageLabels,
            { signal: abortController.signal },
          );
        } catch (e) {
          const msg = String(e && (e.message || e));
          const disableGoogleStreaming = (option) => {
            if (isGoogleEndpoint(option)) {
              option.model_parameters = option.model_parameters || {};
              option.model_parameters.streaming = false;
            }
          };

          if (
            isGoogleEndpoint(endpointOption) &&
            (msg.includes('Symbol(Symbol.asyncIterator)') || msg.includes('ERR_INTERNAL_ASSERTION'))
          ) {
            logger.error('[AgentController] google stream error, retry non-stream once');
            try {
              disableGoogleStreaming(endpointOption);
            } catch (_) {}
            const reinit = await initializeClientWithResilience(
              { req, res, endpointOption, signal: prelimAbortController.signal },
              { signal: prelimAbortController.signal },
            );
            if (!reinit || !reinit.client) throw e;
            initResult = reinit;
            client = reinit.client;
            if (clientRegistry) {
              clientRegistry.register(client, { userId }, client);
            }
            requestDataMap.set(req, { client });
            response = await sendMessageWithResilience(
              client,
              text,
              messageOptions,
              resolveSendMessageLabels(),
              { signal: abortController.signal },
            );
          } else {
            throw e;
          }
        }

        const safeEndpoint =
          (endpointOption && endpointOption.endpoint) ||
          initResult?.endpoint ||
          client?.options?.endpoint ||
          client?.endpoint ||
          'unknown';
        if (response) response.endpoint = safeEndpoint;

        if (!abortController.signal.aborted && response && canWrite(res)) {
          const databasePromise = response.databasePromise;
          delete response.databasePromise;

          const { conversation: convoData = {} } = await databasePromise;
          const conversation = { ...convoData };
          conversation.title = conversation?.title || (await getConvoTitle(req.user.id, conversationId));

          if (req.body.files && client.options?.attachments && userMessage) {
            userMessage.files = [];
            const messageFiles = new Set(req.body.files.map((f) => f.file_id));
            for (const attachment of client.options.attachments) {
              if (messageFiles.has(attachment.file_id)) userMessage.files.push({ ...attachment });
            }
            delete userMessage.image_urls;
          }

          if (userMessage && text !== originalTextForDisplay) userMessage.text = originalTextForDisplay;

          if (useRagMemory) {
            const tasks = [];
            const userContent = userMessage ? (userMessage.text || '') : '';
            let assistantText = response ? (response.text || '') : '';
            if (!assistantText && Array.isArray(response?.content)) {
              assistantText = response.content
                .filter((p) => p.type === 'text' && p.text)
                .map((p) => p.text)
                .join('\n');
            }

            logger.info('[GraphWorkflow] guard check', {
              useRagMemory: useRagMemory,
              hasAssistantText: Boolean(assistantText && assistantText.trim()),
              conversationId: conversationId,
              assistantMessageId: response && response.messageId
            });

            const userCreatedAt = userMessage?.createdAt || new Date().toISOString();
            const assistantCreatedAt = response?.createdAt || new Date().toISOString();

            if (userContent) {
              tasks.push({
                type: 'add_turn',
                payload: {
                  conversation_id: conversationId,
                  message_id: userMessage.messageId,
                  role: 'user',
                  content: userContent,
                  user_id: req.user.id,
                  created_at: userCreatedAt,
                },
              });
            }

            if (assistantText) {
              tasks.push({
                type: 'add_turn',
                payload: {
                  conversation_id: conversationId,
                  message_id: response.messageId,
                  role: 'assistant',
                  content: assistantText,
                  user_id: req.user.id,
                  created_at: assistantCreatedAt,
                },
              });
            }

            if (tasks.length > 0) {
              await enqueueMemoryTasksSafe(tasks, {
                reason: 'regular_turn',
                conversationId,
                userId: req.user.id,
                fileId: null,
                textLength: (userContent?.length || 0) + (assistantText?.length || 0),
              });
            }

            if (assistantText) {
              const graphPayload = {
                user_id: req.user.id,
                conversation_id: conversationId,
                message_id: response.messageId,
		role: response?.role || 'assistant',
                content: assistantText,
                created_at: response?.createdAt || new Date().toISOString(),
                reasoning_text: response?.reasoningText || null,
                context_flags: response?.contextFlags || [],
              };

              try {
                logger.info(
                  `[GraphWorkflow] ветка Graph запущена (conversation=${conversationId}, message=${response.messageId}, USE_GRAPH_CONTEXT=${process.env.USE_GRAPH_CONTEXT ?? 'unset'}, GRAPH_CONTEXT_MODE=${process.env.GRAPH_CONTEXT_MODE ?? 'unset'}, MEMORY_GRAPHWORKFLOW_ENABLED=${process.env.MEMORY_GRAPHWORKFLOW_ENABLED ?? 'unset'})`
                );

                logger.info(
                  `[GraphWorkflow] enqueueGraphTaskWithResilience start (conversation=${conversationId}, message=${response.messageId})`
                );

                await enqueueGraphTaskWithResilience(graphPayload);

                logger.info(
                  `[GraphWorkflow] enqueueGraphTaskWithResilience complete (conversation=${conversationId}, message=${response.messageId})`
                );

                logger.info(`[GraphWorkflow] started for message ${response.messageId}`);
              } catch (err) {
                logger.error(
                  `[GraphWorkflow] Ошибка постановки/выполнения (conversation=${conversationId}, message=${response?.messageId}): ${err?.message || err}`,
                );
              }
            }
          }

          try {
            if (userMessage && !client.skipSaveUserMessage) await saveMessage(req, userMessage);
            if (response) await saveMessage(req, { ...response, user: userId });
          } catch (e) {
            logger.error(`[AgentController] Ошибка при сохранении сообщений.`, e);
          }

          if (!abortController.signal.aborted && typeof addTitle === 'function') {
            try {
              const need = await shouldGenerateTitle(req, conversationId);
              if (need) {
                const titleSourceText = (userMessage?.text || originalTextForDisplay || req.body?.text || '').slice(0, 500);
                await addTitle(req, {
                  text: titleSourceText,
                  input: titleSourceText,
                  abortController,
                  conversationId,
                  endpoint: safeEndpoint,
                  client,
                  response,
                  endpointOption,
                });
              }
            } catch (e) {
              logger.error(`[AgentController] Ошибка генерации заголовка.`, e);
            }
          }

          if (response) {
            sendEvent(res, {
              final: true,
              conversation,
              title: conversation.title,
              requestMessage: userMessage,
              responseMessage: response,
            });
            responseFinalized = true;
            try { res.end(); } catch {}
          }

          if (useRagMemory) {
            triggerSummarization(req, conversationId).catch((err) =>
              logger.error(`[Суммаризатор] Фоновый запуск завершился ошибкой`, err),
            );
          }
        }
        return;
      }
    // HEADLESS_STREAM (detach)
    const dres = makeDetachableRes(res);
    let detached = false;
    const onClose = () => {
      const closedAfterFinalize = responseFinalized || isResponseFinalized(dres);
      if (closedAfterFinalize) {
        logger.debug('[AgentController] client connection closed after finalize (headless).');
        return;
      }
      if (!detached) {
        dres.setDetached(true);
        detached = true;
        logger.info('[AgentController] client disconnected, detach streaming');
      }
    };
    res.once('close', onClose);
    req.once('aborted', onClose);

        // Для Google в headless: отключаем стрим у провайдера, чтобы не ловить gaxios asyncIterator/ERR_INTERNAL_ASSERTION
    try {
      if (endpointOption && endpointOption.endpoint === 'google') {
        endpointOption.model_parameters = endpointOption.model_parameters || {};
        endpointOption.model_parameters.streaming = false;
        logger.info(`[AgentController] Google: потоковый режим отключён в headless-режиме.`);
      }
    } catch (_) {}

    let headlessInitResult = await initializeClientWithResilience(
      { req, res: dres, endpointOption, signal: undefined },
    );
    if (!headlessInitResult || !headlessInitResult.client) throw new Error('Failed to initialize client (no result or client)');

    client = headlessInitResult.client;
    if (clientRegistry) clientRegistry.register(client, { userId }, client);
    requestDataMap.set(req, { client });
    const contentRef = new WeakRef(client.contentParts || []);
    getAbortData = () => {
      return { sender, content: contentRef.deref() || [], userMessage, promptTokens, conversationId, userMessagePromise, messageId: responseMessageId, parentMessageId: userMessageId };
    };

    const { abortController, onStart } = createAbortController(req, dres, getAbortData, getReqData);

    const messageOptions = {
      user: userId,
      onStart,
      getReqData,
      isContinued,
      isRegenerate,
      editedContent,
      conversationId,
      parentMessageId,
      abortController,
      overrideParentMessageId,
      isEdited: !!editedContent,
      userMCPAuthMap: headlessInitResult.userMCPAuthMap,
      responseMessageId: editedResponseMessageId,
      progressOptions: { res: dres },
    };
    const headlessSendMessageLabels = resolveSendMessageLabels();

    response = await sendMessageWithResilience(
      client,
      text,
      messageOptions,
      headlessSendMessageLabels,
      { signal: abortController.signal },
    );
    const safeEndpoint =
      (endpointOption && endpointOption.endpoint) || headlessInitResult?.endpoint || client?.options?.endpoint || client?.endpoint || 'unknown';
    if (response) response.endpoint = safeEndpoint;

    // показываем исходный текст
    if (userMessage && text !== originalTextForDisplay) userMessage.text = originalTextForDisplay;

    try {
      if (userMessage && !client.skipSaveUserMessage) await saveMessage(req, userMessage);
      if (response) await saveMessage(req, { ...response, user: userId });
    } catch (e) {
      logger.error(`[AgentController] Ошибка при сохранении сообщений.`, e);
    }

    // ТОЛЬКО ПРИ ПЕРВОМ ОБМЕНЕ
    if (!abortController.signal.aborted && response && typeof addTitle === 'function') {
      try {
        const need = await shouldGenerateTitle(req, conversationId);
        if (need) {
          const titleSourceText = (userMessage?.text || originalUserText || req.body?.text || '').slice(0, 500); // <-- ИСПРАВЛЕНО: userMessage?.text или originalUserText
          await addTitle(req, { text: titleSourceText, input: titleSourceText, abortController, conversationId, endpoint: safeEndpoint, client, response, endpointOption });
        }
      } catch (e) {
        logger.error(`[AgentController] Ошибка генерации заголовка (headless).`, e);
      }
    }

    if (!detached && canWrite(dres) && response) {
      sendEvent(dres, { final: true, conversation: {}, title: undefined, requestMessage: userMessage, responseMessage: response });
      responseFinalized = true;
      try { dres.end(); } catch {}
    } else {
      responseFinalized = true;
      logger.info(`[AgentController] Ответ сформирован в фоне — клиент уже отключился.`);
    }

    if (useRagMemory) {
      triggerSummarization(req, conversationId).catch((err) => logger.error(`[Суммаризатор] Фоновый запуск завершился ошибкой`, err));
    }
  } catch (error) {
    handleAbortError(res, req, error, { conversationId, sender, messageId: responseMessageId, parentMessageId: overrideParentMessageId ?? userMessageId ?? parentMessageId, userMessageId });
  } finally {
      await performCleanup();
  }
};

  /**
   * @description Triggers summarization workflow for a conversation if conditions are met.
   * @param {Object} req - Express request object.
   * @param {string} conversationId - Unique identifier of the conversation.
   * @returns {Promise<void>}
   * @throws {Error} If summarization enqueue or save fails.
   * @example
   * await triggerSummarization(req, 'conv123');
   */
async function triggerSummarization(req, conversationId) {
  const userId = req.user.id;

  if (!acquireSummarizationLock(conversationId)) {
    logger.info(`[Суммаризатор] Диалог ${conversationId} уже обрабатывается, пропускаем.`);
    return;
  }

  try {
    const convo = await getConvo(userId, conversationId);
    if (!convo) {
      return;
    }

    const allMessages = await getMessages({ conversationId });
    const messageCount = allMessages.length;
    let lastSummarized = convo.lastSummarizedIndex || 0;

    logger.info(`[Суммаризатор] Проверка диалога ${conversationId}: всего сообщений=${messageCount}, последняя суммаризация=${lastSummarized}.`);

    if (messageCount - lastSummarized < SUMMARIZATION_THRESHOLD) {
      return;
    }

    logger.info(`[Суммаризатор] Установлена блокировка для диалога ${conversationId}.`);

    const cleanAssistantText = (text) => {
      if (!text) return '';
      if (text.includes('***')) return text.split('***').pop().trim();
      if (text.includes('Рассуждения:')) {
        const parts = text.split(/Рассуждения:|Финальный ответ:/);
        return parts.length > 1 ? parts[parts.length - 1].trim() : text.trim();
      }
      return text.trim();
    };

    const extractText = (msg) => {
      const rawText =
        msg.text ||
        (Array.isArray(msg.content)
          ? msg.content
              .filter((p) => p.type === 'text' && p.text)
              .map((p) => p.text)
              .join('\n')
          : '');
      return msg.isCreatedByUser ? rawText : cleanAssistantText(rawText);
    };

    const messagesToSummarize = allMessages.slice(
      lastSummarized,
      lastSummarized + MAX_MESSAGES_PER_SUMMARY,
    );
    if (messagesToSummarize.length < 2) {
      logger.info(`[Суммаризатор] Недостаточно сообщений для суммаризации диалога ${conversationId}, освобождаем блокировку.`);
        return;
    }

    const formatted = messagesToSummarize
      .map((m) => ({
        role: m.isCreatedByUser ? 'user' : 'assistant',
        content: extractText(m),
        message_id: m.messageId,
      }))
      .filter((m) => m.content);

    const summarizationJob = {
      conversation_id: conversationId,
      user_id: userId,
      messages: formatted,
      start_message_id: messagesToSummarize[0].messageId,
      end_message_id: messagesToSummarize[messagesToSummarize.length - 1].messageId,
    };

    const totalContentLength = formatted.reduce(
      (acc, msg) => acc + (msg.content?.length || 0),
      0,
    );

    try {
      await enqueueSummaryTaskWithResilience(summarizationJob);
      logger.info(
        `[Суммаризатор] Запущен SummaryWorkflow: диалог=${conversationId}, ${summarizationJob.start_message_id} → ${summarizationJob.end_message_id}, символов=${totalContentLength}.`,
      );
    } catch (err) {
      logger.error(
        `[Суммаризатор] Не удалось запустить SummaryWorkflow для диалога ${conversationId}: ${err?.message || err}`,
      );
      throw err;
    }

    const step = Math.max(1, messagesToSummarize.length);
    const newIndex = lastSummarized + step;

    await saveConvoWithResilience(
      req,
      { conversationId, lastSummarizedIndex: newIndex },
      { context: 'triggerSummarization' },
    );
    logger.info(
      `[Суммаризатор] Обновлён индекс суммаризации: диалог=${conversationId}, новое значение=${newIndex}, шаг=${step}.`,
    );
  } catch (error) {
    logger.error(`[Суммаризатор] Ошибка при обработке диалога ${conversationId}:`, error);
  } finally {
    releaseSummarizationLock(conversationId);
  }
};

module.exports = AgentController;
