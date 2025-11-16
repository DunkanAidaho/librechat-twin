'use strict';

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

  let stringified = '';

  if (typeof input === 'string') {
    stringified = input;
  } else if (Buffer.isBuffer(input)) {
    stringified = input.toString('utf8');
  } else if (Array.isArray(input)) {
    stringified = input.join('\n');
  } else if (typeof input === 'object') {
    try {
      stringified = JSON.stringify(input);
    } catch (_) {
      stringified = String(input);
    }
  } else {
    stringified = String(input);
  }

  const normalized = stringified.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return escapeHtml(normalized);
}

module.exports = {
  sanitizeInput,
};
