'use strict';

const { StringCodec } = require('nats');
const { getLogger } = require('~/utils/logger');
const { getOrCreateKV, isEnabled: isNatsEnabled } = require('~/utils/natsClient');
const { withTimeout } = require('~/utils/async');

const logger = getLogger('rag.summaryCache');
const DEFAULT_TIMEOUT_MS = 2000;
const KV_TTL_MS = 2_592_000_000; // 30 дней
const KV_BUCKET = 'history_summary_cache';
const KV_MAX_VALUE_SIZE = 32768;

class SummaryCacheStore {
  constructor() {
    this.kv = null;
    this.initializing = null;
  }

  async getKV() {
    if (this.kv) {
      return this.kv;
    }
    if (this.initializing) {
      return this.initializing;
    }
    this.initializing = (async () => {
      if (!isNatsEnabled()) {
        logger.warn('[summaryCache] NATS отключён → KV недоступен');
        this.kv = null;
        return null;
      }
      try {
        const kv = await withTimeout(
          getOrCreateKV(KV_BUCKET, {
            ttl: KV_TTL_MS,
            history: 1,
            maxValueSize: KV_MAX_VALUE_SIZE,
          }),
          DEFAULT_TIMEOUT_MS,
          'KV create',
        );
        this.kv = kv;
        if (!kv) {
          logger.warn(`[summaryCache] KV bucket недоступен (bucket=${KV_BUCKET})`);
        }
        return kv;
      } catch (error) {
        logger.error(`[summaryCache] Ошибка инициализации KV: ${error.message}`);
        this.kv = null;
        return null;
      } finally {
        this.initializing = null;
      }
    })();
    return this.initializing;
  }

  buildKey(conversationId, messageId) {
    const safeConversation = String(conversationId).replace(/[:\s]/g, '.');
    const safeMessage = String(messageId).replace(/[:\s]/g, '.');
    return `dialog.${safeConversation}.${safeMessage}`;
  }

  async get(conversationId, messageId) {
    if (!conversationId || !messageId) {
      return null;
    }
    const kv = await this.getKV();
    if (!kv) {
      return null;
    }
    try {
      const key = this.buildKey(conversationId, messageId);
      const entry = await withTimeout(kv.get(key), DEFAULT_TIMEOUT_MS, 'KV get');
      if (!entry?.value) {
        return null;
      }
      const decoded = StringCodec().decode(entry.value);
      const payload = JSON.parse(decoded);
      if (!payload?.summaryText) {
        return null;
      }
      return {
        summaryText: payload.summaryText,
        originalLength: payload.originalLength,
      };
    } catch (error) {
      logger.warn(`[summaryCache] KV get failed: ${error.message}`);
      return null;
    }
  }

  async set(conversationId, messageId, summaryText, originalLength) {
    if (!conversationId || !messageId || !summaryText) {
      return;
    }
    const kv = await this.getKV();
    if (!kv) {
      return;
    }
    try {
      let safeSummary = summaryText;
      let payload = JSON.stringify({
        summaryText: safeSummary,
        originalLength: Number(originalLength) || summaryText.length,
        createdAt: Date.now(),
        version: 1,
      });
      if (Buffer.byteLength(payload, 'utf8') > KV_MAX_VALUE_SIZE) {
        const maxChars = Math.max(1000, Math.floor(KV_MAX_VALUE_SIZE * 0.7));
        safeSummary = safeSummary.slice(0, maxChars);
        payload = JSON.stringify({
          summaryText: safeSummary,
          originalLength: Number(originalLength) || summaryText.length,
          createdAt: Date.now(),
          version: 1,
          truncated: true,
        });
      }
      const key = this.buildKey(conversationId, messageId);
      const sc = StringCodec();
      await withTimeout(kv.put(key, sc.encode(payload)), DEFAULT_TIMEOUT_MS, 'KV put');
    } catch (error) {
      logger.warn(`[summaryCache] KV put failed: ${error.message}`);
    }
  }

  async getMissing(conversationId, messageIds = []) {
    if (!conversationId || !Array.isArray(messageIds) || !messageIds.length) {
      return [];
    }
    const missing = [];
    for (const messageId of messageIds) {
      const cached = await this.get(conversationId, messageId);
      if (!cached) {
        missing.push(messageId);
      }
    }
    return missing;
  }
}

module.exports = {
  SummaryCacheStore,
};
