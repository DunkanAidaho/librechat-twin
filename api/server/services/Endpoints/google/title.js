const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const configService = require('~/server/services/Config/ConfigService');
const { EModelEndpoint, CacheKeys, Constants, googleSettings } = require('librechat-data-provider');
const getLogStores = require('~/cache/getLogStores');
const initializeClient = require('./initialize');
const { saveConvo } = require('~/models');

const addTitle = async (req, { text, response, client }) => {
  const titlesConfig = configService.getSection('agents').titles;
  const providersConfig = configService.getSection('providers');
  const googleProviderConfig = providersConfig.google;
  const TITLE_CONВО = titlesConfig.enabled ? 'true' : 'false';
  if (!isEnabled(TITLE_CONВО)) {
    return;
  }
  if (client?.options?.titleConvo === false) {
    return;
  }
  const GOOGLE_TITLE_MODEL = googleProviderConfig.titleModel;
  const appConfig = req.config;
  const providerConfig = appConfig.endpoints?.[EModelEndpoint.google];
  let model =
    providerConfig?.titleModel ??
    GOOGLE_TITLE_MODEL ??
    client?.options?.modelOptions?.model ??
    googleSettings.model.default;
  if (GOOGLE_TITLE_MODEL === Constants.CURRENT_MODEL) {
    model = client?.options?.modelOptions?.model;
  }
  const inputLength = typeof text === 'string' ? text.length : 0;
  logger.debug(
    '[title][google] start (conversation=%s, resolvedModel=%s, textLen=%d)',
    response?.conversationId ?? 'unknown',
    model,
    inputLength,
  );
  const titleEndpointOptions = {
    ...client?.options,
    modelOptions: { ...client?.options?.modelOptions, model },
    attachments: undefined,
  };
  let initResult;
  try {
    initResult = await initializeClient({ req, res: response, endpointOption: titleEndpointOptions });
  } catch (error) {
    logger.error(
      '[title][google] initializeClient failed (conversation=%s, model=%s): %s',
      response?.conversationId ?? 'unknown',
      model,
      error?.message ?? error,
    );
    return;
  }
  const titleClient = initResult?.client;
  if (!titleClient || typeof titleClient.titleConvo !== 'function') {
    logger.warn(
      '[title][google] titleClient missing titleConvo (conversation=%s, model=%s)',
      response?.conversationId ?? 'unknown',
      model,
    );
    return;
  }
  let title;
  try {
    title = await titleClient.titleConvo({
      text,
      responseText: response?.text ?? '',
      conversationId: response.conversationId,
    });
  } catch (error) {
    logger.error(
      '[title][google] titleConvo failed (conversation=%s, model=%s): %s',
      response?.conversationId ?? 'unknown',
      model,
      error?.message ?? error,
    );
    return;
  }
  if (!title) {
    logger.debug(
      '[title][google] empty result (conversation=%s, model=%s)',
      response?.conversationId ?? 'unknown',
      model,
    );
    return;
  }
  logger.debug(
    '[title][google] generated (conversation=%s, model=%s): %s',
    response?.conversationId ?? 'unknown',
    model,
    String(title).slice(0, 120),
  );
  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  const key = `${req.user.id}-${response.conversationId}`;
  await titleCache.set(key, title, 120000);
  await saveConvo(
    req,
    { conversationId: response.conversationId, title },
    { context: 'api/server/services/Endpoints/google/addTitle.js' },
  );
};

module.exports = addTitle;
