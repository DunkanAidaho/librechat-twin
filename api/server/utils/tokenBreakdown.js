'use strict';const { encode } = require('gpt-tokenizer');

const DEFAULT_LOG_LEVEL = 'info';const TOKENIZATION_DETAIL_LEVELS = new Set(['basic', 'detailed', 'full']);const DEFAULT_PREVIEW_CHAR_LIMIT = 256;

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const normalizeMessages = (messages = []) => {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.map((message, index) => ({
    messageId: message?.messageId || `message-${index + 1}`,
    tokens: toNumber(message?.tokens),
    isRagContext: Boolean(message?.isRagContext)
  }));
}; /**
 * Анализирует структуру запроса и возвращает детализированную информацию о токенах.
 * @param {object} [request={}] Объект запроса (system, messages).
 * @param {object} [options={}] Настройки детализации и включаемых компонентов.
 * @returns {object} Структура с подсчитанными токенами и превью.
 */const analyzeTokenization = (request = {}, options = {}) => {const { detailLevel: requestedDetailLevel, includePrompt = false, includeMessages = false, maxPreviewChars = DEFAULT_PREVIEW_CHAR_LIMIT } = options;const normalizedLevel = typeof requestedDetailLevel === 'string' ? requestedDetailLevel.trim().toLowerCase() : '';const detailLevel = TOKENIZATION_DETAIL_LEVELS.has(normalizedLevel) ? normalizedLevel : 'basic';const includePromptFlag = Boolean(includePrompt);const includeMessagesFlag = Boolean(includeMessages);const result = { total: 0, detailLevel, includePrompt: includePromptFlag, includeMessages: includeMessagesFlag, components: {} };if (!includePromptFlag && !includeMessagesFlag) {return result;}const source = request && typeof request === 'object' ? request : {};const errors = [];const toText = (content) => {if (typeof content === 'string') {return content;}if (Array.isArray(content)) {return content.map((part) => {if (typeof part === 'string') {return part;}if (part && typeof part === 'object') {if (typeof part.text === 'string') {return part.text;}if (typeof part.content === 'string') {return part.content;}}return '';}).filter(Boolean).join(' ');}if (content && typeof content === 'object') {if (typeof content.text === 'string') {return content.text;}if (typeof content.content === 'string') {return content.content;}}return '';};const countTokens = (text, contextLabel) => {if (!text) {return 0;}try {const tokens = encode(text);return Array.isArray(tokens) ? tokens.length : 0;} catch (error) {errors.push({ context: contextLabel, message: error.message });return 0;}};const applyPreview = (target, text) => {if (detailLevel === 'basic') {return;}target.length = text.length;if (detailLevel === 'full') {target.text = text;return;}target.preview = text.length > maxPreviewChars ? text.slice(0, maxPreviewChars) : text;};if (includePromptFlag) {const systemText = toText(source.system);const systemInfo = { tokens: countTokens(systemText, 'system') };if (systemText) {applyPreview(systemInfo, systemText);}result.components.system = systemInfo;result.total += systemInfo.tokens;}if (includeMessagesFlag && Array.isArray(source.messages)) {let messagesTotal = 0;const messages = source.messages.map((message, index) => {const role = typeof message?.role === 'string' ? message.role : 'unknown';const text = toText(message?.content);const tokens = countTokens(text, 'message_' + index);const entry = { index, role, tokens };if (typeof message?.name === 'string') {entry.name = message.name;}if (text) {applyPreview(entry, text);}messagesTotal += tokens;return entry;});result.components.messages = messages;result.total += messagesTotal;}if (errors.length > 0) {result.errors = errors;}return result;};const computePromptTokenBreakdown = ({ conversationId, promptTokens = 0, instructionsTokens = 0,
  ragGraphTokens = 0,
  ragVectorTokens = 0,
  messages = [],
  cache = {},
  reasoningTokens = 0
} = {}) => {
  const normalizedMessages = normalizeMessages(messages);
  const messageTokens = normalizedMessages.reduce(
    (sum, message) => sum + message.tokens,
    0
  );
  const cacheRead = toNumber(cache?.read);
  const cacheWrite = toNumber(cache?.write);
  const reasoning = toNumber(reasoningTokens);

  const promptComponentsSum =
  toNumber(instructionsTokens) +
  toNumber(ragGraphTokens) +
  toNumber(ragVectorTokens) +
  messageTokens +
  cacheRead +
  cacheWrite;

  const residualTokens = Math.max(0, toNumber(promptTokens) - promptComponentsSum);

  return {
    conversationId: conversationId ?? 'unknown',
    promptTokens: toNumber(promptTokens),
    instructionsTokens: toNumber(instructionsTokens),
    ragGraphTokens: toNumber(ragGraphTokens),
    ragVectorTokens: toNumber(ragVectorTokens),
    messageTokens,
    cache: {
      read: cacheRead,
      write: cacheWrite
    },
    reasoningTokens: reasoning,
    residualTokens,
    messages: normalizedMessages,
    timestamp: new Date().toISOString()
  };
};

const buildSumLine = (breakdown) => {
  const parts = [
  `INSTR(${breakdown.instructionsTokens})`,
  `RAG_GRAPH(${breakdown.ragGraphTokens})`,
  `RAG_VECTOR(${breakdown.ragVectorTokens})`,
  `MESSAGES(${breakdown.messageTokens})`,
  `CACHE_READ(${breakdown.cache.read})`,
  `CACHE_WRITE(${breakdown.cache.write})`,
  `RESIDUAL(${breakdown.residualTokens})`];

  return `PROMPT(${breakdown.promptTokens}) = ${parts.join(' + ')} | REASONING(${breakdown.reasoningTokens})`;
};

const logPromptTokenBreakdown = (logger, breakdown, level = DEFAULT_LOG_LEVEL) => {
  if (!logger) {
    return;
  }

  const logLevel = typeof logger[level] === 'function' ? level : DEFAULT_LOG_LEVEL;
  logger[logLevel]('[tokenBreakdown]', breakdown);
  logger[logLevel]('[tokenBreakdown:sum]', buildSumLine(breakdown));
};

module.exports = {
  computePromptTokenBreakdown,
  logPromptTokenBreakdown, analyzeTokenization
};