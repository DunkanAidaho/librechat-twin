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
const config = require('~/server/services/Config/ConfigService');
const { clearDedupeKey } = require('~/server/services/Deduplication/clearDedupeKey');
const { runWithResilience, normalizeLabelValue } = require('~/server/utils/resilience');
const { canWrite, isResponseFinalized, makeDetachableRes } = require('~/server/utils/responseUtils');

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
  updateMessage,
} = require('~/models');

const { enqueueMemoryTasks } = require('~/server/services/RAG/memoryQueue');
const ingestDeduplicator = require('~/server/services/Deduplication/ingestDeduplicator');
const { incLongTextTask } = require('~/utils/metrics');
const { enqueueGraphTask, enqueueSummaryTask } = require('~/utils/temporalClient');
const { LongTextGraphWorker } = require('~/server/services/Graph/LongTextWorker');
LongTextGraphWorker.start({ sendProgressEvents: true });
const { makeIngestKey } = require('~/server/utils/messageUtils');

const featuresConfig = config.getSection('features');
const ragConfig = config.getSection('rag');
const ragContextConfig = ragConfig.context;
const agentsConfig = config.getSection('agents');
const agentsResilienceConfig = agentsConfig.resilience;
const agentsThresholdsConfig = agentsConfig.thresholds;
const summariesConfig = config.getSection('summaries');
const memoryConfig = config.getSection('memory');

const HEADLESS_STREAM = Boolean(featuresConfig.headlessStream);
const MAX_USER_MSG_TO_MODEL_CHARS = agentsThresholdsConfig.maxUserMessageChars;
const MAX_TEXT_SIZE = config.getNumber('memory.longTextMaxChars', 500000);
const GOOGLE_NOSTREAM_THRESHOLD = agentsThresholdsConfig.googleNoStreamThreshold;

const SUMMARIZATION_THRESHOLD = summariesConfig.threshold;
const MAX_MESSAGES_PER_SUMMARY = summariesConfig.maxMessagesPerSummary;
const SUMMARIZATION_LOCK_TTL = summariesConfig.lockTtlSeconds;
const TEMPORAL_SUMMARY_REASON = 'summary_queue';
const TEMPORAL_GRAPH_REASON = 'graph_queue';

const operationsConfig = agentsResilienceConfig.operations || {};
const DEFAULT_OPERATION_CONFIG = {
  initializeClient: { timeoutMs: 15000, retries: 2 },
  sendMessage: { timeoutMs: 120000, retries: 1 },
  memoryQueue: { timeoutMs: 15000, retries: 2 },
  summaryEnqueue: { timeoutMs: 15000, retries: 2 },
  graphEnqueue: { timeoutMs: 15000, retries: 2 },
  saveConvo: { timeoutMs: 10000, retries: 1 },
};

const getOperationConfig = (name) => ({
  ...DEFAULT_OPERATION_CONFIG[name],
  ...(operationsConfig[name] || {}),
});

const RESILIENCE_CONFIG = Object.freeze({
  initializeClient: getOperationConfig('initializeClient'),
  sendMessage: getOperationConfig('sendMessage'),
  memoryQueue: getOperationConfig('memoryQueue'),
  summaryEnqueue: getOperationConfig('summaryEnqueue'),
  graphEnqueue: getOperationConfig('graphEnqueue'),
  saveConvo: getOperationConfig('saveConvo'),
});

const getResilienceConfig = (key) => {
  const config = RESILIENCE_CONFIG[key];
  if (!config) {
    return { timeoutMs: 0, retries: 0 };
  }
  return { ...config };
};

/**
 * Enqueues memory tasks with resilience and metrics
 * @param {Array} tasks
 * @param {Object} meta
 * @param {Object} options
 * @returns {Promise<any>}
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
 * Enqueues summary task with resilience and metrics
 * @param {Object} job
 * @param {Object} options
 * @returns {Promise<any>}
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
 * Enqueues graph task with resilience and metrics
 * @param {Object} payload
 * @param {Object} options
 * @returns {Promise<any>}
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
 * Saves conversation with resilience
 * @param {Object} req
 * @param {Object} data
 * @param {Object} options
 * @param {Object} resilienceOptions
 * @returns {Promise<any>}
 */
async function saveConvoWithResilience(req, data, options = {}, resilienceOptions = {}) {
  const config = getResilienceConfig('saveConvo');
  const mergedOptions = { ...config, ...resilienceOptions };
  return runWithResilience('saveConvo', () => saveConvo(req, data, options), mergedOptions);
}

const summarizationLocks = new Map();

/**
 * Acquires a lock for summarization
 * @param {string} conversationId
 * @returns {boolean}
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
 * Releases the summarization lock
 * @param {string} conversationId
 */
function releaseSummarizationLock(conversationId) {
  const entry = summarizationLocks.get(conversationId);
  if (entry?.timeout) {
    clearTimeout(entry.timeout);
  }
  summarizationLocks.delete(conversationId);
}

/**
 * Extracts deduplication keys from tasks
 * @param {Array} tasks
 * @returns {Array<string>}
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

/**
 * Determines if title should be generated for conversation
 * @param {Object} req
 * @param {string} conversationId
 * @returns {Promise<boolean>}
 */
async function shouldGenerateTitle(req, conversationId) {
  try {
    const convo = await getConvo(req.user.id, conversationId);
    const title = (convo?.title || '').trim();
    if (title && !/new chat/i.test(title)) return false;
    const msgs = await getMessages({ conversationId });
    return (msgs?.length || 0) <= 2;
  } catch (e) {
    logger.error(`[title] Проверка не удалась`, e);
    return false;
  }
}

/**
 * Marks messages as stored in memory
 * @param {Object} req
 * @param {Array<string>} messageIds
 * @returns {Promise<void>}
 */
async function markMessagesAsStored(req, messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return;
  }

  try {
    const result = await updateMessage(
      req,
      {
        messageId: { $in: messageIds },
        isMemoryStored: true,
      },
      { context: 'markMessagesAsStored', multi: true },
    );

    logger.debug('[markMessagesAsStored] Marked messages as stored', {
      messageIds,
      modifiedCount: result?.modifiedCount,
    });
  } catch (error) {
    logger.error('[markMessagesAsStored] Failed to mark messages', {
      messageIds,
      error: error?.message,
    });
  }
}

/**
 * Main controller for agent requests
 * @param {Object} req
 * @param {Object} res
 * @param {function} next
 * @param {function} initializeClient
 * @param {function} addTitle
 * @returns {Promise<void>}
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

  const clearDedupeKeyWithLogging = (key, logPrefix = '[AgentController]') =>
    clearDedupeKey(key, logPrefix);

  /**
   * Safely enqueues memory tasks with dedupe key management
   * @param {Array} tasks
   * @param {Object} meta
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  const enqueueMemoryTasksSafe = async (tasks, meta = {}, options = {}) => {
    const dedupeKeys = extractDedupeKeys(tasks);
    try {
      const result = await enqueueMemoryTasksWithResilience(tasks, meta, options);
      if (result?.status === 'queued' && dedupeKeys.length > 0) {
        for (const key of dedupeKeys) {
          try {
            await clearDedupeKey(key, '[MemoryQueue]');
            pendingIngestMarks.delete(key);
          } catch (err) {
            logger.warn(
              `[MemoryQueue] Не удалось очистить дедуп-ключ ${key}: ${err?.message || err}`,
            );
          }
        }
      }
      return { success: true, error: null, result };
    } catch (err) {
      logger.error(
        `[MemoryQueue] Ошибка постановки задачи: причина=${meta?.reason}, диалог=${meta?.conversationId}, сообщение=${err?.message || err}.`,
      );
      return { success: false, error: err, result: null };
    }
  };

  /**
   * Initializes client with resilience
   * @param {Object} args
   * @param {Object} resilienceOptions
   * @returns {Promise<any>}
   */
  const initializeClientWithResilience = async (args, resilienceOptions = {}) => {
    const config = getResilienceConfig('initializeClient');
    const mergedOptions = { ...config, ...resilienceOptions };
    return runWithResilience('initializeClient', () => initializeClient(args), mergedOptions);
  };

  /**
   * Sends message with resilience and metrics
   * @param {Object} clientInstance
   * @param {Object} payload
   * @param {Object} messageOptions
   * @param {Object} labels
   * @param {Object} resilienceOptions
   * @returns {Promise<any>}
   */
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
      observeSendMessage({ endpoint: endpointLabel, model: modelLabel }, Date.now() - startedAt);
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
   * Resolves labels for send message metrics
   * @returns {Object}
   */
  const resolveSendMessageLabels = () => ({
    endpoint:
      endpointOption?.endpoint || client?.options?.endpoint || client?.endpoint || 'unknown',
    model: endpointOption?.model || client?.options?.model || client?.model || 'unknown',
  });

  // Pre-emptive file ingestion
  const makeDedupeKey = (scope, id) => `ingest_${scope}_${id}`;

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
        logger.debug(
          `[Pre-emptive Ingest] file_id=${file?.file_id} пропущен (тип=${file?.type}, текст отсутствует).`,
        );
      } else if (!conversationId) {
        logger.warn(
          `[Pre-emptive Ingest] Нет conversationId для file_id=${file.file_id}, user=${userId}.`,
        );
      } else {
        const dedupeKey = makeDedupeKey('file', file.file_id);
        const dedupeResult = await ingestDeduplicator.markAsIngested(dedupeKey, 'index_file');
        if (dedupeResult.deduplicated) {
          logger.debug(
            `[Pre-emptive Ingest][dedup] file_id=${file.file_id} пропущен (mode=${dedupeResult.mode}).`,
          );
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
              throw enqueueResult.error || new Error('Не удалось поставить задачу в очередь памяти');
            }
          } catch (err) {
            logger.error(
              `[Pre-emptive Ingest] Ошибка постановки задачи (file=${file.file_id}, conversation=${conversationId}): ${err?.message || err}`,
            );
            throw err;
          }
        }
      }
    } catch (e) {
      logger.error(
        `[Предв. индексация] Сбой подготовки файлов (conv=${conversationId}, user=${req.user?.id}): ${e?.message || e}.`,
      );
    }
  }

  const useRagMemory = Boolean(featuresConfig.useConversationMemory);
  const userId = req.user.id;

  /**
   * Processes conversation artifacts (memory tasks, graph workflow)
   * @param {Object} params
   * @returns {Promise<void>}
   */
  const processConversationArtifacts = async ({
    userMessage: localUserMessage,
    response: localResponse,
    conversationId: localConversationId,
  }) => {
    if (!useRagMemory) {
      return;
    }

    const tasks = [];
    const messageIdsToMark = [];
    const userContent = localUserMessage ? localUserMessage.text || '' : '';
    let assistantText = localResponse ? localResponse.text || '' : '';

    if (!assistantText && Array.isArray(localResponse?.content)) {
      assistantText = localResponse.content
        .filter((part) => part.type === 'text' && part.text)
        .map((part) => part.text)
        .join('\n');
    }

    const userCreatedAt = localUserMessage?.createdAt || new Date().toISOString();
    const assistantCreatedAt = localResponse?.createdAt || new Date().toISOString();

    if (userContent) {
      tasks.push({
        type: 'add_turn',
        payload: {
          conversation_id: localConversationId,
          message_id: localUserMessage.messageId,
          role: 'user',
          content: userContent,
          user_id: userId,
          created_at: userCreatedAt,
        },
      });
      messageIdsToMark.push(localUserMessage.messageId);
    }

    if (assistantText) {
      tasks.push({
        type: 'add_turn',
        payload: {
          conversation_id: localConversationId,
          message_id: localResponse?.messageId,
          role: localResponse?.role || 'assistant',
          content: assistantText,
          user_id: userId,
          created_at: assistantCreatedAt,
        },
      });
      messageIdsToMark.push(localResponse?.messageId);
    }

    if (tasks.length > 0) {
      // Fire-and-forget для новых чатов (не блокируем ответ)
      setImmediate(async () => {
        try {
          const enqueueResult = await enqueueMemoryTasksSafe(tasks, {
            reason: 'regular_turn',
            conversationId: localConversationId,
            userId,
            fileId: null,
            textLength: (userContent?.length || 0) + (assistantText?.length || 0),
          });

          // ДОБАВЛЕНО: Проставляем флаг isMemoryStored после успешной постановки в очередь
          if (enqueueResult.success && messageIdsToMark.length > 0) {
            await markMessagesAsStored(req, messageIdsToMark);
          }
        } catch (err) {
          logger.error('[processConversationArtifacts] Не удалось поставить задачи памяти в очередь', {
            conversationId: localConversationId,
            error: err?.message,
          });
        }
      });
    }

    if (!assistantText || !assistantText.trim()) {
      logger.debug('[GraphWorkflow] Пропуск Graph (нет текста ассистента)', {
        conversationId: localConversationId,
        assistantMessageId: localResponse?.messageId,
      });
      return;
    }

    const graphPayload = {
      user_id: userId,
      conversation_id: localConversationId,
      message_id: localResponse?.messageId,
      role: localResponse?.role || 'assistant',
      content: assistantText,
      created_at: localResponse?.createdAt || new Date().toISOString(),
      reasoning_text: localResponse?.reasoningText || null,
      context_flags: localResponse?.contextFlags || [],
    };

    // Fire-and-forget для graph workflow (не блокируем ответ)
    setImmediate(async () => {
      try {
        await enqueueGraphTaskWithResilience(graphPayload);
        logger.debug(`[GraphWorkflow] Запущен для сообщения ${localResponse?.messageId}`);
      } catch (err) {
        logger.error(
          `[GraphWorkflow] Ошибка постановки/выполнения (conversation=${localConversationId}, message=${localResponse?.messageId}): ${err?.message || err}`,
        );
      }
    });
  };

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
   * Performs cleanup of resources and pending tasks
   * @returns {Promise<void>}
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
          await clearDedupeKey(key);
        } catch (err) {
          logger.warn(
            `[AgentController] Не удалось очистить дедуп-ключ ${key}: ${err?.message || err}`,
          );
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
      if (MAX_TEXT_SIZE && originalUserText.length > MAX_TEXT_SIZE) {
        const oversizedResponse = {
          conversationId: initialConversationId,
          messageId: `ack-${Date.now()}`,
          parentMessageId: userMessageId,
          sender: 'assistant',
          text: 'Текст слишком большой, разбейте его на части.',
          createdAt: new Date().toISOString(),
        };

        sendEvent(res, {
          final: true,
          conversation: { id: initialConversationId },
          requestMessage: userMessage,
          responseMessage: oversizedResponse,
        });
        try {
          res.end();
        } catch {}
        return;
      }
      const convId = initialConversationId || req.body.conversationId;
      const fileId = `pasted-${Date.now()}`;
      const textSize = originalUserText.length;
      const approxMb = (textSize / 1024 / 1024).toFixed(2);
      try {
        if (convId) {
        const dedupeKey = makeDedupeKey('text', fileId);
        const dedupeResult = await ingestDeduplicator.markAsIngested(dedupeKey, 'index_text');
        incLongTextTask('received');

          if (dedupeResult.deduplicated) {
            logger.info(
              `[AgentController][large-text] Текст уже в обработке (dedupe mode=${dedupeResult.mode}).`,
            );
          } else {
            const messageId = dedupeKey;
            const payload = {
              ingest_dedupe_key: dedupeKey,
              message_id: messageId,
              user_id: userId,
              conversation_id: convId,
              role: 'user',
              content: originalUserText,
              content_type: 'plain_text',
              created_at: new Date().toISOString(),
            };
            if (!payload.message_id) {
              payload.message_id = dedupeKey;
            }
            const tasks = [
              {
                type: 'index_text',
                payload,
                meta: { dedupe_key: dedupeKey },
              },
            ];

            pendingIngestMarks.add(dedupeKey);
            try {
              const enqueueResult = await enqueueMemoryTasksSafe(tasks, {
                reason: 'index_text',
                conversationId: convId,
                userId,
                textLength: originalUserText.length,
              });
              if (!enqueueResult.success) {
                throw enqueueResult.error || new Error('Не удалось поставить задачу в очередь памяти');
              }
              incLongTextTask('queued');

              const indexedEvent = {
                status: 'indexed',
                conversationId: convId,
                textSize,
                messageId: dedupeKey,
              };

              setImmediate(() => {
                try {
                  LongTextGraphWorker.enqueue({
                    conversationId: convId,
                    userId,
                    messageId: dedupeKey,
                    text: originalUserText,
                    dedupeKey,
                    res,
                  });
                } catch (workerError) {
                  logger.error('[AgentController][long-text] Не удалось запустить LongTextGraphWorker', {
                    conversationId: convId,
                    messageId: dedupeKey,
                    error: workerError?.message,
                  });
                }
              });

              try {
                sendEvent(res, {
                  meta: {
                    longTextInfo: indexedEvent,
                  },
                });
              } catch (notifyError) {
                logger.warn(
                  `[AgentController][large-text] Не удалось отправить уведомление об индексации: ${notifyError?.message || notifyError}`,
                );
              }
            } catch (err) {
              logger.error(
                `[AgentController][large-text] Не удалось поставить задачу на индексацию (conversation=${convId}): ${err?.message || err}`,
              );
              incLongTextTask('failed');
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
      const baseUserMessage =
        userMessage ?? {
          conversationId: ackConversationId,
          messageId: req.body.messageId || `usr-${Date.now()}`,
          parentMessageId: req.body.parentMessageId || parentMessageId || null,
          sender: 'user',
          text: originalUserText,
          createdAt: new Date().toISOString(),
        };

      if (!userMessage) {
        userMessage = baseUserMessage;
        userMessageId = userMessage.messageId;
      }

      const ackMessageId = `ack-${Date.now()}`;
      const ack = {
        conversationId: ackConversationId,
        messageId: ackMessageId,
        parentMessageId: userMessageId || req.body.parentMessageId,
        sender: 'assistant',
        text: `Принял большой фрагмент (~${approxMb} МБ). Индексация…`,
        createdAt: new Date().toISOString(),
        metadata: {
          acknowledgement: true,
          longTextStatus: 'accepted',
          textSize,
        },
      };

      try {
        await saveMessage(req, { ...baseUserMessage, user: userId });
      } catch (userSaveError) {
        logger.error(
          `[AgentController][large-text] Не удалось сохранить пользовательское сообщение: ${userSaveError?.message || userSaveError}`,
        );
      }

      try {
        await saveMessage(req, { ...ack, user: userId, role: 'assistant' });
      } catch (ackSaveError) {
        logger.error(
          `[AgentController][large-text] Не удалось сохранить ack-сообщение: ${ackSaveError?.message || ackSaveError}`,
        );
      }

      sendEvent(res, {
        final: true,
        conversation: { id: ackConversationId },
        requestMessage: userMessage ?? baseUserMessage,
        responseMessage: ack,
        meta: {
          longTextInfo: {
            status: 'accepted',
            textSize,
            conversationId: ackConversationId,
            messageId: ackMessageId,
          },
        },
      });
      incLongTextTask('acked');
      try {
        res.end();
      } catch {}
      return;
    }

    logger.debug(`[AgentController] Контекст RAG обрабатывается на клиенте.`);
    const originalTextForDisplay = text || '';

    logger.debug(`[AgentController] conversationId=${conversationId}`);

    if (!HEADLESS_STREAM) {
      const isGoogleEndpoint = (option) => option && option.endpoint === 'google';
      const prelimAbortController = new AbortController();
      const prelimCloseHandler = () => {
        try {
          prelimAbortController.abort();
        } catch {}
      };
      res.once('close', prelimCloseHandler);
      req.once('aborted', prelimCloseHandler);

      try {
        const approxLen = text?.length || 0;
        if (isGoogleEndpoint(endpointOption) && approxLen > GOOGLE_NOSTREAM_THRESHOLD) {
          endpointOption.model_parameters = endpointOption.model_parameters || {};
          endpointOption.model_parameters.streaming = false;
          logger.info(
            '[AgentController] Google: потоковый режим выключен (превышен лимит размера).',
          );
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

      if (!initResult || !initResult.client)
        throw new Error('Не удалось инициализировать клиент (нет результата или клиента)');
      if (prelimAbortController.signal?.aborted)
        throw new Error('Запрос прерван до инициализации');

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

      const { abortController, onStart } = createAbortController(
        req,
        res,
        getAbortData,
        getReqData,
      );

      const onClose = () => {
        const closedAfterFinalize = responseFinalized || isResponseFinalized(res);
        if (closedAfterFinalize) {
          logger.debug(
            '[AgentController] Соединение клиента закрыто после финализации (non-headless).',
          );
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
        try {
          res.removeListener('close', onClose);
        } catch {}
        try {
          req.removeListener('aborted', onClose);
        } catch {}
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
          (msg.includes('Symbol(Symbol.asyncIterator)') ||
            msg.includes('ERR_INTERNAL_ASSERTION'))
        ) {
          logger.error('[AgentController] Ошибка потока Google, повтор без потока');
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
        conversation.title =
          conversation?.title || (await getConvoTitle(req.user.id, conversationId));

        if (req.body.files && client.options?.attachments && userMessage) {
          userMessage.files = [];
          const messageFiles = new Set(req.body.files.map((f) => f.file_id));
          for (const attachment of client.options.attachments) {
            if (messageFiles.has(attachment.file_id)) userMessage.files.push({ ...attachment });
          }
          delete userMessage.image_urls;
        }

        if (userMessage && text !== originalTextForDisplay)
          userMessage.text = originalTextForDisplay;

        if (useRagMemory) {
          await processConversationArtifacts({
            userMessage,
            response,
            conversationId,
          });
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
              const titleSourceText = (
                userMessage?.text ||
                originalTextForDisplay ||
                req.body?.text ||
                ''
              ).slice(0, 500);
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
          try {
            res.end();
          } catch {}
        }

        if (useRagMemory) {
          // Fire-and-forget для суммаризации (не блокируем ответ)
          setImmediate(() => {
            triggerSummarization(req, conversationId).catch((err) =>
              logger.error(`[Суммаризатор] Фоновый запуск завершился ошибкой`, err),
            );
          });
        }
      }
      return;
    }

    // HEADLESS_STREAM
    const dres = makeDetachableRes(res);
    let detached = false;
    const onClose = () => {
      const closedAfterFinalize = responseFinalized || isResponseFinalized(dres);
      if (closedAfterFinalize) {
        logger.debug('[AgentController] Соединение клиента закрыто после финализации (headless).');
        return;
      }
      if (!detached) {
        dres.setDetached(true);
        detached = true;
        logger.info('[AgentController] Клиент отключился, отсоединяем потоковую передачу');
      }
    };
    res.once('close', onClose);
    req.once('aborted', onClose);

    try {
      if (endpointOption && endpointOption.endpoint === 'google') {
        endpointOption.model_parameters = endpointOption.model_parameters || {};
        endpointOption.model_parameters.streaming = false;
        logger.info(`[AgentController] Google: потоковый режим отключён в headless-режиме.`);
      }
    } catch (_) {}

    let headlessInitResult = await initializeClientWithResilience({
      req,
      res: dres,
      endpointOption,
      signal: undefined,
    });
    if (!headlessInitResult || !headlessInitResult.client)
      throw new Error('Не удалось инициализировать клиент (нет результата или клиента)');

    client = headlessInitResult.client;
    if (clientRegistry) clientRegistry.register(client, { userId }, client);
    requestDataMap.set(req, { client });
    const contentRef = new WeakRef(client.contentParts || []);
    getAbortData = () => {
      return {
        sender,
        content: contentRef.deref() || [],
        userMessage,
        promptTokens,
        conversationId,
        userMessagePromise,
        messageId: responseMessageId,
        parentMessageId: userMessageId,
      };
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
      (endpointOption && endpointOption.endpoint) ||
      headlessInitResult?.endpoint ||
      client?.options?.endpoint ||
      client?.endpoint ||
      'unknown';
    if (response) response.endpoint = safeEndpoint;

    if (userMessage && text !== originalTextForDisplay) userMessage.text = originalTextForDisplay;

    try {
      if (userMessage && !client.skipSaveUserMessage) await saveMessage(req, userMessage);
      if (response) await saveMessage(req, { ...response, user: userId });
    } catch (e) {
      logger.error(`[AgentController] Ошибка при сохранении сообщений.`, e);
    }

    if (!abortController.signal.aborted && response && typeof addTitle === 'function') {
      try {
        const need = await shouldGenerateTitle(req, conversationId);
        if (need) {
          const titleSourceText = (
            userMessage?.text ||
            originalUserText ||
            req.body?.text ||
            ''
          ).slice(0, 500);
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
        logger.error(`[AgentController] Ошибка генерации заголовка (headless).`, e);
      }
    }

    if (!detached && canWrite(dres) && response) {
      sendEvent(dres, {
        final: true,
        conversation: {},
        title: undefined,
        requestMessage: userMessage,
        responseMessage: response,
      });
      responseFinalized = true;
      try {
        dres.end();
      } catch {}
    } else {
      responseFinalized = true;
      logger.info(`[AgentController] Ответ сформирован в фоне — клиент уже отключился.`);
    }

    if (useRagMemory) {
      await processConversationArtifacts({
        userMessage,
        response,
        conversationId,
      });
      
      // Fire-and-forget для суммаризации
      setImmediate(() => {
        triggerSummarization(req, conversationId).catch((err) =>
          logger.error(`[Суммаризатор] Фоновый запуск завершился ошибкой`, err),
        );
      });
    }
  } catch (error) {
    handleAbortError(res, req, error, {
      conversationId,
      sender,
      messageId: responseMessageId,
      parentMessageId: overrideParentMessageId ?? userMessageId ?? parentMessageId,
      userMessageId,
    });
  } finally {
    await performCleanup();
  }
};

/**
 * Triggers summarization workflow for a conversation
 * @param {Object} req
 * @param {string} conversationId
 * @returns {Promise<void>}
 */
async function triggerSummarization(req, conversationId) {
  const userId = req.user.id;

  if (!acquireSummarizationLock(conversationId)) {
    logger.debug(`[Суммаризатор] Диалог ${conversationId} уже обрабатывается, пропускаем.`);
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

    logger.debug(
      `[Суммаризатор] Проверка диалога ${conversationId}: всего сообщений=${messageCount}, последняя суммаризация=${lastSummarized}.`,
    );

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
      logger.debug(
        `[Суммаризатор] Недостаточно сообщений для суммаризации диалога ${conversationId}, освобождаем блокировку.`,
      );
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

    const totalContentLength = formatted.reduce((acc, msg) => acc + (msg.content?.length || 0), 0);

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
}

module.exports = AgentController;
