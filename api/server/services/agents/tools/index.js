const { createContextHandlers } = require('~/app/clients/prompts');
const { logAxiosError } = require('@librechat/api');

function createAgentToolsService({ logger } = {}) {
  const logToolError = (graph, error, toolId) => {
    logAxiosError({
      error,
      message: `[api/server/services/agents/tools] Tool Error "${toolId}"`,
    });

    if (logger?.error) {
      logger.error('[agents.tools.error]', {
        toolId,
        message: error?.message,
        stack: error?.stack,
      });
    }
  };

  const createPromptContextHandlers = (req, latestUserText) =>
    createContextHandlers(req, latestUserText);

  const buildToolSystemMessage = (toolContextMap) =>
    Object.values(toolContextMap ?? {})
      .join('\n')
      .trim();

  return Object.freeze({
    logToolError,
    createPromptContextHandlers,
    buildToolSystemMessage,
  });
}

module.exports = {
  createAgentToolsService,
};
