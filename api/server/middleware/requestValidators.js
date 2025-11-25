'use strict';

const { logger } = require('@librechat/data-schemas');
const configService = require('~/server/services/Config/ConfigService');

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 * @typedef {import('express').NextFunction} NextFunction
 */

/**
 * Возвращает числовое значение переменной окружения или запасной вариант.
 *
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
const getNumericEnv = (name, fallback) => {
  const value = Number.parseInt(configService.get(`limits.request.${name}`) ?? '', 10);
  if (Number.isNaN(value) || value <= 0) {
    return fallback;
  }
  return value;
};

const MAX_REQUEST_TEXT_LENGTH = getNumericEnv('MAX_REQUEST_TEXT_LENGTH', 40000);
const MAX_REQUEST_FILES_COUNT = getNumericEnv('MAX_REQUEST_FILES_COUNT', 5);
const MAX_REQUEST_FILE_SIZE_MB = getNumericEnv('MAX_REQUEST_FILE_SIZE_MB', 25);
const MAX_REQUEST_TOTAL_FILES_SIZE_MB = getNumericEnv('MAX_REQUEST_TOTAL_FILES_SIZE_MB', 75);

const MAX_REQUEST_FILE_SIZE_BYTES = MAX_REQUEST_FILE_SIZE_MB * 1024 * 1024;
const MAX_REQUEST_TOTAL_FILES_SIZE_BYTES = MAX_REQUEST_TOTAL_FILES_SIZE_MB * 1024 * 1024;

const OPTIONAL_IDENTIFIER_FIELDS = new Set([
  'conversationId',
  'parentMessageId',
  'overrideParentMessageId',
  'responseMessageId',
  'overrideConvoId',
  'overrideUserMessageId',
]);

/**
 * @param {*} value
 * @returns {boolean}
 */
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * @param {*} value
 * @returns {boolean}
 */
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Возвращает известный размер файла в байтах.
 *
 * @param {object} file
 * @param {number} [defaultSize=0]
 * @returns {number}
 */
const getFileSize = (file, defaultSize = 0) => {
  if (file == null || typeof file !== 'object') {
    return defaultSize;
  }
  if (typeof file.size === 'number' && !Number.isNaN(file.size)) {
    return file.size;
  }
  if (typeof file.file_size === 'number' && !Number.isNaN(file.file_size)) {
    return file.file_size;
  }
  if (
    file.metadata &&
    typeof file.metadata === 'object' &&
    typeof file.metadata.size === 'number' &&
    !Number.isNaN(file.metadata.size)
  ) {
    return file.metadata.size;
  }
  return defaultSize;
};

/**
 * @param {string[]} issues
 * @param {string} message
 */
const appendIssue = (issues, message) => {
  issues.push(String(message));
};

/**
 * @param {object} endpointOption
 * @param {string[]} issues
 */
const validateEndpointOption = (endpointOption, issues) => {
  if (!isPlainObject(endpointOption)) {
    appendIssue(issues, 'Поле endpointOption должно быть объектом.');
    return;
  }

  if ('endpoint' in endpointOption && !isNonEmptyString(endpointOption.endpoint)) {
    appendIssue(issues, 'Поле endpointOption.endpoint должно быть непустой строкой.');
  }

  if (
    'model_parameters' in endpointOption &&
    !isPlainObject(endpointOption.model_parameters)
  ) {
    appendIssue(issues, 'Поле endpointOption.model_parameters должно быть объектом.');
  }
};

/**
 * @param {object} body
 * @param {string[]} issues
 */
const validateIdentifiers = (body, issues) => {
  for (const field of OPTIONAL_IDENTIFIER_FIELDS) {
    if (!(field in body)) {
      continue;
    }

    const value = body[field];
    if (value == null) {
      continue;
    }

    if (!isNonEmptyString(value)) {
      appendIssue(
        issues,
        `Поле ${field} должно быть непустой строкой, если передано.`,
      );
    }
  }
};

/**
 * Валидация входящего запроса для контроллера агентов.
 *
 * @param {Request} req
 * @param {Response} res
 * @param {NextFunction} next
 * @returns {void}
 */
function validateAgentRequest(req, res, next) {
  const issues = [];
  const body = req.body ?? {};

  const { text, files, endpointOption, isRegenerate, editedContent, responseMessageId } = body;

  const hasText = typeof text === 'string' && text.length > 0;
  const hasFiles = Array.isArray(files) && files.length > 0;

  if (!hasText && !hasFiles) {
    appendIssue(issues, 'Необходимо указать текст запроса или приложить файлы.');
  }

  if (hasText && text.length > MAX_REQUEST_TEXT_LENGTH) {
    appendIssue(
      issues,
      `Превышен допустимый размер текста (${text.length} > ${MAX_REQUEST_TEXT_LENGTH} символов).`,
    );
  }

  if (files !== undefined && !Array.isArray(files)) {
    appendIssue(issues, 'Поле files должно быть массивом, если передано.');
  }

  if (Array.isArray(files)) {
    if (files.length > MAX_REQUEST_FILES_COUNT) {
      appendIssue(
        issues,
        `Превышено количество файлов (${files.length} > ${MAX_REQUEST_FILES_COUNT}).`,
      );
    }

    let totalSize = 0;
    files.forEach((file, index) => {
      const size = getFileSize(file, 0);
      totalSize += size;

      if (size > MAX_REQUEST_FILE_SIZE_BYTES) {
        appendIssue(
          issues,
          `Файл №${index + 1} превышает допустимый размер (${(
            size / (1024 * 1024)
          ).toFixed(2)} МБ > ${MAX_REQUEST_FILE_SIZE_MB} МБ).`,
        );
      }
    });

    if (totalSize > MAX_REQUEST_TOTAL_FILES_SIZE_BYTES) {
      appendIssue(
        issues,
        `Суммарный размер файлов превышает лимит (${(
          totalSize / (1024 * 1024)
        ).toFixed(2)} МБ > ${MAX_REQUEST_TOTAL_FILES_SIZE_MB} МБ).`,
      );
    }
  }

  if (endpointOption !== undefined) {
    validateEndpointOption(endpointOption, issues);
  }

  if (isRegenerate && editedContent) {
    appendIssue(
      issues,
      'Флаги isRegenerate и editedContent не могут использоваться одновременно.',
    );
  }

  if (editedContent && !responseMessageId) {
    appendIssue(
      issues,
      'Для editedContent требуется указать responseMessageId.',
    );
  }

  validateIdentifiers(body, issues);

  if (issues.length > 0) {
    logger.warn('[validateAgentRequest] Валидация отклонена: %o', issues);
    return res.status(400).json({
      error: 'Некорректный запрос.',
      details: issues,
    });
  }

  next();
}

module.exports = {
  validateAgentRequest,
};
