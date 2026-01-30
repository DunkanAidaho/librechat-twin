const { logger } = require('@librechat/data-schemas');
const crypto = require('crypto');

/**
 * Extracts text content from a message object
 * @param {Object|null|undefined} message
 * @param {string} logPrefix
 * @param {{silent?: boolean}} options
 * @returns {string}
 */
function extractMessageText(message, logPrefix = '[MessageUtils]', options = {}) {
  const { silent = false } = options ?? {};
  const warn = (...args) => {
    if (!silent && logger?.warn) {
      logger.warn(...args);
    }
  };

  if (!message) {
    warn(`${logPrefix} extractMessageText received null/undefined message`);
    return '';
  }

  if (typeof message.text === 'string') {
    const trimmedText = message.text.trim();
    if (trimmedText.length > 0) {
      return message.text;
    }
  }

  if (typeof message.content === 'string') {
    const trimmedContent = message.content.trim();
    if (trimmedContent.length > 0) {
      return message.content;
    }
  }

  if (message.content && typeof message.content === 'object' && !Array.isArray(message.content)) {
    warn(`${logPrefix} message.content is an object, not string/array. Returning empty string.`);
    return '';
  }

  if (Array.isArray(message.content)) {
    return message.content
      .filter(
        (part) => part && part.type === 'text' && part.text != null && typeof part.text === 'string',
      )
      .map((part) => part.text)
      .join('\n');
  }

  return '';
}

/**
 * Normalizes and cleans memory text for RAG processing
 * @param {string|null|undefined} text
 * @param {string} logPrefix
 * @returns {string}
 */
function normalizeMemoryText(text, logPrefix = '[MessageUtils]') {
  if (text == null) {
    return '';
  }
  if (typeof text !== 'string') {
    if (logger?.warn) {
      logger.warn(`${logPrefix} Expected string for normalization, got: ${typeof text}`);
    }
    return '';
  }

  let normalized = text;
  try {
    normalized = text.normalize('NFC');
  } catch (error) {
    if (logger?.warn) {
      logger.warn(`${logPrefix} Failed to normalize text`, { message: error?.message });
    }
  }

  const cleaned = normalized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return cleaned.trim();
}

/**
 * Generates a unique ingest key for deduplication in RAG
 * @param {string} convId
 * @param {string|null} msgId
 * @param {string} raw
 * @returns {string}
 */
function makeIngestKey(convId, msgId, raw) {
  if (msgId) return `ing:${convId}:${msgId}`;
  const hash = crypto.createHash('md5').update(String(raw || '')).digest('hex');
  return `ing:${convId}:${hash}`;
}

/**
 * Condenses RAG query text by deduplicating and truncating
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function condenseRagQuery(text, limit = 6000) {
  if (!text) {
    return '';
  }

  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  if (!normalized) {
    return '';
  }

  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const deduped = [];
  const seen = new Set();
  for (const line of lines) {
    if (!seen.has(line)) {
      deduped.push(line);
      seen.add(line);
    }
  }

  let condensed = deduped.join('\n').trim();
  if (condensed.length <= limit) {
    return condensed;
  }

  const half = Math.max(1, Math.floor(limit / 2));
  const head = condensed.slice(0, half);
  const tail = condensed.slice(-half);
  return `${head}\n...\n${tail}`;
}

module.exports = {
  extractMessageText,
  normalizeMemoryText,
  makeIngestKey,
  condenseRagQuery,
};
