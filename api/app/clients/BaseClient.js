const crypto = require('crypto');
const fetch = require('node-fetch');
const { logger } = require('@librechat/data-schemas');
const { getBalanceConfig, Tokenizer, TextStream } = require('@librechat/api');
const configService = require('~/server/services/Config/ConfigService');
const {
  supportsBalanceCheck,
  isAgentsEndpoint,
  isParamEndpoint,
  EModelEndpoint,
  ContentTypes,
  excludedKeys,
  ErrorTypes,
  Constants,
} = require('librechat-data-provider');
const { getMessages, saveMessage, updateMessage, saveConvo, getConvo } = require('~/models');
const { checkBalance } = require('~/models/balanceMethods');
const { truncateToolCallOutputs } = require('./prompts');
const { getFiles } = require('~/models/File');
const { retryAsync, withTimeout } = require('../../utils/async');
const baseClientConfig = configService.getSection('clients').base;
const historyConfig = configService.get('memory.history', {});
const DEFAULT_CLIENT_TIMEOUT_MS = baseClientConfig.timeoutMs;
const DEFAULT_CLIENT_RETRY_COUNT = baseClientConfig.retryCount;
const DEFAULT_CLIENT_RETRY_MIN_DELAY_MS = baseClientConfig.retryMinDelayMs;
const DEFAULT_CLIENT_RETRY_MAX_DELAY_MS = baseClientConfig.retryMaxDelayMs;
const DEFAULT_CLIENT_RETRY_FACTOR = baseClientConfig.retryFactor;
const DEFAULT_CLIENT_RETRY_JITTER = baseClientConfig.retryJitter;

/**
 * Возвращает положительное целочисленное значение, либо значение по умолчанию.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

class BaseClient {
  static _historyBudgetLogged = false;
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.sender = options.sender ?? 'AI';
    this.contextStrategy = null;
    this.currentDateString = new Date().toLocaleDateString('en-us', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    /** @type {boolean} */
    this.skipSaveConvo = false;
    /** @type {boolean} */
    this.skipSaveUserMessage = false;
    /** @type {string} */
    this.user;
    /** @type {string} */
    this.conversationId;
    /** @type {string} */
    this.responseMessageId;
    /** @type {string} */
    this.parentMessageId;
    /** @type {TAttachment[]} */
    this.attachments;
    /** The key for the usage object's input tokens
     * @type {string} */
    this.inputTokensKey = 'prompt_tokens';
    /** The key for the usage object's output tokens
     * @type {string} */
    this.outputTokensKey = 'completion_tokens';
    /** @type {Set<string>} */
    this.savedMessageIds = new Set();
    /**
     * Flag to determine if the client re-submitted the latest assistant message.
     * @type {boolean | undefined} */
    this.continued;
    /**
     * Flag to determine if the client has already fetched the conversation while saving new messages.
     * @type {boolean | undefined} */
    this.fetchedConvo;
    /** @type {TMessage[]} */
    this.currentMessages = [];
    /** @type {import('librechat-data-provider').VisionModes | undefined} */
    if (!BaseClient._historyBudgetLogged) {
      BaseClient._historyBudgetLogged = true;
      const historyTokenBudget = historyConfig?.tokenBudget ?? 0;
      logger.info({
        msg: '[BaseClient] HISTORY_TOKEN_BUDGET',
        historyTokenBudget,
      });
    }

    this.visionMode;
  }

    /**
     * @description Sets options for the client. Must be implemented by subclasses.
     * @throws {Error} Always throws as it is abstract.
     */
  setOptions() {
    throw new Error("Method 'setOptions' must be implemented.");
  }

    /**
     * @description Gets completion from the model. Must be implemented by subclasses.
     * @returns {Promise<any>} Completion result.
     * @throws {Error} Always throws as it is abstract.
     */
  async getCompletion() {
    throw new Error("Method 'getCompletion' must be implemented.");
  }

    /**
     * @description Sends completion request. Must be implemented by subclasses.
     * @returns {Promise<any>} Send result.
     * @throws {Error} Always throws as it is abstract.
     */
  async sendCompletion() {
    throw new Error("Method 'sendCompletion' must be implemented.");
  }

    /**
     * @description Gets save options for messages. Must be implemented by subclasses.
     * @returns {Object} Save options.
     * @throws {Error} Always throws as it is abstract.
     */
  getSaveOptions() {
    throw new Error('Subclasses must implement getSaveOptions');
  }

    /**
     * @description Builds messages for the request. Must be implemented by subclasses.
     * @returns {Promise<any>} Built messages.
     * @throws {Error} Always throws as it is abstract.
     */
  async buildMessages() {
    throw new Error('Subclasses must implement buildMessages');
  }

    /**
     * @description Summarizes messages. Must be implemented by subclasses if used.
     * @returns {Promise<any>} Summarized messages.
     * @throws {Error} Always throws as it is abstract.
     */
  async summarizeMessages() {
    throw new Error('Subclasses attempted to call summarizeMessages without implementing it');
  }

  /**
   * @returns {string}
   */
  getResponseModel() {
    if (isAgentsEndpoint(this.options.endpoint) && this.options.agent && this.options.agent.id) {
      return this.options.agent.id;
    }

    return this.modelOptions?.model ?? this.model;
  }

  /**
   * Abstract method to get the token count for a message. Subclasses must implement this method.
   * @param {TMessage} responseMessage
   * @returns {number}
   */
  getTokenCountForResponse(responseMessage) {
    logger.debug('[BaseClient] `recordTokenUsage` not implemented.', responseMessage);
  }

  /**
   * Abstract method to record token usage. Subclasses must implement this method.
   * If a correction to the token usage is needed, the method should return an object with the corrected token counts.
   * Should only be used if `recordCollectedUsage` was not used instead.
   * @param {string} [model]
   * @param {AppConfig['balance']} [balance]
   * @param {number} promptTokens
   * @param {number} completionTokens
   * @returns {Promise<void>}
   */
  async recordTokenUsage({ model, balance, promptTokens, completionTokens }) {
    logger.debug('[BaseClient] `recordTokenUsage` not implemented.', {
      model,
      balance,
      promptTokens,
      completionTokens,
    });
  }

  /**
   * Makes an HTTP request and logs the process.
   *
   * @param {RequestInfo} url - The URL to make the request to. Can be a string or a Request object.
   * @param {RequestInit} [init] - Optional init options for the request.
   * @returns {Promise<Response>} - A promise that resolves to the response of the fetch request.
   */
  async fetch(_url, init) {
    let url = _url;
    if (this.options.directEndpoint) {
      url = this.options.reverseProxyUrl;
    }
    logger.debug(`Making request to ${url}`);
    if (typeof Bun !== 'undefined') {
      return await fetch(url, init);
    }
    return await fetch(url, init);
  }

  getBuildMessagesOptions() {
    throw new Error('Subclasses must implement getBuildMessagesOptions');
  }

    /**
   * Возвращает таймаут для сетевых операций клиента.
   *
   * @param {number | null | undefined} explicitTimeoutMs
   * @returns {number}
   */
  getClientTimeoutMs(explicitTimeoutMs) {
    const candidate = Number(explicitTimeoutMs);
    if (Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }

    const optionTimeout =
      Number.isFinite(this.options?.requestTimeoutMs) && this.options.requestTimeoutMs > 0
        ? this.options.requestTimeoutMs
        : Number.isFinite(this.options?.timeoutMs) && this.options.timeoutMs > 0
          ? this.options.timeoutMs
          : undefined;

    if (optionTimeout != null) {
      return optionTimeout;
    }

    return DEFAULT_CLIENT_TIMEOUT_MS;
  }

  /**
   * Формирует набор параметров повторных попыток с учётом настроек клиента и явных переопределений.
   *
   * @param {RetryOptions | null | undefined} override
   * @returns {{ retries: number, minDelay: number, maxDelay: number, factor: number, jitter: number }}
   */
  getClientRetryOptions(override) {
    const baseOptions =
      (this.options?.retryOptions ??
        this.options?.clientRetry ??
        {}) || {};

    const effective = Object.assign({}, baseOptions, override ?? {});
    const retries = parsePositiveInt(
      effective.retries ?? effective.maxRetries,
      DEFAULT_CLIENT_RETRY_COUNT,
    );
    const minDelay = parsePositiveInt(
      effective.minDelay,
      DEFAULT_CLIENT_RETRY_MIN_DELAY_MS,
    );
    const maxDelay = parsePositiveInt(
      effective.maxDelay,
      DEFAULT_CLIENT_RETRY_MAX_DELAY_MS,
    );
    const factor =
      Number.isFinite(Number(effective.factor)) && Number(effective.factor) > 0
        ? Number(effective.factor)
        : DEFAULT_CLIENT_RETRY_FACTOR;
    const jitter =
      Number.isFinite(Number(effective.jitter)) && Number(effective.jitter) >= 0
        ? Number(effective.jitter)
        : DEFAULT_CLIENT_RETRY_JITTER;

    return { retries, minDelay, maxDelay, factor, jitter };
  }

  /**
   * Выполняет сетевую операцию с таймаутом и повторными попытками.
   *
   * @template T
   * @param {(attempt: number) => Promise<T>} task
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {number | null} [options.timeoutMs]
   * @param {RetryOptions} [options.retryOptions]
   * @param {string} [options.action]
   * @param {(error: Error, attempt: number) => (Promise<void> | void)} [options.onRetry]
   * @param {(attempt: number) => (Promise<void> | void)} [options.beforeAttempt]
   * @returns {Promise<T>}
   */
  async runWithClientResilience(task, options = {}) {
    const {
      signal = this.abortController?.signal,
      timeoutMs,
      retryOptions,
      action = `${this.constructor.name}.request`,
      onRetry,
      beforeAttempt,
    } = options ?? {};

    const resolvedTimeout = this.getClientTimeoutMs(timeoutMs);
    const resolvedRetry = this.getClientRetryOptions(retryOptions);

    const operation = async (attempt) => {
      if (typeof beforeAttempt === 'function') {
        await beforeAttempt(attempt);
      }

      const attemptLabel = `${action} (попытка ${attempt + 1})`;
      const execution = Promise.resolve(task(attempt));

      return withTimeout(
        execution,
        resolvedTimeout,
        `${attemptLabel} превысил таймаут`,
        signal,
      );
    };

    return retryAsync(operation, {
      ...resolvedRetry,
      signal,
      onRetry: async (err, attempt) => {
        if (err?.name === 'AbortError') {
          throw err;
        }

        logger.warn(
          '[%s] Попытка %d завершилась ошибкой: %s',
          action,
          attempt,
          err?.message || err,
        );

        if (typeof onRetry === 'function') {
          await onRetry(err, attempt);
        }
      },
    });
  }

    /**
     * @description Generates a text stream and processes it with progress callback.
     * @param {string} text - Text to stream.
     * @param {function} onProgress - Progress callback function.
     * @param {Object} [options={}] - Stream options.
     * @returns {Promise<void>}
     */
  async generateTextStream(text, onProgress, options = {}) {
    const stream = new TextStream(text, options);
    await stream.processTextStream(onProgress);
  }

  /**
   * @returns {[string|undefined, string|undefined]}
   */
  processOverideIds() {
    /** @type {Record<string, string | undefined>} */
    let { overrideConvoId, overrideUserMessageId } = this.options?.req?.body ?? {};
    if (overrideConvoId) {
      const [conversationId, index] = overrideConvoId.split(Constants.COMMON_DIVIDER);
      overrideConvoId = conversationId;
      if (index !== '0') {
        this.skipSaveConvo = true;
      }
    }
    if (overrideUserMessageId) {
      const [userMessageId, index] = overrideUserMessageId.split(Constants.COMMON_DIVIDER);
      overrideUserMessageId = userMessageId;
      if (index !== '0') {
        this.skipSaveUserMessage = true;
      }
    }

    return [overrideConvoId, overrideUserMessageId];
  }

    /**
     * @description Sets message options and loads conversation history.
     * @param {Object} [opts={}] - Options for message setup.
     * @returns {Promise<Object>} Resolved options including IDs and history.
     */
  async setMessageOptions(opts = {}) {
    if (opts && opts.replaceOptions) {
      this.setOptions(opts);
    }

    const [overrideConvoId, overrideUserMessageId] = this.processOverideIds();
    const { isEdited, isContinued } = opts;
    const user = opts.user ?? null;
    this.user = user;
    const saveOptions = this.getSaveOptions();
    this.abortController = opts.abortController ?? new AbortController();
    const requestConvoId = overrideConvoId ?? opts.conversationId;
    const conversationId = requestConvoId ?? crypto.randomUUID();
    const parentMessageId = opts.parentMessageId ?? Constants.NO_PARENT;
    const userMessageId =
      overrideUserMessageId ?? opts.overrideParentMessageId ?? crypto.randomUUID();
    let responseMessageId = opts.responseMessageId ?? crypto.randomUUID();
    let head = isEdited ? responseMessageId : parentMessageId;
    this.currentMessages = (await this.loadHistory(conversationId, head)) ?? [];
    this.conversationId = conversationId;

    if (isEdited && !isContinued) {
      responseMessageId = crypto.randomUUID();
      head = responseMessageId;
      this.currentMessages[this.currentMessages.length - 1].messageId = head;
    }

    if (opts.isRegenerate && responseMessageId.endsWith('_')) {
      responseMessageId = crypto.randomUUID();
    }

    this.responseMessageId = responseMessageId;

    return {
      ...opts,
      user,
      head,
      saveOptions,
      userMessageId,
      requestConvoId,
      conversationId,
      parentMessageId,
      responseMessageId,
    };
  }

    /**
     * @description Creates a user message object.
     * @param {Object} params - Parameters for user message.
     * @param {string} params.messageId - Message ID.
     * @param {string} params.parentMessageId - Parent message ID.
     * @param {string} params.conversationId - Conversation ID.
     * @param {string} params.text - Message text.
     * @returns {Object} User message object.
     */
  createUserMessage({ messageId, parentMessageId, conversationId, text }) {
    return {
      messageId,
      parentMessageId,
      conversationId,
      sender: 'User',
      text,
      isCreatedByUser: true,
    };
  }

    /**
     * @description Handles start methods for message processing.
     * @param {string} message - Message text.
     * @param {Object} opts - Options for handling.
     * @returns {Promise<Object>} Processed options and user message.
     */
  async handleStartMethods(message, opts) {
    const {
      user,
      head,
      saveOptions,
      userMessageId,
      requestConvoId,
      conversationId,
      parentMessageId,
      responseMessageId,
    } = await this.setMessageOptions(opts);

    const userMessage = opts.isEdited
      ? this.currentMessages[this.currentMessages.length - 2]
      : this.createUserMessage({
          messageId: userMessageId,
          parentMessageId,
          conversationId,
          text: message,
        });

    if (typeof opts?.getReqData === 'function') {
      opts.getReqData({
        userMessage,
        conversationId,
        responseMessageId,
        sender: this.sender,
      });
    }

    if (typeof opts?.onStart === 'function') {
      const isNewConvo = !requestConvoId && parentMessageId === Constants.NO_PARENT;
      opts.onStart(userMessage, responseMessageId, isNewConvo);
    }

    return {
      ...opts,
      user,
      head,
      conversationId,
      responseMessageId,
      saveOptions,
      userMessage,
    };
  }

  /**
   * Adds instructions to the messages array. If the instructions object is empty or undefined,
   * the original messages array is returned. Otherwise, the instructions are added to the messages
   * array either at the beginning (default) or preserving the last message at the end.
   *
   * @param {Array} messages - An array of messages.
   * @param {Object} instructions - An object containing instructions to be added to the messages.
   * @param {boolean} [beforeLast=false] - If true, adds instructions before the last message; if false, adds at the beginning.
   * @returns {Array} An array containing messages and instructions, or the original messages if instructions are empty.
   */
  normalizeInstructionsPayload(rawInstructions, options = {}) {
    const { logPrefix = '[BaseClient]', encodingResolver } = options ?? {};

    const resolveEncoding = () => {
      if (typeof encodingResolver === 'function') {
        try {
          const resolved = encodingResolver();
          if (resolved) {
            return resolved;
          }
        } catch (error) {
          logger.warn(`${logPrefix} Failed to resolve encoding via function: ${error.message}`);
        }
      } else if (typeof encodingResolver === 'string' && encodingResolver.trim().length > 0) {
        return encodingResolver.trim();
      }

      if (typeof this.getEncoding === 'function') {
        try {
          const encoding = this.getEncoding();
          if (encoding) {
            return encoding;
          }
        } catch (error) {
          logger.warn(`${logPrefix} getEncoding() failed: ${error.message}`);
        }
      }

      return DEFAULT_INSTRUCTIONS_ENCODING;
    };

    const encoding = resolveEncoding();

    const computeTokens = (text) => {
  if (!text) {
    return 0;
  }
  if (Tokenizer?.getTokenCount) {
    try {
      return Tokenizer.getTokenCount(text, encoding);
    } catch (error) {
      safeWarn(`${logPrefix} Failed to count tokens: ${error.message}`);
    }
  } else {
    safeWarn(`${logPrefix} Tokenizer unavailable, using string length as estimate.`);
  }
  return text.length;
};

    if (rawInstructions == null) {
      return { content: '', tokenCount: 0 };
    }

    if (typeof rawInstructions === 'object') {
      const content = rawInstructions.content;
      if (typeof content !== 'string') {
        logger.warn(`${logPrefix} Instructions object missing valid content property.`);
        return { content: '', tokenCount: 0 };
      }

      const tokenCount = computeTokens(content);
      if (rawInstructions.tokenCount !== tokenCount) {
        logger.info(
          `${logPrefix} Recomputed instruction tokens. Length: ${content.length}, Tokens: ${tokenCount}`,
        );
      }

      return { content, tokenCount };
    }

    if (typeof rawInstructions !== 'string') {
      logger.warn(`${logPrefix} Unsupported instructions type: ${typeof rawInstructions}`);
      return { content: '', tokenCount: 0 };
    }

    const tokenCount = computeTokens(rawInstructions);
    logger.info(
      `${logPrefix} Converted string instructions. Length: ${rawInstructions.length}, Tokens: ${tokenCount}`,
    );

    return {
      content: rawInstructions,
      tokenCount,
    };
  }

    /**
     * @description Adds instructions to the messages array.
     * @param {Array} messages - Array of messages.
     * @param {Object} instructions - Instructions object to add.
     * @param {boolean} [beforeLast=false] - If true, adds before the last message.
     * @returns {Array} Messages array with instructions added.
     */
  addInstructions(messages, instructions, beforeLast = false) {
    if (!instructions || Object.keys(instructions).length === 0) {
      return messages;
    }

    if (!beforeLast) {
      return [instructions, ...messages];
    }

    // Legacy behavior: add instructions before the last message
    const payload = [];
    if (messages.length > 1) {
      payload.push(...messages.slice(0, -1));
    }

    payload.push(instructions);

    if (messages.length > 0) {
      payload.push(messages[messages.length - 1]);
    }

    return payload;
  }

    /**
     * @description Handles token count mapping for messages.
     * @param {Object} tokenCountMap - Map of message IDs to token counts.
     * @returns {Promise<void>}
     */
  async handleTokenCountMap(tokenCountMap) {
    if (this.clientName === EModelEndpoint.agents) {
      return;
    }
    if (this.currentMessages.length === 0) {
      return;
    }

    for (let i = 0; i < this.currentMessages.length; i++) {
      // Skip the last message, which is the user message.
      if (i === this.currentMessages.length - 1) {
        break;
      }

      const message = this.currentMessages[i];
      const { messageId } = message;
      const update = {};

      if (messageId === tokenCountMap.summaryMessage?.messageId) {
        logger.debug(`[BaseClient] Adding summary props to ${messageId}.`);

        update.summary = tokenCountMap.summaryMessage.content;
        update.summaryTokenCount = tokenCountMap.summaryMessage.tokenCount;
      }

      if (message.tokenCount && !update.summaryTokenCount) {
        logger.debug(`[BaseClient] Skipping ${messageId}: already had a token count.`);
        continue;
      }

      const tokenCount = tokenCountMap[messageId];
      if (tokenCount) {
        message.tokenCount = tokenCount;
        update.tokenCount = tokenCount;
        await this.updateMessageInDatabase({ messageId, ...update });
      }
    }
  }

    /**
     * @description Concatenates messages into a single string.
     * @param {Array} messages - Array of message objects.
     * @returns {string} Concatenated message string.
     */
  concatenateMessages(messages) {
    return messages.reduce((acc, message) => {
      const nameOrRole = message.name ?? message.role;
      return acc + `${nameOrRole}:\n${message.content}\n\n`;
    }, '');
  }

  /**
   * This method processes an array of messages and returns a context of messages that fit within a specified token limit.
   * It iterates over the messages from newest to oldest, adding them to the context until the token limit is reached.
   * If the token limit would be exceeded by adding a message, that message is not added to the context and remains in the original array.
   * The method uses `push` and `pop` operations for efficient array manipulation, and reverses the context array at the end to maintain the original order of the messages.
   *
   * @param {Object} params
   * @param {TMessage[]} params.messages - An array of messages, each with a `tokenCount` property. The messages should be ordered from oldest to newest.
   * @param {number} [params.maxContextTokens] - The max number of tokens allowed in the context. If not provided, defaults to `this.maxContextTokens`.
   * @param {{ role: 'system', content: text, tokenCount: number }} [params.instructions] - Instructions already added to the context at index 0.
   * @returns {Promise<{
   *  context: TMessage[],
   *  remainingContextTokens: number,
   *  messagesToRefine: TMessage[],
   * }>} An object with three properties: `context`, `remainingContextTokens`, and `messagesToRefine`.
   *    `context` is an array of messages that fit within the token limit.
   *    `remainingContextTokens` is the number of tokens remaining within the limit after adding the messages to the context.
   *    `messagesToRefine` is an array of messages that were not added to the context because they would have exceeded the token limit.
   */
  async getMessagesWithinTokenLimit({ messages: _messages, maxContextTokens, instructions }) {
    // Every reply is primed with <|start|>assistant<|message|>, so we
    // start with 3 tokens for the label after all messages have been counted.
    let currentTokenCount = 3;
    const instructionsTokenCount = instructions?.tokenCount ?? 0;
    let remainingContextTokens =
      (maxContextTokens ?? this.maxContextTokens) - instructionsTokenCount;
    const messages = [..._messages];

    const context = [];

    if (currentTokenCount < remainingContextTokens) {
      while (messages.length > 0 && currentTokenCount < remainingContextTokens) {
        if (messages.length === 1 && instructions) {
          break;
        }
        const poppedMessage = messages.pop();
        const { tokenCount } = poppedMessage;

        if (poppedMessage && currentTokenCount + tokenCount <= remainingContextTokens) {
          context.push(poppedMessage);
          currentTokenCount += tokenCount;
        } else {
          messages.push(poppedMessage);
          break;
        }
      }
    }

    if (instructions) {
      context.push(_messages[0]);
      messages.shift();
    }

    const prunedMemory = messages;
    remainingContextTokens -= currentTokenCount;

    return {
      context: context.reverse(),
      remainingContextTokens,
      messagesToRefine: prunedMemory,
    };
  }

  async handleContextStrategy({
    instructions,
    orderedMessages,
    formattedMessages,
    buildTokenMap = true,
  }) {
    let _instructions;
    let tokenCount;

    if (instructions) {
      ({ tokenCount, ..._instructions } = instructions);
    }

    _instructions && logger.debug('[BaseClient] instructions tokenCount: ' + tokenCount);
    if (tokenCount && tokenCount > this.maxContextTokens) {
      const info = `${tokenCount} / ${this.maxContextTokens}`;
      const errorMessage = `{ "type": "${ErrorTypes.INPUT_LENGTH}", "info": "${info}" }`;
      logger.warn(`Instructions token count exceeds max token count (${info}).`);
      throw new Error(errorMessage);
    }

    if (this.clientName === EModelEndpoint.agents) {
      const { dbMessages, editedIndices } = truncateToolCallOutputs(
        orderedMessages,
        this.maxContextTokens,
        this.getTokenCountForMessage.bind(this),
      );

      if (editedIndices.length > 0) {
        logger.debug('[BaseClient] Truncated tool call outputs:', editedIndices);
        for (const index of editedIndices) {
          formattedMessages[index].content = dbMessages[index].content;
        }
        orderedMessages = dbMessages;
      }
    }

    let orderedWithInstructions = this.addInstructions(orderedMessages, instructions);

    let { context, remainingContextTokens, messagesToRefine } =
      await this.getMessagesWithinTokenLimit({
        messages: orderedWithInstructions,
        instructions,
      });

    logger.debug('[BaseClient] Context Count (1/2)', {
      remainingContextTokens,
      maxContextTokens: this.maxContextTokens,
    });

    let summaryMessage;
    let summaryTokenCount;
    let { shouldSummarize } = this;

    // Calculate the difference in length to determine how many messages were discarded if any
    let payload;
    let { length } = formattedMessages;
    length += instructions != null ? 1 : 0;
    const diff = length - context.length;
    const firstMessage = orderedWithInstructions[0];
    const usePrevSummary =
      shouldSummarize &&
      diff === 1 &&
      firstMessage?.summary &&
      this.previous_summary.messageId === firstMessage.messageId;

    if (diff > 0) {
      payload = formattedMessages.slice(diff);
      logger.debug(
        `[BaseClient] Difference between original payload (${length}) and context (${context.length}): ${diff}`,
      );
    }

    payload = this.addInstructions(payload ?? formattedMessages, _instructions);

    const latestMessage = orderedWithInstructions[orderedWithInstructions.length - 1];
    if (payload.length === 0 && !shouldSummarize && latestMessage) {
      const info = `${latestMessage.tokenCount} / ${this.maxContextTokens}`;
      const errorMessage = `{ "type": "${ErrorTypes.INPUT_LENGTH}", "info": "${info}" }`;
      logger.warn(`Prompt token count exceeds max token count (${info}).`);
      throw new Error(errorMessage);
    } else if (
      _instructions &&
      payload.length === 1 &&
      payload[0].content === _instructions.content
    ) {
      const info = `${tokenCount + 3} / ${this.maxContextTokens}`;
      const errorMessage = `{ "type": "${ErrorTypes.INPUT_LENGTH}", "info": "${info}" }`;
      logger.warn(
        `Including instructions, the prompt token count exceeds remaining max token count (${info}).`,
      );
      throw new Error(errorMessage);
    }

    if (usePrevSummary) {
      summaryMessage = { role: 'system', content: firstMessage.summary };
      summaryTokenCount = firstMessage.summaryTokenCount;
      payload.unshift(summaryMessage);
      remainingContextTokens -= summaryTokenCount;
    } else if (shouldSummarize && messagesToRefine.length > 0) {
      ({ summaryMessage, summaryTokenCount } = await this.summarizeMessages({
        messagesToRefine,
        remainingContextTokens,
      }));
      summaryMessage && payload.unshift(summaryMessage);
      remainingContextTokens -= summaryTokenCount;
    }

    // Make sure to only continue summarization logic if the summary message was generated
    shouldSummarize = summaryMessage != null && shouldSummarize === true;

    logger.debug('[BaseClient] Context Count (2/2)', {
      remainingContextTokens,
      maxContextTokens: this.maxContextTokens,
    });

    /** @type {Record<string, number> | undefined} */
    let tokenCountMap;
    if (buildTokenMap) {
      const currentPayload = shouldSummarize ? orderedWithInstructions : context;
      tokenCountMap = currentPayload.reduce((map, message, index) => {
        const { messageId } = message;
        if (!messageId) {
          return map;
        }

        if (shouldSummarize && index === messagesToRefine.length - 1 && !usePrevSummary) {
          map.summaryMessage = { ...summaryMessage, messageId, tokenCount: summaryTokenCount };
        }

        map[messageId] = currentPayload[index].tokenCount;
        return map;
      }, {});
    }

    const promptTokens = this.maxContextTokens - remainingContextTokens;

    logger.debug('[BaseClient] tokenCountMap:', tokenCountMap);
    logger.debug('[BaseClient]', {
      promptTokens,
      remainingContextTokens,
      payloadSize: payload.length,
      maxContextTokens: this.maxContextTokens,
    });

    return { payload, tokenCountMap, promptTokens, messages: orderedWithInstructions };
  }

    /**
     * @description Sends a message and handles the response.
     * @param {string} message - Message text to send.
     * @param {Object} [opts={}] - Options for sending.
     * @returns {Promise<any>} Completion result.
     * @throws {Error} If sending fails or limits exceeded.
     */
  async sendMessage(message, opts = {}) {
    const appConfig = this.options.req?.config;
    /** @type {Promise<TMessage>} */
    let userMessagePromise;
    const { user, head, isEdited, conversationId, responseMessageId, saveOptions, userMessage } =
      await this.handleStartMethods(message, opts);

    if (opts.progressCallback) {
      opts.onProgress = opts.progressCallback.call(null, {
        ...(opts.progressOptions ?? {}),
        parentMessageId: userMessage.messageId,
        messageId: responseMessageId,
      });
    }

    const { editedContent } = opts;

    // It's not necessary to push to currentMessages
    // depending on subclass implementation of handling messages
    // When this is an edit, all messages are already in currentMessages, both user and response
    if (isEdited) {
      let latestMessage = this.currentMessages[this.currentMessages.length - 1];
      if (!latestMessage) {
        latestMessage = {
          messageId: responseMessageId,
          conversationId,
          parentMessageId: userMessage.messageId,
          isCreatedByUser: false,
          model: this.modelOptions?.model ?? this.model,
          sender: this.sender,
        };
        this.currentMessages.push(userMessage, latestMessage);
      } else if (editedContent != null) {
        // Handle editedContent for content parts
        if (editedContent && latestMessage.content && Array.isArray(latestMessage.content)) {
          const { index, text, type } = editedContent;
          if (index >= 0 && index < latestMessage.content.length) {
            const contentPart = latestMessage.content[index];
            if (type === ContentTypes.THINK && contentPart.type === ContentTypes.THINK) {
              contentPart[ContentTypes.THINK] = text;
            } else if (type === ContentTypes.TEXT && contentPart.type === ContentTypes.TEXT) {
              contentPart[ContentTypes.TEXT] = text;
            }
          }
        }
      }
      this.continued = true;
    } else {
      this.currentMessages.push(userMessage);
    }

    /**
     * When the userMessage is pushed to currentMessages, the parentMessage is the userMessageId.
     * this only matters when buildMessages is utilizing the parentMessageId, and may vary on implementation
     */
    const parentMessageId = isEdited ? head : userMessage.messageId;
    this.parentMessageId = parentMessageId;
    let {
      prompt: payload,
      tokenCountMap,
      promptTokens,
    } = await this.buildMessages(
      this.currentMessages,
      parentMessageId,
      this.getBuildMessagesOptions(opts),
      opts,
    );

    if (tokenCountMap) {
      logger.debug('[BaseClient] tokenCountMap', tokenCountMap);
      if (tokenCountMap[userMessage.messageId]) {
        userMessage.tokenCount = tokenCountMap[userMessage.messageId];
        logger.debug('[BaseClient] userMessage', userMessage);
      }

      this.handleTokenCountMap(tokenCountMap);
    }

    if (!isEdited && !this.skipSaveUserMessage) {
      userMessagePromise = this.saveMessageToDatabase(userMessage, saveOptions, user);
      this.savedMessageIds.add(userMessage.messageId);
      if (typeof opts?.getReqData === 'function') {
        opts.getReqData({
          userMessagePromise,
        });
      }
    }

    const balanceConfig = getBalanceConfig(appConfig);
    // endpoint for billing/logging inside sendMessage
    const endpointForBilling = (this?.options?.endpoint)
      ?? (this?.options?.req?.body?.endpoint)
      ?? 'unknown';
    if (
      balanceConfig?.enabled &&
      supportsBalanceCheck[this.options.endpointType ?? this.options.endpoint]
    ) {
      await checkBalance({
        req: this.options.req,
        res: this.options.res,
        txData: {
          user: this.user,
          tokenType: 'prompt',
          amount: promptTokens,
          endpoint: endpointForBilling,
          model: this.modelOptions?.model ?? this.model,
          endpointTokenConfig: this.options.endpointTokenConfig,
        },
      });
    }

    /** @type {string|string[]|undefined} */
    const completion = await this.sendCompletion(payload, opts);
    if (this.abortController) {
      this.abortController.requestCompleted = true;
    }

    /** @type {TMessage} */
    const responseMessage = {
      messageId: responseMessageId,
      conversationId,
      parentMessageId: userMessage.messageId,
      isCreatedByUser: false,
      isEdited,
      model: this.getResponseModel(),
      sender: this.sender,
      promptTokens,
      iconURL: this.options.iconURL,
      endpoint: endpointForBilling,
      ...(this.metadata ?? {}),
    };

    if (typeof completion === 'string') {
      responseMessage.text = completion;
    } else if (
      Array.isArray(completion) &&
      (this.clientName === EModelEndpoint.agents ||
        isParamEndpoint(this.options.endpoint, this.options.endpointType))
    ) {
      responseMessage.text = '';

      if (!opts.editedContent || this.currentMessages.length === 0) {
        responseMessage.content = completion;
      } else {
        const latestMessage = this.currentMessages[this.currentMessages.length - 1];
        if (!latestMessage?.content) {
          responseMessage.content = completion;
        } else {
          const existingContent = [...latestMessage.content];
          const { type: editedType } = opts.editedContent;
          responseMessage.content = this.mergeEditedContent(
            existingContent,
            completion,
            editedType,
          );
        }
      }
    } else if (Array.isArray(completion)) {
      responseMessage.text = completion.join('');
    }

    if (
      tokenCountMap &&
      this.recordTokenUsage &&
      this.getTokenCountForResponse &&
      this.getTokenCount
    ) {
      let completionTokens;

      /**
       * Metadata about input/output costs for the current message. The client
       * should provide a function to get the current stream usage metadata; if not,
       * use the legacy token estimations.
       * @type {StreamUsage | null} */
      const usage = this.getStreamUsage != null ? this.getStreamUsage() : null;

      if (usage != null && Number(usage[this.outputTokensKey]) > 0) {
        responseMessage.tokenCount = usage[this.outputTokensKey];
        completionTokens = responseMessage.tokenCount;
        await this.updateUserMessageTokenCount({
          usage,
          tokenCountMap,
          userMessage,
          userMessagePromise,
          opts,
        });
      } else {
        responseMessage.tokenCount = this.getTokenCountForResponse(responseMessage);
        completionTokens = responseMessage.tokenCount;
        await this.recordTokenUsage({
          usage,
          promptTokens,
          completionTokens,
          balance: balanceConfig,
          model: responseMessage.model,
        });
      }
    }

    if (userMessagePromise) {
      await userMessagePromise;
    }

    if (this.artifactPromises) {
      responseMessage.attachments = (await Promise.all(this.artifactPromises)).filter((a) => a);
    }

    if (this.options.attachments) {
      try {
        saveOptions.files = this.options.attachments.map((attachments) => attachments.file_id);
      } catch (error) {
        logger.error('[BaseClient] Error mapping attachments for conversation', error);
      }
    }

    responseMessage.databasePromise = this.saveMessageToDatabase(
      responseMessage,
      saveOptions,
      user,
    );
    this.savedMessageIds.add(responseMessage.messageId);
    delete responseMessage.tokenCount;
    return responseMessage;
  }

  /**
   * Stream usage should only be used for user message token count re-calculation if:
   * - The stream usage is available, with input tokens greater than 0,
   * - the client provides a function to calculate the current token count,
   * - files are being resent with every message (default behavior; or if `false`, with no attachments),
   * - the `promptPrefix` (custom instructions) is not set.
   *
   * In these cases, the legacy token estimations would be more accurate.
   *
   * TODO: included system messages in the `orderedMessages` accounting, potentially as a
   * separate message in the UI. ChatGPT does this through "hidden" system messages.
   * @param {object} params
   * @param {StreamUsage} params.usage
   * @param {Record<string, number>} params.tokenCountMap
   * @param {TMessage} params.userMessage
   * @param {Promise<TMessage>} params.userMessagePromise
   * @param {object} params.opts
   */
  async updateUserMessageTokenCount({
    usage,
    tokenCountMap,
    userMessage,
    userMessagePromise,
    opts,
  }) {
    /** @type {boolean} */
    const shouldUpdateCount =
      this.calculateCurrentTokenCount != null &&
      Number(usage[this.inputTokensKey]) > 0 &&
      (this.options.resendFiles ||
        (!this.options.resendFiles && !this.options.attachments?.length)) &&
      !this.options.promptPrefix;

    if (!shouldUpdateCount) {
      return;
    }

    const userMessageTokenCount = this.calculateCurrentTokenCount({
      currentMessageId: userMessage.messageId,
      tokenCountMap,
      usage,
    });

    if (userMessageTokenCount === userMessage.tokenCount) {
      return;
    }

    userMessage.tokenCount = userMessageTokenCount;
    /*
      Note: `AgentController` saves the user message if not saved here
      (noted by `savedMessageIds`), so we update the count of its `userMessage` reference
    */
    if (typeof opts?.getReqData === 'function') {
      opts.getReqData({
        userMessage,
      });
    }
    /*
      Note: we update the user message to be sure it gets the calculated token count;
      though `AgentController` saves the user message if not saved here
      (noted by `savedMessageIds`), EditController does not
    */
    await userMessagePromise;
    await this.updateMessageInDatabase({
      messageId: userMessage.messageId,
      tokenCount: userMessageTokenCount,
    });
  }

    /**
     * @description Loads conversation history for the given conversation ID.
     * @param {string} conversationId - Unique identifier of the conversation.
     * @param {string|null} [parentMessageId=null] - Parent message ID to start from.
     * @returns {Promise<Array>} Array of messages in conversation history.
     */
  async loadHistory(conversationId, parentMessageId = null) {
    logger.debug('[BaseClient] Loading history:', { conversationId, parentMessageId });

    const messages = (await getMessages({ conversationId })) ?? [];

    if (messages.length === 0) {
      return [];
    }

    let mapMethod = null;
    if (this.getMessageMapMethod) {
      mapMethod = this.getMessageMapMethod();
    }

    let _messages = this.constructor.getMessagesForConversation({
      messages,
      parentMessageId,
      mapMethod,
    });

    _messages = await this.addPreviousAttachments(_messages);

    if (!this.shouldSummarize) {
      return _messages;
    }

    // Find the latest message with a 'summary' property
    for (let i = _messages.length - 1; i >= 0; i--) {
      if (_messages[i]?.summary) {
        this.previous_summary = _messages[i];
        break;
      }
    }

    if (this.previous_summary) {
      const { messageId, summary, tokenCount, summaryTokenCount } = this.previous_summary;
      logger.debug('[BaseClient] Previous summary:', {
        messageId,
        summary,
        tokenCount,
        summaryTokenCount,
      });
    }

    return _messages;
  }

  /**
     * @description Saves a message to the database and updates conversation if needed.
     * @param {TMessage} message - Message object to save.
     * @param {Partial<TConversation>} endpointOptions - Endpoint options for conversation.
     * @param {string|null} [user=null] - User ID.
     * @returns {Promise<Object>} Saved message and conversation data.
     * @throws {Error} If user mismatch or save fails.
     **/
    async saveMessageToDatabase(message, endpointOptions = {}, user = null) {
    // Guard user mismatch
    if (this.user && user !== this.user) {
      throw new Error('User mismatch.');
    }

    // Safe req/endpoint values to avoid NPE during abort/switch
    const safeReq = (this && this.options && this.options.req)
      ? this.options.req
      : { user: { id: (user ?? this?.user ?? message?.user ?? null) } };

    const endpointSafe = (endpointOptions && endpointOptions.endpoint)
      || (this && this.options && this.options.endpoint)
      || (safeReq && safeReq.body && safeReq.body.endpoint)
      || (this && this.req && this.req.body && this.req.body.endpoint)
      || 'unknown';

    const endpointTypeSafe = (endpointOptions && endpointOptions.endpointType)
      || (this && this.options && this.options.endpointType)
      || undefined;

    // Save message
    const savedMessage = await saveMessage(
      safeReq,
      {
        ...message,
        endpoint: endpointSafe,
        unfinished: false,
        user,
      },
      { context: 'api/app/clients/BaseClient.js - saveMessageToDatabase #saveMessage' },
    );

    if (this.skipSaveConvo) {
      return { message: savedMessage };
    }

    // Prepare conversation fields
    const fieldsToKeep = {
      conversationId: message.conversationId,
      endpoint: endpointSafe,
      endpointType: endpointTypeSafe,
      ...endpointOptions,
    };

    const existingConvo =
      this.fetchedConvo === true
        ? null
        : await getConvo(safeReq?.user?.id, message.conversationId);

    if (
      existingConvo?.lastSummarizedIndex !== undefined &&
      fieldsToKeep.lastSummarizedIndex === undefined
    ) {
      fieldsToKeep.lastSummarizedIndex = existingConvo.lastSummarizedIndex;
    }
    const unsetFields = {};
    const exceptions = new Set(['spec', 'iconURL']);

    if (existingConvo != null) {
      this.fetchedConvo = true;
      for (const key in existingConvo) {
        if (!key) continue;
        if (excludedKeys.has(key) && !exceptions.has(key)) continue;
        if (endpointOptions?.[key] === undefined) {
          unsetFields[key] = 1;
        }
      }
    }
    if (fieldsToKeep.lastSummarizedIndex !== undefined) {
      delete unsetFields.lastSummarizedIndex;
    }

    const conversation = await saveConvo(safeReq, fieldsToKeep, {
      context: 'api/app/clients/BaseClient.js - saveMessageToDatabase #saveConvo',
      unsetFields,
    });

    return { message: savedMessage, conversation };

  }

  /**
   * Update a message in the database.
   * @param {Partial<TMessage>} message
   */
  async updateMessageInDatabase(message) {
    await updateMessage(this.options.req, message);
  }

  /**
   * Iterate through messages, building an array based on the parentMessageId.
   *
   * This function constructs a conversation thread by traversing messages from a given parentMessageId up to the root message.
   * It handles cyclic references by ensuring that a message is not processed more than once.
   * If the 'summary' option is set to true and a message has a 'summary' property:
   * - The message's 'role' is set to 'system'.
   * - The message's 'text' is set to its 'summary'.
   * - If the message has a 'summaryTokenCount', the message's 'tokenCount' is set to 'summaryTokenCount'.
   * The traversal stops at the message with the 'summary' property.
   *
   * Each message object should have an 'id' or 'messageId' property and may have a 'parentMessageId' property.
   * The 'parentMessageId' is the ID of the message that the current message is a reply to.
   * If 'parentMessageId' is not present, null, or is Constants.NO_PARENT,
   * the message is considered a root message.
   *
   * @param {Object} options - The options for the function.
   * @param {TMessage[]} options.messages - An array of message objects. Each object should have either an 'id' or 'messageId' property, and may have a 'parentMessageId' property.
   * @param {string} options.parentMessageId - The ID of the parent message to start the traversal from.
   * @param {Function} [options.mapMethod] - An optional function to map over the ordered messages. If provided, it will be applied to each message in the resulting array.
   * @param {boolean} [options.summary=false] - If set to true, the traversal modifies messages with 'summary' and 'summaryTokenCount' properties and stops at the message with a 'summary' property.
   * @returns {TMessage[]} An array containing the messages in the order they should be displayed, starting with the most recent message with a 'summary' property if the 'summary' option is true, and ending with the message identified by 'parentMessageId'.
   */
  static getMessagesForConversation({
    messages,
    parentMessageId,
    mapMethod = null,
    summary = false,
  }) {
    if (!messages || messages.length === 0) {
      return [];
    }

    const orderedMessages = [];
    let currentMessageId = parentMessageId;
    const visitedMessageIds = new Set();

    while (currentMessageId) {
      if (visitedMessageIds.has(currentMessageId)) {
        break;
      }
      const message = messages.find((msg) => {
        const messageId = msg.messageId ?? msg.id;
        return messageId === currentMessageId;
      });

      visitedMessageIds.add(currentMessageId);

      if (!message) {
        break;
      }

      if (summary && message.summary) {
        message.role = 'system';
        message.text = message.summary;
      }

      if (summary && message.summaryTokenCount) {
        message.tokenCount = message.summaryTokenCount;
      }

      orderedMessages.push(message);

      if (summary && message.summary) {
        break;
      }

      currentMessageId =
        message.parentMessageId === Constants.NO_PARENT ? null : message.parentMessageId;
    }

    orderedMessages.reverse();

    if (mapMethod) {
      return orderedMessages.map(mapMethod);
    }

    return orderedMessages;
  }

  /**
   * Algorithm adapted from "6. Counting tokens for chat API calls" of
   * https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
   *
   * An additional 3 tokens need to be added for assistant label priming after all messages have been counted.
   * In our implementation, this is accounted for in the getMessagesWithinTokenLimit method.
   *
   * The content parts example was adapted from the following example:
   * https://github.com/openai/openai-cookbook/pull/881/files
   *
   * Note: image token calculation is to be done elsewhere where we have access to the image metadata
   *
   * @param {Object} message
   */
  getTokenCountForMessage(message) {
    // Note: gpt-3.5-turbo and gpt-4 may update over time. Use default for these as well as for unknown models
    let tokensPerMessage = 3;
    let tokensPerName = 1;
    const model = this.modelOptions?.model ?? this.model;

    if (model === 'gpt-3.5-turbo-0301') {
      tokensPerMessage = 4;
      tokensPerName = -1;
    }

    const processValue = (value) => {
      if (Array.isArray(value)) {
        for (let item of value) {
          if (
            !item ||
            !item.type ||
            item.type === ContentTypes.THINK ||
            item.type === ContentTypes.ERROR ||
            item.type === ContentTypes.IMAGE_URL
          ) {
            continue;
          }

          if (item.type === ContentTypes.TOOL_CALL && item.tool_call != null) {
            const toolName = item.tool_call?.name || '';
            if (toolName != null && toolName && typeof toolName === 'string') {
              numTokens += this.getTokenCount(toolName);
            }

            const args = item.tool_call?.args || '';
            if (args != null && args && typeof args === 'string') {
              numTokens += this.getTokenCount(args);
            }

            const output = item.tool_call?.output || '';
            if (output != null && output && typeof output === 'string') {
              numTokens += this.getTokenCount(output);
            }
            continue;
          }

          const nestedValue = item[item.type];

          if (!nestedValue) {
            continue;
          }

          processValue(nestedValue);
        }
      } else if (typeof value === 'string') {
        numTokens += this.getTokenCount(value);
      } else if (typeof value === 'number') {
        numTokens += this.getTokenCount(value.toString());
      } else if (typeof value === 'boolean') {
        numTokens += this.getTokenCount(value.toString());
      }
    };

    let numTokens = tokensPerMessage;
    for (let [key, value] of Object.entries(message)) {
      processValue(value);

      if (key === 'name') {
        numTokens += tokensPerName;
      }
    }
    return numTokens;
  }

  /**
   * Merges completion content with existing content when editing TEXT or THINK types
   * @param {Array} existingContent - The existing content array
   * @param {Array} newCompletion - The new completion content
   * @param {string} editedType - The type of content being edited
   * @returns {Array} The merged content array
   */
  mergeEditedContent(existingContent, newCompletion, editedType) {
    if (!newCompletion.length) {
      return existingContent.concat(newCompletion);
    }

    if (editedType !== ContentTypes.TEXT && editedType !== ContentTypes.THINK) {
      return existingContent.concat(newCompletion);
    }

    const lastIndex = existingContent.length - 1;
    const lastExisting = existingContent[lastIndex];
    const firstNew = newCompletion[0];

    if (lastExisting?.type !== firstNew?.type || firstNew?.type !== editedType) {
      return existingContent.concat(newCompletion);
    }

    const mergedContent = [...existingContent];
    if (editedType === ContentTypes.TEXT) {
      mergedContent[lastIndex] = {
        ...mergedContent[lastIndex],
        [ContentTypes.TEXT]:
          (mergedContent[lastIndex][ContentTypes.TEXT] || '') + (firstNew[ContentTypes.TEXT] || ''),
      };
    } else {
      mergedContent[lastIndex] = {
        ...mergedContent[lastIndex],
        [ContentTypes.THINK]:
          (mergedContent[lastIndex][ContentTypes.THINK] || '') +
          (firstNew[ContentTypes.THINK] || ''),
      };
    }

    // Add remaining completion items
    return mergedContent.concat(newCompletion.slice(1));
  }

    /**
     * @description Sends payload and sets options if provided.
     * @param {any} payload - Payload to send.
     * @param {Object} [opts={}] - Options for sending.
     * @returns {Promise<any>} Completion result.
     */
  async sendPayload(payload, opts = {}) {
    if (opts && typeof opts === 'object') {
      this.setOptions(opts);
    }

    return await this.sendCompletion(payload, opts);
  }

  /**
   *
   * @param {TMessage[]} _messages
   * @returns {Promise<TMessage[]>}
   */
  async addPreviousAttachments(_messages) {
    if (!this.options.resendFiles) {
      return _messages;
    }

    const seen = new Set();
    const attachmentsProcessed =
      this.options.attachments && !(this.options.attachments instanceof Promise);
    if (attachmentsProcessed) {
      for (const attachment of this.options.attachments) {
        seen.add(attachment.file_id);
      }
    }

    /**
     *
     * @param {TMessage} message
     */
    const processMessage = async (message) => {
      if (!this.message_file_map) {
        /** @type {Record<string, MongoFile[]> */
        this.message_file_map = {};
      }

      const fileIds = [];
      for (const file of message.files) {
        if (seen.has(file.file_id)) {
          continue;
        }
        fileIds.push(file.file_id);
        seen.add(file.file_id);
      }

      if (fileIds.length === 0) {
        return message;
      }

      const files = await getFiles(
        {
          file_id: { $in: fileIds },
        },
        {},
        {},
      );

      await this.addImageURLs(message, files, this.visionMode);

      this.message_file_map[message.messageId] = files;
      return message;
    };

    const promises = [];

    for (const message of _messages) {
      if (!message.files) {
        promises.push(message);
        continue;
      }

      promises.push(processMessage(message));
    }

    const messages = await Promise.all(promises);

    this.checkVisionRequest(Object.values(this.message_file_map ?? {}).flat());
    return messages;
  }
}

module.exports = BaseClient;
