'use strict';

const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');
const { withTimeout, createAbortError } = require('~/utils/async');

const DEFAULT_TIMEOUT_MS = 2000;
const MIN_CONFIDENCE = 0.35;
const logger = getLogger('rag.intentAnalyzer');
const ENTITY_REGEX = /\b([A-ZА-ЯЁ][a-zа-яё]+(?:\s+[A-ZА-ЯЁ][a-zа-яё]+)*)\b/g;
const TOKEN_REGEX = /[A-Za-zА-Яа-яЁё]{3,}/g;
const STOPWORDS = new Set([
  'это', 'как', 'что', 'когда', 'где', 'почему', 'зачем', 'который', 'которая', 'которые',
  'вот', 'все', 'всё', 'его', 'ее', 'её', 'для', 'при', 'без', 'над', 'под', 'про', 'после',
  'или', 'а', 'но', 'и', 'или', 'ли', 'не', 'да', 'нет', 'ты', 'вы', 'мы', 'они', 'он', 'она',
  'оно', 'этот', 'эта', 'эти', 'там', 'тут', 'ещё', 'уже', 'очень', 'просто', 'тоже', 'если',
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'these', 'those', 'who', 'what', 'when',
  'where', 'why', 'how', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'at', 'by', 'as',
]);
const RELATION_HINT_REGEX = /(между|связ(ь|и)|отношени[яе]|контакт[ы]?)/i;
const ACK_REGEX = /^(ok|okay|ack|принято|ага|понял|да|✅|👌)/i;
function normalizeText({ message, context }) {
  const toText = (entry) => {
    if (!entry) return '';
    if (typeof entry === 'string') return entry;
    if (typeof entry?.text === 'string') return entry.text;
    if (Array.isArray(entry?.content)) {
      return entry.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    }
    return '';
  };

  const messageText = toText(message).trim();
  const cleanedMessage = ACK_REGEX.test(messageText)
    ? messageText.replace(ACK_REGEX, '').trim()
    : messageText;

  const contextText = Array.isArray(context)
    ? context.map((entry) => toText(entry)).filter(Boolean).join('\n')
    : typeof context === 'string'
      ? context
      : '';

  return {
    messageText: cleanedMessage,
    contextText,
  };
}

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

  if (matches.size === 0) {
    const tokenMatches = text.match(TOKEN_REGEX) || [];
    for (const token of tokenMatches) {
      const normalized = token.toLowerCase();
      if (STOPWORDS.has(normalized)) {
        continue;
      }
      const prev = matches.get(normalized) || { count: 0, name: token };
      matches.set(normalized, { count: prev.count + 1, name: token });
    }
  }

  return Array.from(matches.values()).map(({ count, name }) => ({
    name,
    type: /(inc|corp|llc|gmbh|АО|ООО|ЗАО|ИП|банк)/i.test(name)
      ? 'organization'
      : 'keyword',
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

  const { messageText: text, contextText } = normalizeText({ message, context });

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
