const { getLogger } = require('~/utils/logger');
const { Tokenizer } = require('@librechat/api');

const { createHash } = require('crypto');
const {
  incOverflowRagDefer,
  incOverflowHardTruncate,
  observeOverflowSummary,
  observeOverflowHardTruncateRatio,
} = require('~/utils/metrics');

const logger = getLogger('agents.overflow');

const CHARS_PER_TOKEN = 4;
const summaryCache = new Map();

function hashText(text, extra = '') {
  return createHash('sha256').update(text || '').update(String(extra)).digest('hex');
}

function getCachedSummary(key, ttlMs) {
  if (!summaryCache.has(key)) {
    return null;
  }
  const entry = summaryCache.get(key);
  if (!entry || (ttlMs && Date.now() > entry.expiresAt)) {
    summaryCache.delete(key);
    return null;
  }
  return entry.summary;
}

function setCachedSummary(key, summary, ttlMs) {
  if (!ttlMs || ttlMs <= 0) {
    return;
  }
  summaryCache.set(key, { summary, expiresAt: Date.now() + ttlMs });
  if (summaryCache.size > 10000) {
    const keysToDelete = Array.from(summaryCache.keys()).slice(0, 200);
    keysToDelete.forEach((keyToDelete) => summaryCache.delete(keyToDelete));
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of summaryCache.entries()) {
    if (!entry || now > entry.expiresAt) {
      summaryCache.delete(key);
    }
  }
}, 86_400_000).unref?.();

function extractText(message) {
  if (!message) {
    return '';
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  if (typeof message.text === 'string') {
    return message.text;
  }
  return '';
}

function applyText(message, nextText) {
  if (!message) {
    return;
  }
  if (typeof message.content === 'string' || message.content == null) {
    message.content = nextText;
    return;
  }
  if (Array.isArray(message.content)) {
    message.content = [
      {
        type: 'text',
        text: nextText,
      },
    ];
    return;
  }
  message.content = nextText;
}

function preserveHeadTail(text, maxChars, headRatio = 0.15, tailRatio = 0.15) {
  if (!text || text.length <= maxChars) {
    return text;
  }

  const headChars = Math.max(1, Math.floor(maxChars * headRatio));
  const tailChars = Math.max(1, Math.floor(maxChars * tailRatio));
  const middleChars = Math.max(1, maxChars - headChars - tailChars);

  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  return `${head}\n\n[...TRUNCATED...]\n\n${tail}`.slice(0, headChars + tailChars + middleChars + 20);
}

async function summarizeLargeText({
  text,
  ragCondenseContext,
  loggerContext,
  budgetTokens,
  chunkTokens,
  timeoutMs,
  provider,
  endpointOption,
  req,
  res,
  cacheKey,
  cacheTtlMs,
  overlapChars,
}) {
  if (!ragCondenseContext || !text) {
    return text;
  }

  let effectiveBudgetTokens = budgetTokens;
  if (effectiveBudgetTokens < 500) {
    logger.warn('context.overflow.budget_too_small', {
      ...loggerContext,
      budgetTokens: effectiveBudgetTokens,
    });
    effectiveBudgetTokens = 500;
  }
  const budgetChars = Math.floor(effectiveBudgetTokens * CHARS_PER_TOKEN);
  const chunkChars = Math.max(2000, Math.floor(chunkTokens * CHARS_PER_TOKEN));

  const cached = getCachedSummary(cacheKey, cacheTtlMs);
  if (cached) {
    return cached;
  }

  let summary = '';
  const summaryStartedAt = Date.now();
  try {
    summary = await ragCondenseContext({
      req,
      res,
      endpointOption,
      contextText: text,
      userQuery: '',
      graphContext: null,
      budgetChars,
      chunkChars,
      overlapChars,
      provider: provider || 'auto',
      timeoutMs,
      requestContext: loggerContext,
    });
  } catch (error) {
    logger.error('context.overflow.summary_error', {
      ...loggerContext,
      message: error?.message,
      stack: error?.stack,
    });
    observeOverflowSummary('error', Date.now() - summaryStartedAt);
    summary = '';
  }

  setCachedSummary(cacheKey, summary, cacheTtlMs);
  return summary;
}

async function applyOverflowGuard({
  messages,
  encoding,
  config,
  ragCondenseContext,
  loggerContext,
  endpointOption,
  req,
  res,
}) {
  if (!config?.enabled || !Array.isArray(messages) || messages.length === 0) {
    return { messages, action: 'skipped' };
  }

  const lastHuman = [...messages]
    .reverse()
    .find((msg) => (msg?._getType?.() || msg?.role) === 'human');

  if (!lastHuman) {
    return { messages, action: 'skipped' };
  }

  let rawText = extractText(lastHuman);
  if (!rawText) {
    return { messages, action: 'skipped' };
  }

  let tokenCount = Tokenizer.getTokenCount(rawText, encoding || 'o200k_base');
  const overflowStats = {
    originalTokens: tokenCount,
    originalChars: rawText.length,
  };

  if (config.maxUserMsgToModelChars && rawText.length > config.maxUserMsgToModelChars) {
    const truncated = config.preserveHeadTail
      ? preserveHeadTail(rawText, config.maxUserMsgToModelChars)
      : rawText.slice(0, config.maxUserMsgToModelChars);
    applyText(lastHuman, truncated);
    rawText = truncated;
    tokenCount = Tokenizer.getTokenCount(rawText, encoding || 'o200k_base');
    logger.warn('context.overflow.max_user_msg_truncate', {
      ...loggerContext,
      originalChars: overflowStats.originalChars,
      maxUserMsgToModelChars: config.maxUserMsgToModelChars,
    });
  }

  if (tokenCount < config.chunkingThresholdTokens) {
    return { messages, action: 'none', stats: overflowStats };
  }

  const budgetTokens = Math.max(1, config.dynamicBudgetTokens);
  const hardCapTokens = Math.max(1, config.hardTruncateCapTokens);
  const targetTokens = Math.min(budgetTokens, hardCapTokens);

  if (config.enableRagProcessing && tokenCount >= config.ragThresholdTokens) {
    const notice = config.noticeRag;
    applyText(lastHuman, notice);
    logger.warn('context.overflow.rag_defer', {
      ...loggerContext,
      originalTokens: tokenCount,
      ragThresholdTokens: config.ragThresholdTokens,
      strategy: config.enableChunkingProcessing ? 'chunking_enabled' : 'chunking_disabled',
    });
    if (typeof config.enableRagProcessing === 'boolean' && !config.enableRagProcessing) {
      logger.warn('context.overflow.rag_disabled', {
        ...loggerContext,
        originalTokens: tokenCount,
      });
    }
    incOverflowRagDefer('rag_threshold');
    return { messages, action: 'rag_defer', stats: overflowStats, notice };
  }

  if (config.enableChunkingProcessing && tokenCount >= config.chunkingThresholdTokens) {
    const isStructured = /\n\s*(?:[-*]|\d+\.|#{1,6})\s+/.test(rawText);
    const overlapRatio = isStructured ? 0.05 : 0.15;
    const chunkTokens = Math.min(
      Math.floor(targetTokens * (isStructured ? 0.4 : 0.6)),
      Math.max(2000, targetTokens - 1000),
    );
    const overlapChars = Math.max(0, Math.floor(chunkTokens * CHARS_PER_TOKEN * overlapRatio));
    const cacheKey = hashText(rawText, `${targetTokens}:${config.summaryProvider}`);
    const summaryPromise = summarizeLargeText({
      text: rawText,
      ragCondenseContext,
      loggerContext,
      budgetTokens: targetTokens,
      chunkTokens,
      timeoutMs: config.summaryTimeoutMs,
      provider: config.summaryProvider,
      endpointOption,
      req,
      res,
      cacheKey,
      cacheTtlMs: config.summaryCacheTtlMs,
      overlapChars,
    });

    let summary = '';
    const startedAt = Date.now();
    try {
      summary = await Promise.race([
        summaryPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Summary timeout')), config.summaryTimeoutMs),
        ),
      ]);
    } catch (summaryError) {
      logger.warn('context.overflow.summary_timeout', {
        ...loggerContext,
        message: summaryError?.message,
        timeoutMs: config.summaryTimeoutMs,
      });
      observeOverflowSummary('timeout', Date.now() - startedAt);
      summary = '';
    }

    if (summary) {
      applyText(lastHuman, summary);
      const processedTokens = Tokenizer.getTokenCount(summary, encoding || 'o200k_base');
      logger.info('context.overflow.summary_used', {
        ...loggerContext,
        originalTokens: tokenCount,
        processedTokens,
        budgetTokens: targetTokens,
        durationMs: Date.now() - startedAt,
      });
      observeOverflowSummary('success', Date.now() - startedAt);
      return { messages, action: 'summary', stats: overflowStats };
    }
  }

  const maxChars = Math.max(1, Math.floor(targetTokens * CHARS_PER_TOKEN));
  const truncated = config.preserveHeadTail
    ? preserveHeadTail(rawText, maxChars)
    : rawText.slice(0, maxChars);
  applyText(lastHuman, truncated);

  const processedTokens = Tokenizer.getTokenCount(truncated, encoding || 'o200k_base');
  const truncateRatio =
    tokenCount > 0
      ? Math.max(0, (tokenCount - processedTokens) / tokenCount)
      : 0;

  logger.warn('context.overflow.hard_truncate', {
    ...loggerContext,
    originalTokens: tokenCount,
    processedTokens,
    targetTokens,
    preserveHeadTail: config.preserveHeadTail,
    truncateRatio,
  });
  incOverflowHardTruncate('hard_truncate');
  observeOverflowHardTruncateRatio(
    'hard_truncate',
    truncateRatio,
    config.preserveHeadTail ? 'head_tail' : 'simple',
  );

  return {
    messages,
    action: 'hard_truncate',
    stats: overflowStats,
    notice: config.noticeTruncate,
  };
}

module.exports = {
  applyOverflowGuard,
};
