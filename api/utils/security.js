'use strict';

const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const FAST_STRING_SAFE_REGEX = /^[\t\r\n\x20-\x7E]+$/;
const FAST_STRING_MAX_LENGTH = 256;
const ARRAY_JOIN_CHAR_LIMIT = 50000;

/**
 * Базовая HTML-экранизация для внутренних промптов.
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  const replacements = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  return String(value).replace(/[&<>"']/g, (char) => replacements[char] || char);
}

function tryFastPath(value) {
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= FAST_STRING_MAX_LENGTH &&
    FAST_STRING_SAFE_REGEX.test(value)
  ) {
    return escapeHtml(value);
  }
  return null;
}

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  try {
    return value.normalize('NFC').replace(CONTROL_CHARS_REGEX, '');
  } catch (_) {
    return value.replace(CONTROL_CHARS_REGEX, '');
  }
}

function fromArray(items) {
  let total = 0;
  const chunks = [];

  for (let i = 0; i < items.length; i += 1) {
    let piece = items[i];

    if (piece == null) {
      continue;
    }
    if (typeof piece !== 'string') {
      piece = Buffer.isBuffer(piece) ? piece.toString('utf8') : String(piece);
    }

    const available = ARRAY_JOIN_CHAR_LIMIT - total;
    if (available <= 0) {
      chunks.push('[...]');
      break;
    }

    if (piece.length > available) {
      chunks.push(piece.slice(0, available));
      chunks.push('[...]');
      total = ARRAY_JOIN_CHAR_LIMIT;
      break;
    }

    chunks.push(piece);
    total += piece.length + 1; // учёт разделителя '\n'
  }

  return chunks.join('\n');
}

/**
 * Санитизирует входной текст: нормализует строку, удаляет управляющие символы
 * и экранирует HTML-спецсимволы.
 * @param {unknown} input
 * @returns {string}
 */
function sanitizeInput(input) {
  if (input == null) {
    return '';
  }

  if (typeof input === 'string') {
    const fast = tryFastPath(input);
    if (fast !== null) {
      return fast;
    }
    return escapeHtml(normalizeString(input));
  }

  if (Buffer.isBuffer(input)) {
    return escapeHtml(normalizeString(input.toString('utf8')));
  }

  if (Array.isArray(input)) {
    return escapeHtml(normalizeString(fromArray(input)));
  }

  if (typeof input === 'object') {
    try {
      return escapeHtml(normalizeString(JSON.stringify(input)));
    } catch (_) {
      return escapeHtml(normalizeString(String(input)));
    }
  }

  return escapeHtml(normalizeString(String(input)));
}

module.exports = {
  sanitizeInput,
};
