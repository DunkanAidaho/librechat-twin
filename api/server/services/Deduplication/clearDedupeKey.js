'use strict';

const { logger } = require('@librechat/data-schemas');
const { publish: publishNats, isEnabled: isNatsEnabled } = require('~/utils/natsClient');
const ingestDeduplicator = require('./ingestDeduplicator');

const DEDUPE_CLEAR_SUBJECT = 'tasks.clear';

function canPublish() {
  return Boolean(isNatsEnabled?.()) && Boolean(publishNats);
}

async function publishClearRequest(key) {
  if (!canPublish()) {
    logger.debug(
      `[clearDedupeKey] JetStream недоступен — пропускаем публикацию clearIngestedMark для ${key}`,
    );
    return;
  }

  try {
    await publishNats(DEDUPE_CLEAR_SUBJECT, { action: 'clearIngestedMark', key });
  } catch (error) {
    logger.debug(
      `[clearDedupeKey] Не удалось опубликовать clearIngestedMark для ${key}: ${error?.message || error}`,
    );
  }
}

async function clearDedupeKey(key, logPrefix = '[clearDedupeKey]') {
  if (!key) {
    return;
  }

  await publishClearRequest(key);

  try {
    await ingestDeduplicator.clearIngestedMark(key);
  } catch (error) {
    logger.warn(`${logPrefix} Не удалось очистить дедуп-ключ ${key}: ${error?.message || error}`);
  }
}

module.exports = {
  clearDedupeKey,
};