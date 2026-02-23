'use strict';

const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');
const { withTimeout, createAbortError } = require('~/utils/async');

const DEFAULT_TIMEOUT_MS = 2000;
const MIN_CONFIDENCE = 0.35;
const logger = getLogger('rag.intentAnalyzer');
const ENTITY_REGEX = /\b([A-ZА-ЯЁ][a-zа-яё]+(?:\s+[A-ZА-ЯЁ][a-zа-яё]+)*)\b/g;
const RELATION_HINT_REGEX = /(между|связ(ь|и)|отношени[яе]|контакт[ы]?)/i;

/**
 * Простая эвристика извлечения сущностей из текста
 * @param {string} text
 * @returns {Array<{ name: string, type: string, confidence: number, hints: string[] }>}
 */
function extractEntities(text = '') {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const matches = new Map();
  let match;
  while ((match = ENTITY_REGEX.exec(text)) != null) {
    const candidate = match[1].trim();
    if (!candidate) continue;

    const key = candidate.toLowerCase();
    const prev = matches.get(key) || { count: 0, name: candidate };
    matches.set(key, { count: prev.count + 1, name: candidate });
  }

  return Array.from(matches.values()).map(({ count, name }) => ({
    name,
    type: /(inc|corp|llc|gmbh|АО|ООО|ЗАО|ИП|банк)/i.test(name)
      ? 'organization'
      : 'person',
    confidence: Math.min(0.9, MIN_CONFIDENCE + count * 0.1),
    hints: [],
  }));
}

function buildHints(messageText = '', contextText = '') {
  const hints = new Set();
  if (RELATION_HINT_REGEX.test(messageText) || RELATION_HINT_REGEX.test(contextText)) {
    hints.add('relations');
  }
  if (/timeline|period|\bгод\b|дата|when|когда/i.test(messageText)) {
    hints.add('timeline');
  }
  if (/детал/i.test(messageText)) {
    hints.add('details');
  }
  return Array.from(hints);
}

async function runAnalysis({ message, context, signal }) {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }

  const text = message?.text || '';
  const contextText = Array.isArray(context)
    ? context.map((m) => m?.text || '').join('\n')
    : typeof context === 'string'
      ? context
      : '';

  const entities = extractEntities(text).map((entity) => ({
    ...entity,
    hints: buildHints(text, contextText),
  }));

  const needsFollowUps = entities.some((entity) => entity.confidence >= 0.5);

  return {
    entities,
    needsFollowUps,
  };
}

async function analyzeIntent({
  message,
  context,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logPrefix = '[rag.intent]',
} = {}) {
  const startedAt = Date.now();
  const operation = runAnalysis({ message, context, signal });
  const baseContext = buildContext(
    {
      conversationId: message?.conversationId || context?.conversationId,
      requestId: signal?.requestId,
      userId: message?.userId,
    },
    {
      logPrefix,
    },
  );

  logger.info('rag.intent.analyze_start', baseContext);

  try {
    const result = await withTimeout(operation, timeoutMs, 'Intent analysis timed out', signal);
    const duration = Date.now() - startedAt;

    logger.info(
      'rag.intent.analyze_success',
      buildContext(baseContext, {
        durationMs: duration,
        entities: result.entities.map((entity) => ({
          name: entity.name,
          confidence: entity.confidence,
          type: entity.type,
          hints: entity.hints,
        })),
        needsFollowUps: result.needsFollowUps,
      }),
    );

    return {
      ...result,
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startedAt;
    if (error?.name === 'AbortError') {
      logger.warn('rag.intent.analyze_abort', buildContext(baseContext, { durationMs: duration }));
      throw error;
    }
    if (error?.message?.includes('timed out')) {
      logger.warn('rag.intent.analyze_timeout', buildContext(baseContext, { durationMs: duration }));
    } else {
      logger.error(
        'rag.intent.analyze_error',
        buildContext(baseContext, { durationMs: duration, err: error }),
      );
    }
    return {
      entities: [],
      needsFollowUps: false,
      duration,
      error: error?.message,
    };
  }
}

module.exports = {
  analyzeIntent,
};
