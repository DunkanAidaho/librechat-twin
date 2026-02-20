const { logger } = require('@librechat/data-schemas');
const {
  extractMessageText,
  normalizeMemoryText,
  makeIngestKey,
} = require('~/server/utils/messageUtils');
const { enqueueMemoryTasks } = require('~/server/services/RAG/memoryQueue');
const crypto = require('crypto');

/**
 * Message History Manager - handles message history processing and RAG ingestion
 */
class MessageHistoryManager {
  constructor(options = {}) {
    this.ingestedHistory = options.ingestedHistory || new Set();
    this.config = options.config || {};
    this.memoryTaskTimeout = options.memoryTaskTimeout || 30000;
  }

  /**
   * Hashes payload for stable ID generation
   * @param {unknown} payload
   * @returns {string}
   */
  hashPayload(payload) {
    const normalized =
      typeof payload === 'string'
        ? payload
        : JSON.stringify(
            payload ?? '',
            (_, value) => (typeof value === 'bigint' ? value.toString() : value),
          );

    return crypto.createHash('sha1').update(normalized ?? '').digest('hex');
  }

  /**
   * Processes dropped messages for RAG ingestion
   * @param {Object} params
   * @returns {Promise<void>}
   */
  async processDroppedMessages({ droppedMessages, conversationId, userId }) {
    if (!conversationId || !userId || !droppedMessages.length) {
      return;
    }

    const droppedTasks = [];

    for (const m of droppedMessages) {
      const rawText = extractMessageText(m, '[history->RAG][dropped]');
      const normalizedText = normalizeMemoryText(rawText, '[history->RAG][dropped]');

      if (!normalizedText || normalizedText.length < 20) continue;

      const dedupeKey = makeIngestKey(conversationId, m.messageId, normalizedText);
      if (this.ingestedHistory.has(dedupeKey)) continue;

      this.ingestedHistory.add(dedupeKey);

      const stableId = m.messageId || `dropped-${this.hashPayload(normalizedText).slice(0, 12)}`;
      droppedTasks.push({
        type: 'add_turn',
        payload: {
          conversation_id: conversationId,
          message_id: stableId,
          role: m?.isCreatedByUser ? 'user' : 'assistant',
          content: normalizedText,
          user_id: userId,
        },
      });
    }

    if (droppedTasks.length) {
      try {
        const result = await enqueueMemoryTasks(droppedTasks, {
          reason: 'history_window_drop',
          conversationId,
          userId,
          messageCount: droppedTasks.length,
          fireAndForget: droppedTasks.length > 50,
        });

        logger.info(`[history->RAG][dropped] queued ${droppedTasks.length} dropped messages`, {
          conversationId,
          status: result?.status,
          actualCount: result?.count,
        });
      } catch (queueError) {
        logger.error('[history->RAG][dropped] Failed to enqueue dropped messages', {
          conversationId,
          messageCount: droppedTasks.length,
          message: queueError?.message,
        });
      }
    }
  }

  /**
   * Processes message history for shrinking and RAG ingestion
   * @param {Object} params
   * @returns {Promise<{toIngest: Array, modifiedMessages: Array}>}
   */
  async processMessageHistory({
    orderedMessages,
    conversationId,
    userId,
    histLongUserToRag = 20000,
    assistLongToRag = 15000,
    assistSnippetChars = 1500,
    dontShrinkLastN = 0,
    trimmer,
    tokenBudget,
    contextHeadroom = 0,
  }) {
    const toIngest = [];
    const totalMessages = orderedMessages.length;
    const dontShrinkStartIndex = Math.max(totalMessages - dontShrinkLastN, 0);

    for (let idx = 0; idx < orderedMessages.length; idx++) {
      const m = orderedMessages[idx];
      try {
        const rawText = extractMessageText(m, '[history->RAG]');
        const normalizedText = normalizeMemoryText(rawText);
        const len = normalizedText.length;

        const looksHTML =
          /</i.test(normalizedText) && /<html|<body|<div|<p|<span/i.test(normalizedText);

        let hasThink = false;
        if (Array.isArray(m?.content)) {
          hasThink = m.content.some(
            (part) =>
              part?.type === 'think' &&
              typeof part.think === 'string' &&
              part.think.trim().length > 0,
          );
        }
        if (!hasThink) {
          hasThink = /(^|\n)\s*(Мысли|Рассуждения|Thoughts|Chain of Thought)\s*:/i.test(
            normalizedText,
          );
        }

        const shouldShrinkUser = m?.isCreatedByUser && (len > histLongUserToRag || looksHTML);
        const shouldShrinkAssistant =
          !m?.isCreatedByUser && (len > assistLongToRag || looksHTML || hasThink);

        if (
          (shouldShrinkUser || shouldShrinkAssistant) &&
          conversationId &&
          normalizedText &&
          normalizedText.length >= 20 &&
          userId
        ) {
          const dedupeKey = makeIngestKey(conversationId, m.messageId, normalizedText);

          if (this.ingestedHistory.has(dedupeKey)) {
            logger.debug('[history->RAG][dedup] skip message already enqueued', {
              conversationId,
              messageId: m?.messageId,
            });
          } else {
            const stableId =
              m.messageId || `hist-${idx}-${this.hashPayload(normalizedText).slice(0, 12)}`;
            const taskPayload = {
              message_id: stableId,
              content: normalizedText,
              role: m?.isCreatedByUser ? 'user' : 'assistant',
              user_id: userId,
            };
            this.ingestedHistory.add(dedupeKey);
            toIngest.push(taskPayload);
            logger.info('[history->RAG] prepared memory task', {
              conversationId,
              messageId: taskPayload.message_id,
              role: taskPayload.role,
              textLength: len,
            });
          }

          const roleTag = m?.isCreatedByUser ? 'user' : 'assistant';
          const isLatestMessage = idx === orderedMessages.length - 1;
          const skipShrinkForRecent = idx >= dontShrinkStartIndex;
          const keepFullText = isLatestMessage || skipShrinkForRecent;

          if (!keepFullText) {
            const snippetLen = m?.isCreatedByUser ? 2000 : assistSnippetChars;
            const snippet = normalizedText.slice(0, snippetLen);
            m.text = `[[moved_to_memory:RAG,len=${len},role=${roleTag}]]\n\n${snippet}`;
            if (Array.isArray(m?.content)) {
              m.content = [{ type: 'text', text: m.text }];
            }

            const limitLabel = m?.isCreatedByUser ? 'HIST_LONG_USER_TO_RAG' : 'ASSIST_LONG_TO_RAG';
            const limitValue = m?.isCreatedByUser ? histLongUserToRag : assistLongToRag;
            const shrinkReason = looksHTML ? 'html' : hasThink ? 'reasoning' : 'length';
            logger.info(
              `[prompt][shrink] idx=${idx} role=${roleTag} reason=${shrinkReason} limit=${limitLabel} limitValue=${limitValue} snippetLen=${snippet.length}`,
            );
          } else {
            logger.info(
              `[prompt][shrink] idx=${idx} role=${roleTag} len=${len} action=keep-full keepReason=memory.history.dontShrinkLastN value=${dontShrinkLastN}`,
            );
          }
        }
      } catch (error) {
        logger.warn('[history->RAG] error while scanning message', {
          conversationId,
          messageId: m?.messageId,
          error: error?.message,
          stack: error?.stack,
        });
      }
    }

    let trimmedMessages = orderedMessages;
    if (trimmer && typeof trimmer.selectWithinBudget === 'function') {
      try {
        const effectiveBudget = Math.max(0, Number(tokenBudget) || 0);
        const headroom = Math.max(0, Number(contextHeadroom) || 0);
        const budget = effectiveBudget - headroom;
        if (budget > 0) {
          const layers = trimmer.buildLayers(orderedMessages);
          const compressedLayers = await trimmer.compressLayers(layers);
          const { keptMessages, stats, remainingTokens } = trimmer.selectWithinBudget(
            compressedLayers,
            budget,
          );

          trimmedMessages = keptMessages;
          logger.info('[contextCompression.layers]', {
            conversationId,
            budget,
            contextHeadroom: headroom,
            remainingTokens,
            layers: stats.map((stat) => ({
              layer: stat.layer,
              messageCount: stat.messageCount,
              tokens: stat.tokens,
            })),
          });
        }
      } catch (error) {
        logger.error('[contextCompression.error]', {
          conversationId,
          message: error?.message,
        });
      }
    }

    return { toIngest, modifiedMessages: trimmedMessages };
  }

  /**
   * Enqueues memory tasks for RAG ingestion
   * @param {Object} params
   * @returns {Promise<boolean>}
   */
  async enqueueMemoryTasks({ toIngest, conversationId, userId, reason = 'history_sync' }) {
    if (!toIngest.length || !conversationId) {
      return false;
    }

    const tasks = toIngest
      .map((t) => ({
        type: 'add_turn',
        payload: {
          conversation_id: conversationId,
          message_id: t.message_id,
          role: t.role,
          content: t.content,
          user_id: t.user_id,
        },
      }))
      .filter((task) => task.payload.user_id);

    if (tasks.length) {
      const totalLength = tasks.reduce((acc, task) => acc + (task.payload.content?.length ?? 0), 0);

      try {
        const result = await enqueueMemoryTasks(tasks, {
          reason,
          conversationId,
          userId,
          textLength: totalLength,
        });

        logger.info(
          `[history->RAG] queued ${tasks.length} turn(s) через JetStream ` +
            `(conversation=${conversationId}, totalChars=${totalLength}).`,
        );

        return result?.status === 'queued';
      } catch (queueError) {
        logger.error('[history->RAG] Failed to enqueue history tasks', {
          conversationId,
          messageCount: tasks.length,
          message: queueError?.message,
        });
        return false;
      }
    }

    return false;
  }

  /**
   * Truncates message history to max limit
   * @param {Array} orderedMessages
   * @param {number} maxMessages
   * @returns {{keptMessages: Array, droppedMessages: Array}}
   */
  truncateHistory(orderedMessages, maxMessages = 25) {
    const systemMessage = orderedMessages.find((m) => m.role === 'system');
    const otherMessages = orderedMessages.filter((m) => m.role !== 'system');
    let droppedMessages = [];

    if (otherMessages.length > maxMessages) {
      const keptMessages = otherMessages.slice(-maxMessages);
      droppedMessages = otherMessages.slice(0, otherMessages.length - maxMessages);

      const finalMessages = systemMessage ? [systemMessage, ...keptMessages] : keptMessages;

      logger.warn(
        `[PROMPT-LIMIT] Принудительно усекаем историю с ${otherMessages.length} до ${maxMessages} сообщений. Dropped: ${droppedMessages.length}`,
      );

      return { keptMessages: finalMessages, droppedMessages };
    }

    return { keptMessages: orderedMessages, droppedMessages: [] };
  }
}

module.exports = MessageHistoryManager;
