// /opt/open-webui/GoogleClient.js - исправлено: путь к prompts по алиасу

const { getModelMaxTokens } = require('@librechat/api');
const { concat } = require('@langchain/core/utils/stream');
const { Tokenizer, getSafetySettings } = require('@librechat/api');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const {
  googleGenConfigSchema,
  getResponseSender,
  endpointSettings,
  EModelEndpoint,
  googleSettings,
  ErrorTypes,
  Constants,
  AuthKeys,
} = require('librechat-data-provider');
const { spendTokens } = require('~/models/spendTokens');
const { sleep } = require('~/server/utils');
const { logger } = require('~/config');

// ВАЖНО: правильный путь к prompts через алиас ~
const {
  formatMessage,
  createContextHandlers,
} = require('~/server/services/Endpoints/prompts');

const BaseClient = require('./BaseClient');

const loc = process.env.GOOGLE_LOC || 'us-central1';
const publisher = 'google';
const endpointPrefix =
  loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;

const settings = endpointSettings[EModelEndpoint.google];
const EXCLUDED_GENAI_MODELS = /gemini-(?:1\.0|1-0|pro)/;

class GoogleClient extends BaseClient {
  constructor(credentials, options = {}) {
    super('apiKey', options);
    let creds = {};

    if (typeof credentials === 'string') {
      creds = JSON.parse(credentials);
    } else if (credentials) {
      creds = credentials;
    }

    const serviceKey = creds[AuthKeys.GOOGLE_SERVICE_KEY] ?? {};
    this.serviceKey =
      serviceKey && typeof serviceKey === 'string' ? JSON.parse(serviceKey) : (serviceKey ?? {});
    this.project_id = this.serviceKey.project_id;
    this.client_email = this.serviceKey.client_email;
    this.private_key = this.serviceKey.private_key;
    this.access_token = null;

    this.apiKey = creds[AuthKeys.GOOGLE_API_KEY];
    this.reverseProxyUrl = options.reverseProxyUrl;
    this.authHeader = options.authHeader;

    this.usage;
    this.inputTokensKey = 'input_tokens';
    this.outputTokensKey = 'output_tokens';
    this.visionMode = 'generative';
    this.systemMessage;
    if (options.skipSetOptions) {
      return;
    }
    this.setOptions(options);
  }

  constructUrl() {
    return `https://${endpointPrefix}/v1/projects/${this.project_id}/locations/${loc}/publishers/${publisher}/models/${this.modelOptions.model}:serverStreamingPredict`;
  }
  
  setOptions(options) {
    if (this.options && !this.options.replaceOptions) {
      this.options.modelOptions = { ...this.options.modelOptions, ...options.modelOptions };
      delete options.modelOptions;
      this.options = { ...this.options, ...options };
    } else {
      this.options = options;
    }
    this.modelOptions = this.options.modelOptions || {};
    this.options.attachments?.then((attachments) => this.checkVisionRequest(attachments));
    this.isGenerativeModel = /gemini|learnlm|gemma/.test(this.modelOptions.model);
    this.maxContextTokens = this.options.maxContextTokens ?? getModelMaxTokens(this.modelOptions.model, EModelEndpoint.google);
    this.maxResponseTokens = this.modelOptions.maxOutputTokens || settings.maxOutputTokens.default;
    if (this.maxContextTokens > 32000) {
      this.maxContextTokens = this.maxContextTokens - this.maxResponseTokens;
    }
    this.maxPromptTokens = this.options.maxPromptTokens || this.maxContextTokens - this.maxResponseTokens;
    if (this.maxPromptTokens + this.maxResponseTokens > this.maxContextTokens) {
      throw new Error(`maxPromptTokens + maxOutputTokens (${this.maxPromptTokens} + ${this.maxResponseTokens} = ${this.maxPromptTokens + this.maxResponseTokens}) must be less than or equal to maxContextTokens (${this.maxContextTokens})`);
    }
    this.modelOptions.thinkingConfig = { thinkingBudget: (this.modelOptions.thinking ?? googleSettings.thinking.default) ? this.modelOptions.thinkingBudget : 0 };
    delete this.modelOptions.thinking;
    delete this.modelOptions.thinkingBudget;
    this.sender = this.options.sender ?? getResponseSender({
      model: this.modelOptions.model,
      endpoint: EModelEndpoint.google,
      modelLabel: this.options.modelLabel,
    });
    this.userLabel = this.options.userLabel || 'User';
    this.modelLabel = this.options.modelLabel || 'Assistant';
    if (this.options.reverseProxyUrl) {
      this.completionsUrl = this.options.reverseProxyUrl;
    } else {
      this.completionsUrl = this.constructUrl();
    }
    let promptPrefix = (this.options.promptPrefix ?? '').trim();
    if (typeof this.options.artifactsPrompt === 'string' && this.options.artifactsPrompt) {
      promptPrefix = `${promptPrefix ?? ''}\n${this.options.artifactsPrompt}`.trim();
    }
    this.systemMessage = promptPrefix;
    this.initializeClient();
    return this;
  }

  async buildMessages(_messages = [], parentMessageId) {
    logger.info(`[GoogleClient] Received ${_messages.length} pre-formatted messages to build.`);
    
    if (!this.isGenerativeModel && !this.project_id) {
      throw new Error('[GoogleClient] PaLM 2 and Codey models are no longer supported.');
    }
    
    if (this.systemMessage) {
      const instructionsTokenCount = this.getTokenCount(this.systemMessage);
      this.maxContextTokens = this.maxContextTokens - instructionsTokenCount;
      if (this.maxContextTokens < 0) {
        const info = `${instructionsTokenCount} / ${this.maxContextTokens}`;
        const errorMessage = `{ "type": "${ErrorTypes.INPUT_LENGTH}", "info": "${info}" }`;
        logger.warn(`Instructions token count exceeds max context (${info}).`);
        throw new Error(errorMessage);
      }
    }
    
    for (let i = 0; i < _messages.length; i++) {
      const message = _messages[i];
      if (!message.tokenCount) {
        _messages[i].tokenCount = this.getTokenCountForMessage({
          role: message.isCreatedByUser ? 'user' : 'assistant',
          content: message.content ?? message.text,
        });
      }
    }
    
    const { payload: messages, tokenCountMap, promptTokens } = await this.handleContextStrategy({
      orderedMessages: _messages,
      formattedMessages: _messages,
    });
    
    if (!this.project_id && !EXCLUDED_GENAI_MODELS.test(this.modelOptions.model)) {
      const result = await this.buildGenerativeMessages(messages);
      result.tokenCountMap = tokenCountMap;
      result.promptTokens = promptTokens;
      return result;
    }
    
    if (this.options.attachments && this.isGenerativeModel) {
      const result = this.buildVisionMessages(messages, parentMessageId);
      result.tokenCountMap = tokenCountMap;
      result.promptTokens = promptTokens;
      return result;
    }
    
    let payload = { 
      instances: [ 
        { 
          messages: messages
            .map(this.formatMessages())
            .map((msg) => ({ ...msg, role: msg.author === 'User' ? 'user' : 'assistant' }))
            .map((message) => formatMessage({ message, langChain: true })),
        }, 
      ], 
    };
    
    if (this.systemMessage) {
      payload.instances[0].context = this.systemMessage;
    }
    
    logger.debug('[GoogleClient] buildMessages final payload', payload);
    return { prompt: payload, tokenCountMap, promptTokens };
  }

  async getCompletion(_payload, options = {}) {
    const { onProgress, abortController } = options;
    const safetySettings = getSafetySettings(this.modelOptions.model);
    const streamRate = this.options.streamRate ?? Constants.DEFAULT_STREAM_RATE;
    const modelName = this.modelOptions.modelName ?? this.modelOptions.model ?? '';
    let reply = '';
    let error;
    try {
      if (!EXCLUDED_GENAI_MODELS.test(modelName) && !this.project_id) {
        const client = this.client;
        const requestOptions = { 
          safetySettings, 
          contents: _payload, 
          generationConfig: googleGenConfigSchema.parse(this.modelOptions), 
        };
        const promptPrefix = (this.systemMessage ?? '').trim();
        if (promptPrefix.length) {
          requestOptions.systemInstruction = { parts: [ { text: promptPrefix } ] };
        }
        const delay = modelName.includes('flash') ? 8 : 15;
        let usageMetadata;
        abortController.signal.addEventListener('abort', () => { 
          logger.warn('[GoogleClient] Request was aborted', abortController.signal.reason);
        }, { once: true });
        const result = await client.generateContentStream(requestOptions, { signal: abortController.signal });
        for await (const chunk of result.stream) {
          usageMetadata = !usageMetadata ? chunk?.usageMetadata : Object.assign(usageMetadata, chunk?.usageMetadata);
          const chunkText = chunk.text();
          await this.generateTextStream(chunkText, onProgress, { delay });
          reply += chunkText;
          await sleep(streamRate);
        }
        if (usageMetadata) {
          this.usage = { 
            input_tokens: usageMetadata.promptTokenCount, 
            output_tokens: usageMetadata.candidatesTokenCount, 
          };
        }
        return reply;
      }
      const { instances } = _payload;
      const { messages: messages, context } = instances?.[0] ?? {};
      if (!this.isVisionModel && context && messages?.length > 0) {
        messages.unshift(new SystemMessage(context));
      }
      let usageMetadata;
      const client = this.client;
      const stream = await client.stream(messages, { 
        signal: abortController.signal, 
        streamUsage: true, 
        safetySettings, 
      });
      let delay = this.options.streamRate || 8;
      if (!this.options.streamRate) {
        if (this.isGenerativeModel) {
          delay = 15;
        }
        if (modelName.includes('flash')) {
          delay = 5;
        }
      }
      for await (const chunk of stream) {
        if (chunk?.usage_metadata) {
          const metadata = chunk.usage_metadata;
          for (const key in metadata) {
            if (Number.isNaN(metadata[key])) {
              delete metadata[key];
            }
          }
          usageMetadata = !usageMetadata ? metadata : concat(usageMetadata, metadata);
        }
        const chunkText = chunk?.content ?? '';
        await this.generateTextStream(chunkText, onProgress, { delay });
        reply += chunkText;
      }
      if (usageMetadata) {
        this.usage = usageMetadata;
      }
    } catch (e) {
      error = e;
      logger.error('[GoogleClient] There was an issue generating the completion', e);
    }
    if (error != null && reply === '') {
      const errorMessage = `{ "type": "${ErrorTypes.GoogleError}", "info": "${error.message ?? 'The Google provider failed to generate content, please contact the Admin.'}" }`;
      throw new Error(errorMessage);
    }
    return reply;
  }
  
  async sendCompletion(payload, opts = {}) {
    const reply = await this.getCompletion(payload, opts);
    return reply.trim();
  }

  getEncoding() { 
    return 'cl100k_base'; 
  }
  
  getTokenCount(text) { 
    const encoding = this.getEncoding(); 
    return Tokenizer.getTokenCount(text, encoding); 
  }
}

module.exports = GoogleClient;
