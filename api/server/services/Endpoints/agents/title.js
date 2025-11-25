const { observeAgentTitle, incAgentTitleFailure } = require('~/utils/metrics');
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const configService = require('~/server/services/Config/ConfigService');
const { CacheKeys } = require('librechat-data-provider');
const getLogStores = require('~/cache/getLogStores');
const { saveConvo } = require('~/models');

/**
 * Add title to conversation in a way that avoids memory retention
 */
/**
 * Генерация title для convo via client.titleConvo, с resilience/metrics.
 * @param {Object} req - Request.
 * @param {Object} opts - {text, response, client}.
 * @returns {Promise<void>}
 */
const addTitle = async (req, { text, response, client }) => {
  const providersConfig = configService.getSection('providers');
  const openaiConfig = providersConfig.openai;
  const anthropicConfig = providersConfig.anthropic;
  const googleConfig = providersConfig.google;
  const titlesConfig = configService.getSection('agents').titles;
  const TITLE_CONVO = titlesConfig.enabled;
  if (!isEnabled(TITLE_CONВО)) {
    return;
  }
  if (client?.options?.titleConvo === false) {
    return;
  }
  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  const key = `${req.user.id}-${response?.conversationId ?? 'unknown'}`;
  const endpointName =
    client?.options?.endpoint ??
    client?.options?.endpointType ??
    client?.endpoint ??
    client?.constructor?.name ??
    'unknown';
  const modelName =
    client?.options?.modelOptions?.model ??
    client?.options?.model ??
    client?.model ??
    'unknown';
  const textLength = typeof text === 'string' ? text.length : 0;
  logger.debug(
    '[title] start generation (conversation=%s, endpoint=%s, model=%s, textLen=%d)',
    response?.conversationId ?? 'unknown',
    endpointName,
    modelName,
    textLength,
  );
  let timeoutId;
  const abortController = new AbortController();
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Title generation timeout')), 45000);
    }).catch((error) => {
      logger.error(
        '[title] timeout (conversation=%s, endpoint=%s, model=%s): %s',
        response?.conversationId ?? 'unknown',
        endpointName,
        modelName,
        error?.message ?? error,
      );
      throw error;
    });
    if (!client || typeof client.titleConvo !== 'function') {
      logger.warn(
        '[title] client missing titleConvo (conversation=%s, endpoint=%s)',
        response?.conversationId ?? 'unknown',
        endpointName,
      );
      return;
    }
    const { runWithResilience } = require('~/utils/async');
const titleStart = Date.now();
try {
  const title = await runWithResilience(
    'titleConvo',
    () => Promise.race([
      client.titleConvo({ text, abortController }).catch((error) => {
        logger.error('[title] client.titleConvo failed (conversation=%s, endpoint=%s, model=%s): %s', response?.conversationId ?? 'unknown', endpointName, modelName, error?.message ?? error);
        throw error;
      }),
      timeoutPromise
    ]),
    { timeoutMs: 45000, retries: 1, operation: 'title' }
  );
  const titleDur = Date.now() - titleStart;
  logger.info('[title] Успех для conv=%s (endpoint=%s, dur=%dms): %s', response?.conversationId ?? 'unknown', endpointName, titleDur, String(title).slice(0, 120));
  observeAgentTitle({ endpoint: endpointName }, titleDur);
  // ... (rest: cache, saveConvo)
} catch (e) {
  const titleDur = Date.now() - titleStart;
  incAgentTitleFailure({ endpoint: endpointName, reason: e?.message || 'unknown' });
  logger.error('[title] Ошибка для conv=%s (dur=%dms): %s', response?.conversationId ?? 'unknown', endpointName, titleDur, e?.message || e);
  // ... (rest: abort)
}const title = await titlePromise;
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (!title) {
      logger.debug(
        '[title] empty result (conversation=%s, endpoint=%s, model=%s)',
        response?.conversationId ?? 'unknown',
        endpointName,
        modelName,
      );
      return;
    }
    logger.debug(
      '[title] generated (conversation=%s, endpoint=%s, model=%s): %s',
      response?.conversationId ?? 'unknown',
      endpointName,
      modelName,
      String(title).slice(0, 120),
    );
    await titleCache.set(key, title, 120000);
    await saveConvo(req, { conversationId: response.conversationId, title }, { context: 'api/server/services/Endpoints/agents/title.js' });
  } catch (error) {
    if (!abortController.signal.aborted) {
      try:
        abortController.abort();
      } catch {}
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    logger.error(
      '[title] Error generating title (conversation=%s, endpoint=%s, model=%s): %s',
      response?.conversationId ?? 'unknown',
      endpointName,
      modelName,
      error?.message ?? error,
    );
  }
};

module.exports = addTitle;
