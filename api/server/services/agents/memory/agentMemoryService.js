const { getBufferString, HumanMessage } = require('@langchain/core/messages');
const { checkAccess, createMemoryProcessor } = require('@librechat/api');
const {
  Constants,
  Permissions,
  ContentTypes,
  EModelEndpoint,
  PermissionTypes,
} = require('librechat-data-provider');
const { getRoleByName } = require('~/models/Role');
const { loadAgent } = require('~/models/Agent');
const { getFormattedMemories, deleteMemory, setMemory } = require('~/models');
const { initializeAgent } = require('~/server/services/Endpoints/agents/agent');

const DEFAULT_TIMEOUT_MS = 3000;

function removeImageContentFromMessage(message) {
  if (!message.content || typeof message.content === 'string') {
    return message;
  }

  if (Array.isArray(message.content)) {
    const filteredContent = message.content.filter(
      (part) => part.type !== ContentTypes.IMAGE_URL,
    );

    if (filteredContent.length === 1 && filteredContent[0].type === ContentTypes.TEXT) {
      const MessageClass = message.constructor;
      return new MessageClass({
        content: filteredContent[0].text,
        additional_kwargs: message.additional_kwargs,
      });
    }

    const MessageClass = message.constructor;
    return new MessageClass({
      content: filteredContent,
      additional_kwargs: message.additional_kwargs,
    });
  }

  return message;
}

async function awaitMemoryWithTimeout(memoryPromise, timeoutMs = DEFAULT_TIMEOUT_MS, logger) {
  if (!memoryPromise) {
    return;
  }

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Memory processing timeout')), timeoutMs),
    );

    return await Promise.race([memoryPromise, timeoutPromise]);
  } catch (error) {
    if (error.message === 'Memory processing timed out') {
      logger?.warn('[AgentClient] Memory processing timed out after 3 seconds');
    } else {
      logger?.error('[AgentClient] Error processing memory:', error);
    }
    return;
  }
}

async function useMemory({ req, res, agent, responseMessageId, conversationId, logger }) {
  const user = req.user;
  if (user.personalization?.memories === false) {
    return { withoutKeys: null, processMemory: null };
  }

  const hasAccess = await checkAccess({
    user,
    permissionType: PermissionTypes.MEMORIES,
    permissions: [Permissions.USE],
    getRoleByName,
  });

  if (!hasAccess) {
    logger?.debug(
      `[api/server/controllers/agents/client.js #useMemory] User ${user.id} does not have USE permission for memories`,
    );
    return { withoutKeys: null, processMemory: null };
  }

  const appConfig = req.config;
  const memoryConfig = appConfig.memory;
  if (!memoryConfig || memoryConfig.disabled === true) {
    return { withoutKeys: null, processMemory: null };
  }

  let prelimAgent;
  const allowedProviders = new Set(appConfig?.endpoints?.[EModelEndpoint.agents]?.allowedProviders);
  try {
    if (memoryConfig.agent?.id != null && memoryConfig.agent.id !== agent.id) {
      prelimAgent = await loadAgent({
        req,
        agent_id: memoryConfig.agent.id,
        endpoint: EModelEndpoint.agents,
      });
    } else if (
      memoryConfig.agent?.id == null &&
      memoryConfig.agent?.model != null &&
      memoryConfig.agent?.provider != null
    ) {
      prelimAgent = { id: Constants.EPHEMERAL_AGENT_ID, ...memoryConfig.agent };
    }
  } catch (error) {
    logger?.error('[api/server/controllers/agents/client.js #useMemory] Error loading agent for memory', error);
  }

  const memoryAgent = await initializeAgent({
    req,
    res,
    agent: prelimAgent,
    allowedProviders,
    endpointOption: {
      endpoint:
        prelimAgent?.id !== Constants.EPHEMERAL_AGENT_ID
          ? EModelEndpoint.agents
          : memoryConfig.agent?.provider,
    },
  });

  if (!memoryAgent) {
    logger?.warn(
      '[api/server/controllers/agents/client.js #useMemory] No agent found for memory',
      memoryConfig,
    );
    return { withoutKeys: null, processMemory: null };
  }

  const llmConfig = Object.assign(
    {
      provider: memoryAgent.provider,
      model: memoryAgent.model,
    },
    memoryAgent.model_parameters,
  );

  const config = {
    validKeys: memoryConfig.validKeys,
    instructions: memoryAgent.instructions,
    llmConfig,
    tokenLimit: memoryConfig.tokenLimit,
  };

  const userId = `${req.user.id}`;
  const messageId = `${responseMessageId}`;
  const convoId = `${conversationId}`;
  const [withoutKeys, processMemory] = await createMemoryProcessor({
    userId,
    config,
    messageId,
    conversationId: convoId,
    memoryMethods: {
      setMemory,
      deleteMemory,
      getFormattedMemories,
    },
    res,
  });

  return { withoutKeys, processMemory };
}

async function enrichContextWithMemoryAgent({ messages, processMemory, req, logger }) {
  try {
    if (processMemory == null) {
      return;
    }
    const appConfig = req.config;
    const memoryConfig = appConfig.memory;
    const messageWindowSize = memoryConfig?.messageWindowSize ?? 5;

    let messagesToProcess = [...messages];
    if (messages.length > messageWindowSize) {
      for (let i = messages.length - messageWindowSize; i >= 0; i--) {
        const potentialWindow = messages.slice(i, i + messageWindowSize);
        if (potentialWindow[0]?.role === 'user') {
          messagesToProcess = [...potentialWindow];
          break;
        }
      }

      if (messagesToProcess.length === messages.length) {
        messagesToProcess = [...messages.slice(-messageWindowSize)];
      }
    }

    const filteredMessages = messagesToProcess.map((msg) => removeImageContentFromMessage(msg));
    const bufferString = getBufferString(filteredMessages);
    const bufferMessage = new HumanMessage(`# Current Chat:\n\n${bufferString}`);
    return await processMemory([bufferMessage]);
  } catch (error) {
    logger?.error('Memory Agent failed to process memory', error);
  }
}

function createAgentMemoryService() {
  return Object.freeze({
    awaitMemoryWithTimeout,
    useMemory,
    enrichContextWithMemoryAgent,
  });
}

module.exports = { createAgentMemoryService };
