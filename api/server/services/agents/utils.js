const { HumanMessage, SystemMessage } = require('@langchain/core/messages');

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

  for (const msg of recentMessages) {
    const messageType = msg._getType ? msg._getType() : 'unknown';
    let content = msg.content;

    if (typeof content === 'string') {
      const maxLength = Math.floor(content.length * (1 - targetReduction));
      if (content.length > maxLength) {
        content = `${content.slice(0, maxLength)}\n[...truncated...]`;
      }
    } else if (Array.isArray(content)) {
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

  return compressed;
}

module.exports = {
  detectContextOverflow,
  compressMessagesForRetry,
};
