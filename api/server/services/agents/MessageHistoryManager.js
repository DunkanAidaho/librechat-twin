const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');
const {
  extractMessageText,
  normalizeMemoryText,
  makeIngestKey,
  extractContentDates,
} = require('~/server/utils/messageUtils');
const { enqueueMemoryTasks } = require('~/server/services/RAG/memoryQueue');
const { ensureTokenCount } = require('~/server/services/agents/historyTrimmer');
const { observeHistoryPassthrough, observeLiveWindow } = require('~/utils/ragMetrics');
const ingestDeduplicator = require('~/server/services/Deduplication/ingestDeduplicator');
const { NatsKvLastProcessed } = require('~/utils/natsKvLastProcessed');
const crypto = require('crypto');

/**
 * Message History Manager - handles message history processing and RAG ingestion
 */
class MessageHistoryManager {
  constructor(options = {}) {
    this.ingestedHistory = options.ingestedHistory || new Set();
    this.config = options.config || {};
    this.memoryTaskTimeout = options.memoryTaskTimeout || 30000;
    this.logger = getLogger('rag.history');
    this.lastProcessedStore = options.lastProcessedStore || new NatsKvLastProcessed();
  }

  sliceLiveWindow({ orderedMessages = [], size = 8, minUserMessages = 1, minAssistantMessages = 1 }) {
    if (!Array.isArray(orderedMessages) || orderedMessages.length === 0) {
      return { keptMessages: orderedMessages, droppedMessages: [] };
    }

    const targetSize = Math.max(0, size);
    const baseTail = orderedMessages.slice(-targetSize);
    let userCount = baseTail.filter((m) => m?.role === 'user').length;
    let assistantCount = baseTail.filter((m) => m?.role === 'assistant').length;

    let idx = orderedMessages.length - targetSize - 1;
    const requiredUser = Math.max(0, minUserMessages);
    const requiredAssistant = Math.max(0, minAssistantMessages);
    const headBuffer = [];

    while ((userCount < requiredUser || assistantCount < requiredAssistant) && idx >= 0) {
      const candidate = orderedMessages[idx];
      headBuffer.push(candidate);
      if (candidate?.role === 'user') userCount += 1;
      if (candidate?.role === 'assistant') assistantCount += 1;
      idx -= 1;
    }

    const keptMessages = [...headBuffer.reverse(), ...baseTail];
    const keptIds = new Set(keptMessages.map((m) => m?.messageId));
    const droppedMessages = orderedMessages.filter((m) => !keptIds.has(m?.messageId));
    return { keptMessages, droppedMessages };
  }

  getLogContext(conversationId, userId, extra = {}) {
    if (conversationId || userId) {
      return buildContext({ conversationId, userId }, extra);
    }
    return buildContext({}, extra);
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

      const dedupeResult = await ingestDeduplicator.markAsIngested(
        dedupeKey,
        'index_text',
      );
      if (dedupeResult?.deduplicated) {
        continue;
      }

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

        this.logger.info(
          'rag.history.drop_enqueue',
          this.getLogContext(conversationId, userId, {
            messageCount: droppedTasks.length,
            status: result?.status,
            actualCount: result?.count,
          }),
        );
      } catch (queueError) {
        this.logger.error(
          'rag.history.drop_enqueue_failure',
          this.getLogContext(conversationId, userId, {
            messageCount: droppedTasks.length,
            err: { message: queueError?.message, stack: queueError?.stack },
          }),
        );
      }
    }
  }

  /**
   * Processes message history for shrinking and RAG ingestion
   * @param {Object} params
   * @returns {Promise<{toIngest: Array, modifiedMessages: Array}>}
   */
  async processMessageHistory({
    orderedMessages = [],
    conversationId,
    userId,
    histLongUserToRag = 20000,
    assistLongToRag = 15000,
    assistSnippetChars = 0,
    trimmer = null,
    tokenBudget = 0,
    contextHeadroom = 0,
    condenseContext = null,
    condenseChain = [],
  }) {
    const toIngest = [];
    const config = typeof this.config === 'function' ? this.config() : this.config;
    const historyMode = config?.history?.mode || 'legacy';
    const liveWindowCfg = config?.history?.liveWindow || {};
    let heavyCount = 0;
    let lastProcessed = 0;
    let skippedByTimestamp = 0;
    let skippedByDedupe = 0;

    if (conversationId) {
      lastProcessed = await this.lastProcessedStore.getLastProcessed(conversationId);
    }

    for (let idx = 0; idx < orderedMessages.length; idx++) {
      const m = orderedMessages[idx];
      try {
        if (lastProcessed > 0) {
          const createdAt = m?.createdAt ? new Date(m.createdAt).getTime() : 0;
          if (!createdAt && typeof m?.messageId === 'string') {
            const idAsNumber = Number(m.messageId);
            if (Number.isFinite(idAsNumber)) {
              if (idAsNumber <= lastProcessed) {
                skippedByTimestamp += 1;
                continue;
              }
            }
          }
          if (createdAt && createdAt <= lastProcessed) {
            skippedByTimestamp += 1;
            continue;
          }
        }
        const rawText = extractMessageText(m, '[history->RAG]');
        const normalizedText = normalizeMemoryText(rawText);
        const len = normalizedText.length;

        if (m?.isCreatedByUser) {
          this.logger.debug(
            'rag.history.user_message_length',
            this.getLogContext(conversationId, userId, {
              messageId: m?.messageId,
              length: len,
              histLongUserToRag,
            }),
          );
        }

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
          const originalLength = normalizedText.length;
          let summaryText = null;
          let appliedSummary = null;
          if (typeof condenseContext === 'function') {
            const summaryLogContext = this.getLogContext(conversationId, userId, {
              messageId: m?.messageId,
              textLength: originalLength,
            });
            try {
              this.logger.info('rag.history.summary_start', summaryLogContext);
              summaryText = await condenseContext({
                chain: condenseChain || [],
                prompt: `Сделай краткую выжимку 50-200 слов.\n\n=== Текст ===\n${normalizedText}`,
                originalText: normalizedText,
                budgetChars: Math.min(
                  8000,
                  Math.max(2000, Math.floor(normalizedText.length * 0.04)),
                ),
                stage: 'ingest:summary',
                requestContext: {
                  conversationId,
                  userId,
                  messageId: m?.messageId,
                },
              });
              if (summaryText && typeof summaryText === 'object') {
                this.logger.info(
                  'rag.history.summary_provider',
                  Object.assign({}, summaryLogContext, {
                    provider: summaryText?.providerLabel || summaryText?.provider || 'unknown',
                  }),
                );
              }
              summaryText = summaryText?.text || summaryText;
              const resolvedSummary = summaryText?.text || summaryText;
              summaryText = resolvedSummary;
              this.logger.info(
                'rag.history.summary_done',
                Object.assign({}, summaryLogContext, {
                  originalLength,
                  summaryLength: resolvedSummary?.length || 0,
                }),
              );

              const trimmedSummary = typeof summaryText === 'string' ? summaryText.trim() : '';
              if (trimmedSummary) {
                appliedSummary = trimmedSummary;
                m.text = trimmedSummary;
                m.content = [{ type: 'text', text: trimmedSummary }];
                m.isMemoryStored = true;
                const ratio = originalLength > 0 ? Number((trimmedSummary.length / originalLength).toFixed(3)) : 0;
                this.logger.debug(
                  'rag.history.summary_applied',
                  Object.assign({}, summaryLogContext, {
                    originalLength,
                    summaryLength: trimmedSummary.length,
                    ratio,
                  }),
                );
              } else {
                this.logger.warn(
                  'rag.history.summary_empty',
                  Object.assign({}, summaryLogContext, {
                    originalLength,
                  }),
                );
              }
            } catch (summaryError) {
              this.logger.error(
                'rag.history.summary_error',
                Object.assign({}, summaryLogContext, {
                  err: { message: summaryError?.message, stack: summaryError?.stack },
                }),
              );
              throw summaryError;
            }
          }

          const dedupeKey = makeIngestKey(conversationId, m.messageId, normalizedText);

          if (this.ingestedHistory.has(dedupeKey)) {
            this.logger.debug(
              'rag.history.dedup_skip',
              this.getLogContext(conversationId, userId, {
                messageId: m?.messageId,
              }),
            );
          } else {
            const dedupeResult = await ingestDeduplicator.markAsIngested(
              dedupeKey,
              'index_text',
            );
            if (dedupeResult?.deduplicated) {
              skippedByDedupe += 1;
              this.logger.info(
                'rag.history.dedup_skip',
                this.getLogContext(conversationId, userId, {
                  messageId: m?.messageId,
                  mode: dedupeResult.mode,
                }),
              );
              continue;
            }
            const stableId =
              m.messageId || `hist-${idx}-${this.hashPayload(normalizedText).slice(0, 12)}`;
            const contentPayload = appliedSummary || normalizedText;
            const taskPayload = {
              message_id: stableId,
              content: contentPayload,
              summary: appliedSummary ? undefined : summaryText || undefined,
              content_dates: extractContentDates(normalizedText),
              conversation_id: conversationId,
              message_index: idx,
              created_at: m?.createdAt || new Date().toISOString(),
              importance_score: typeof m?.importance === 'number' ? m.importance : undefined,
              role: m?.isCreatedByUser ? 'user' : 'assistant',
              user_id: userId,
            };
            this.ingestedHistory.add(dedupeKey);
            toIngest.push(taskPayload);
            this.logger.info(
              'rag.history.memory_task_prepared',
              this.getLogContext(conversationId, userId, {
                messageId: taskPayload.message_id,
                role: taskPayload.role,
                textLength: len,
              }),
            );
          }

          const roleTag = m?.isCreatedByUser ? 'user' : 'assistant';
          const limitLabel = m?.isCreatedByUser ? 'HIST_LONG_USER_TO_RAG' : 'ASSIST_LONG_TO_RAG';
          const limitValue = m?.isCreatedByUser ? histLongUserToRag : assistLongToRag;
          const shrinkReason = looksHTML ? 'html' : hasThink ? 'reasoning' : 'length';

          this.logger.info(
            'rag.history.prompt_passthrough',
            this.getLogContext(conversationId, userId, {
              index: idx,
              role: roleTag,
              len,
              reason: shrinkReason,
              limitLabel,
              limitValue,
            }),
          );

          observeHistoryPassthrough({
            role: roleTag,
            reason: shrinkReason,
            length: len,
          });
          heavyCount += 1;
        }
      } catch (error) {
        this.logger.error(
          'rag.history.scan_error',
          this.getLogContext(conversationId, userId, {
            messageId: m?.messageId,
            err: { message: error?.message, stack: error?.stack },
          }),
        );
      }
    }

    if (heavyCount > 0) {
      this.logger.info(
        'rag.history.heavy_total',
        this.getLogContext(conversationId, userId, {
          heavyCount,
        }),
      );
    }

    if (skippedByTimestamp || skippedByDedupe) {
      this.logger.info(
        'rag.history.skip_summary',
        this.getLogContext(conversationId, userId, {
          skippedByTimestamp,
          skippedByDedupe,
        }),
      );
    }

    let finalMessages = orderedMessages;
    let droppedMessages = [];

    if (historyMode === 'live_window' && liveWindowCfg.size > 0) {
      const { keptMessages, droppedMessages: dropped } = this.sliceLiveWindow({
        orderedMessages,
        size: liveWindowCfg.size,
        minUserMessages: liveWindowCfg.minUserMessages,
        minAssistantMessages: liveWindowCfg.minAssistantMessages,
      });
      finalMessages = keptMessages;
      droppedMessages = dropped;

      if (droppedMessages.length) {
        this.logger.info(
          'rag.history.live_window_dropped',
          this.getLogContext(conversationId, userId, {
            mode: historyMode,
            requestedSize: liveWindowCfg.size,
            kept: finalMessages.length,
            dropped: droppedMessages.length,
          }),
        );
        observeLiveWindow({ mode: historyMode, size: finalMessages.length });
        await this.processDroppedMessages({
          droppedMessages,
          conversationId,
          userId,
        });
      } else {
        this.logger.info(
          'rag.history.live_window_kept',
          this.getLogContext(conversationId, userId, {
            mode: historyMode,
            requestedSize: liveWindowCfg.size,
            kept: finalMessages.length,
          }),
        );
        observeLiveWindow({ mode: historyMode, size: finalMessages.length });
      }
    } else {
      this.logger.info(
        'rag.history.mode_selected',
        this.getLogContext(conversationId, userId, {
          mode: historyMode,
          liveWindowSize: liveWindowCfg.size,
          minUserMessages: liveWindowCfg.minUserMessages,
          minAssistantMessages: liveWindowCfg.minAssistantMessages,
        }),
      );

      observeLiveWindow({ mode: historyMode, size: finalMessages.length });
    }

    let trimmedMessages = finalMessages;
    let trimmedDropped = [];

    const effectiveBudget = Math.max(Number(tokenBudget || 0) - Number(contextHeadroom || 0), 0);
    if (trimmer && effectiveBudget > 0 && Array.isArray(finalMessages) && finalMessages.length) {
      try {
        const layers = trimmer.buildLayers(finalMessages);
        const compressedLayers = await trimmer.compressLayers(layers);
        const selection = trimmer.selectWithinBudget(compressedLayers, effectiveBudget);
        trimmedMessages = selection.keptMessages;
        trimmedDropped = selection.droppedMessages;

        const lastUserMessage = [...finalMessages]
          .reverse()
          .find((m) => m?.role === 'user' || m?.isCreatedByUser);
        if (lastUserMessage && !trimmedMessages.includes(lastUserMessage)) {
          ensureTokenCount(lastUserMessage, trimmer.tokenizerEncoding);
          trimmedMessages.push(lastUserMessage);
          trimmedMessages = trimmedMessages
            .filter((m) => m !== lastUserMessage)
            .concat(lastUserMessage);
          while (trimmedMessages.length > 1) {
            const head = trimmedMessages[0];
            ensureTokenCount(head, trimmer.tokenizerEncoding);
            const totalTokens = trimmedMessages.reduce(
              (sum, msg) => sum + (msg?.tokenCount ?? 0),
              0,
            );
            if (totalTokens <= effectiveBudget) {
              break;
            }
            trimmedMessages.shift();
            trimmedDropped.push(head);
          }
        }

        if (!trimmedMessages.length && finalMessages.length === 1) {
          const onlyMessage = finalMessages[0];
          ensureTokenCount(onlyMessage, trimmer.tokenizerEncoding);
          if ((onlyMessage?.tokenCount ?? 0) <= effectiveBudget) {
            trimmedMessages = [onlyMessage];
          }
        }

        this.logger.info(
          'context.history.selection',
          this.getLogContext(conversationId, userId, {
            tokenBudget: effectiveBudget,
            kept: trimmedMessages.length,
            dropped: trimmedDropped.length,
            remainingTokens: selection.remainingTokens,
          }),
        );
      } catch (error) {
        this.logger.error(
          'context.history.selection_failed',
          this.getLogContext(conversationId, userId, {
            tokenBudget: effectiveBudget,
            err: { message: error?.message, stack: error?.stack },
          }),
        );
      }
    }

    return {
      toIngest,
      modifiedMessages: trimmedMessages,
      liveWindowStats: {
        mode: historyMode,
        kept: trimmedMessages.length,
        dropped: droppedMessages.length + trimmedDropped.length,
      },
    };
  }

  /**
   * Enqueues memory tasks for RAG ingestion
   * @param {Object} params
   * @returns {Promise<boolean>}
   */
  async enqueueMemoryTasks({ toIngest = [], conversationId, userId, reason = 'history_sync' } = {}) {
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
      tasks.forEach((task, index) => {
        task.payload.message_index = index;
      });
      const totalLength = tasks.reduce((acc, task) => acc + (task.payload.content?.length ?? 0), 0);

      try {
        const result = await enqueueMemoryTasks(tasks, {
          reason,
          conversationId,
          userId,
          textLength: totalLength,
        });

        this.logger.info(
          'rag.history.enqueue_success',
          this.getLogContext(conversationId, userId, {
            messageCount: tasks.length,
            reason,
            textLength: totalLength,
          }),
        );

        if (result?.status === 'queued') {
          await this.lastProcessedStore.updateLastProcessed(
            conversationId,
            Date.now(),
          );
          return true;
        }
        return false;
      } catch (queueError) {
        this.logger.error(
          'rag.history.enqueue_failure',
          this.getLogContext(conversationId, userId, {
            messageCount: tasks.length,
            reason,
            err: { message: queueError?.message, stack: queueError?.stack },
          }),
        );
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

      this.logger.warn(
        'rag.history.prompt_limit',
        buildContext({}, {
          maxMessages,
          droppedCount: droppedMessages.length,
          totalMessages: otherMessages.length,
        }),
      );

      return { keptMessages: finalMessages, droppedMessages };
    }

    return { keptMessages: orderedMessages, droppedMessages: [] };
  }
}

module.exports = MessageHistoryManager;
