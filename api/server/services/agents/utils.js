const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { getLogger } = require('~/utils/logger');

const logger = getLogger('agents.utils');

/**
 * Detects if error is context overflow (400 with token limit message).
 * @param {unknown} error
 * @returns {boolean}
 */
function detectContextOverflow(error) {
  if (!error) {
    return false;
  }

  const status = error?.status || error?.response?.status || error?.code;
  if (status !== 400 && status !== '400') {
    return false;
  }

  const message = error?.message || error?.response?.data?.message || '';
  const lowerMessage = String(message).toLowerCase();

  return (
    lowerMessage.includes('context length') ||
    lowerMessage.includes('maximum context') ||
    (lowerMessage.includes('token') &&
      (lowerMessage.includes('exceed') || lowerMessage.includes('limit')))
  );
}

/**
 * Aggressively compresses messages for retry after context overflow.
 * @param {Array} messages
 * @param {number} targetReduction
 * @returns {Array}
 */
function compressMessagesForRetry(messages, targetReduction = 0.5) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const compressed = [];
  const keepSystemMessage = messages.find((m) => m._getType && m._getType() === 'system');

  if (keepSystemMessage) {
    const systemContent =
      typeof keepSystemMessage.content === 'string'
        ? keepSystemMessage.content
        : JSON.stringify(keepSystemMessage.content);

    const maxSystemLength = Math.floor(systemContent.length * (1 - targetReduction));
    const truncatedSystem = systemContent.slice(0, maxSystemLength);

    compressed.push(
      new SystemMessage({
        content: `${truncatedSystem}\n[...system message truncated due to context limit...]`,
      }),
    );
  }

  const nonSystemMessages = messages.filter((m) => !m._getType || m._getType() !== 'system');
  const keepCount = Math.max(3, Math.floor(nonSystemMessages.length * (1 - targetReduction)));
  const recentMessages = nonSystemMessages.slice(-keepCount);
  const lastHumanEntry = [...recentMessages]
    .map((msg, index) => ({ msg, index }))
    .reverse()
    .find((entry) => (entry.msg?._getType?.() || entry.msg?.role) === 'human');
  if (lastHumanEntry) {
    logger.debug('[context.retry.lock_last_human]', {
      keepCount,
      targetReduction,
      messageIndex: lastHumanEntry.index,
    });
  }
  const lastHumanIndex = recentMessages
    .map((msg, index) => ({ msg, index }))
    .reverse()
    .find((entry) => (entry.msg?._getType?.() || entry.msg?.role) === 'human');
  if (lastHumanIndex) {
    const msg = lastHumanIndex.msg;
    const rawText = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
        : '';
    logger.debug('[context.retry.pre_last_human]', {
      keepCount,
      targetReduction,
      messageIndex: lastHumanIndex.index,
      rawLength: rawText.length,
    });
  }

  for (const msg of recentMessages) {
    const messageType = msg._getType ? msg._getType() : 'unknown';
    let content = msg.content;
    const isLastHuman = lastHumanEntry && msg === lastHumanEntry.msg;

    if (!isLastHuman && typeof content === 'string') {
      const maxLength = Math.floor(content.length * (1 - targetReduction));
      if (content.length > maxLength) {
        content = `${content.slice(0, maxLength)}\n[...truncated...]`;
      }
    } else if (!isLastHuman && Array.isArray(content)) {
      content = content
        .filter((part) => part.type === 'text')
        .map((part) => {
          const text = part.text || '';
          const maxLength = Math.floor(text.length * (1 - targetReduction));
          return {
            type: 'text',
            text: text.length > maxLength ? `${text.slice(0, maxLength)}\n[...truncated...]` : text,
          };
        });
    }

    if (messageType === 'human') {
      compressed.push(new HumanMessage({ content }));
    } else {
      compressed.push(msg.constructor ? new msg.constructor({ content }) : { ...msg, content });
    }
  }

  const compressedLastHuman = compressed
    .map((msg, index) => ({ msg, index }))
    .reverse()
    .find((entry) => (entry.msg?._getType?.() || entry.msg?.role) === 'human');
  if (compressedLastHuman) {
    const msg = compressedLastHuman.msg;
    const rawText = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
        : '';
    logger.debug('[context.retry.post_last_human]', {
      messageIndex: compressedLastHuman.index,
      rawLength: rawText.length,
    });
  }

  return compressed;
}

/**
 * Extracts dates from text in DD.MM.YYYY or YYYY-MM-DD format.
 * Returns array of ISO date strings (YYYY-MM-DD).
 * @param {string} text
 * @returns {string[]}
 */
function extractDates(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const ddmmyyyy = /\b(\d{2})\.(\d{2})\.(\d{4})\b/g;
  const yyyymmdd = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  const results = new Set();

  let match;
  while ((match = ddmmyyyy.exec(text)) !== null) {
    results.add(`${match[3]}-${match[2]}-${match[1]}`);
  }
  while ((match = yyyymmdd.exec(text)) !== null) {
    results.add(`${match[1]}-${match[2]}-${match[3]}`);
  }

  return Array.from(results);
}

module.exports = {
  detectContextOverflow,
  compressMessagesForRetry,
  extractDates,
};
