// /opt/open-webui/client.js - Финальная версия с исправленной логикой индексации и RAG через tools-gateway
require('events').EventEmitter.defaultMaxListeners = 100;
const { logger } = require('@librechat/data-schemas');
const axios = require('axios');
const { condenseContext: ragCondenseContext } = require('~/server/services/RAG/condense');
const { DynamicStructuredTool } = require('@langchain/core/tools');
const { getBufferString, HumanMessage, SystemMessage } = require('@langchain/core/messages');
const {
  sendEvent,
  createRun,
  Tokenizer,
  checkAccess,
  logAxiosError,
  resolveHeaders,
  getBalanceConfig,
  memoryInstructions,
  formatContentStrings,
  getTransactionsConfig,
  createMemoryProcessor,
} = require('@librechat/api');
const {
  Callback,
  Providers,
  GraphEvents,
  TitleMethod,
  formatMessage,
  formatAgentMessages,
  getTokenCountForMessage,
  createMetadataAggregator,
} = require('@librechat/agents');
const {
  Constants,
  Permissions,
  VisionModes,
  ContentTypes,
  EModelEndpoint,
  PermissionTypes,
  isAgentsEndpoint,
  AgentCapabilities,
  bedrockInputSchema,
  removeNullishValues,
} = require('librechat-data-provider');
const { addCacheControl, createContextHandlers } = require('~/app/clients/prompts');
const { initializeAgent } = require('~/server/services/Endpoints/agents/agent');
const { spendTokens, spendStructuredTokens } = require('~/models/spendTokens');
const { getFormattedMemories, deleteMemory, setMemory } = require('~/models');
const { encodeAndFormat } = require('~/server/services/Files/images/encode');
const { getProviderConfig } = require('~/server/services/Endpoints');
const { checkCapability } = require('~/server/services/Config');
const BaseClient = require('~/app/clients/BaseClient');
const { getRoleByName } = require('~/models/Role');
const { loadAgent } = require('~/models/Agent');
const { getMCPManager } = require('~/config');
const crypto = require('crypto');
const { getRedisClient, publishToRedis } = require('~/utils/rag_redis.js');

async function fetchGraphContext({ conversationId, toolsGatewayUrl, limit = GRAPH_RELATIONS_LIMIT, timeoutMs = GRAPH_REQUEST_TIMEOUT_MS }) {
  if (!USE_GRAPH_CONTEXT || !conversationId) {
    logger.warn('[DIAG-GRAPH] Graph context skipped', {
      useGraphContext: USE_GRAPH_CONTEXT,
      conversationId,
    });
    return null;
  }

  const url = `${toolsGatewayUrl}/neo4j/graph_context`;
  const requestPayload = { conversation_id: conversationId, limit };

  logger.info('[DIAG-GRAPH] Fetching graph context', {
    conversationId,
    toolsGatewayUrl,
    limit,
  });

  try {
    const response = await axios.post(url, requestPayload, { timeout: timeoutMs });

    const lines = Array.isArray(response?.data?.lines) ? response.data.lines : [];
    const queryHint = response?.data?.query_hint ? String(response.data.query_hint) : '';

    logger.info('[DIAG-GRAPH] Graph context response', {
      conversationId,
      url,
      linesCount: lines.length,
      hasHint: Boolean(queryHint),
    });

    if (!lines.length && !queryHint) {
      return null;
    }

    return {
      lines: lines.slice(0, GRAPH_CONTEXT_LINE_LIMIT),
      queryHint,
    };
  } catch (error) {
    const serializedError = {
      message: error?.message,
      code: error?.code,
      stack: error?.stack,
      responseStatus: error?.response?.status,
      responseData: error?.response?.data,
      requestConfig: error?.config
        ? {
            url: error.config.url,
            method: error.config.method,
            timeout: error.config.timeout,
            data: error.config.data,
          }
        : null,
    };

    logger.error('[DIAG-GRAPH] Failed to fetch graph context', serializedError);

    try {
      if (typeof error?.toJSON === 'function') {
        logger.error('[DIAG-GRAPH] Axios error JSON', error.toJSON());
      }
    } catch (jsonErr) {
        logger.warn('[DIAG-GRAPH] Failed to serialize axios error', {
          message: jsonErr?.message,
          stack: jsonErr?.stack,
        });
    }

    return null;
  }
}

async function mapReduceContext({ req, res, endpointOption, contextText, userQuery, graphContext = null }) {
  const SUMMARIZER_MODEL = process.env.GOOGLE_SUMMARY_MODEL || 'gemini-2.5-flash';
  const USE_OLLAMA_FOR_SUMMARIZATION =
    (process.env.USE_OLLAMA_FOR_SUMMARIZATION || 'false').toLowerCase() === 'true';
  const OLLAMA_SUMMARIZATION_URL =
    process.env.OLLAMA_SUMMARIZATION_URL || process.env.OLLAMA_URL || 'http://172.16.15.219:11434';
  const OLLAMA_SUMMARIZATION_MODEL_NAME =
    process.env.OLLAMA_SUMMARIZATION_MODEL_NAME ||
    process.env.OLLAMA_ENTITY_EXTRACTION_MODEL_NAME ||
    'gemma:7b-instruct';

  logger.info(
    `[DIAG-RAG-MR] Starting Map-Reduce. Context: ${contextText.length}, Model: ${
      USE_OLLAMA_FOR_SUMMARIZATION ? OLLAMA_SUMMARIZATION_MODEL_NAME : SUMMARIZER_MODEL
    }`,
  );

  let finalContext = contextText;

  if (USE_OLLAMA_FOR_SUMMARIZATION) {
    try {
      const ollamaPayload = {
        model: OLLAMA_SUMMARIZATION_MODEL_NAME,
        messages: [
          {
            role: 'system',
            content:
              'Ты — эксперт по суммаризации текста. Сделай максимально полную, но компактную выжимку без потерь смыслов, цифр, дат, имён. Одним абзацем, не длиннее 7 предложений. Выдавай ТОЛЬКО текст суммаризации. Никакого дополнительного текста.',
          },
          {
            role: 'user',
            content: `Суммаризируй следующий текст. Запрос пользователя: ${userQuery || '(нет)'}

${
              graphContext ? `Графовые подсказки: ${graphContext.queryHint || 'нет'}` : ''
            }${
              graphContext && graphContext.lines && graphContext.lines.length
                ? `
Графовые связи:
${graphContext.lines.join('\n')}`
                : ''
            }

Текст:
---
${contextText}
---`,
          },
        ],
        stream: false,
        options: {
          temperature: 0.2,
        },
      };

      const response = await axios.post(`${OLLAMA_SUMMARIZATION_URL}/api/chat`, ollamaPayload, {
        timeout: 180000,
      });

      if (response.data && response.data.message && response.data.message.content) {
        finalContext = response.data.message.content;
        logger.info(
          `[DIAG-RAG-MR] Successfully summarized context using Ollama. Final context length: ${finalContext.length}`,
        );
      } else {
        logger.warn(
          `[DIAG-RAG-MR] Ollama summarization failed or returned empty. Falling back to raw context. Response: ${JSON.stringify(
            response.data,
          )}`,
        );
      }
    } catch (e) {
      logger.error(
        `[DIAG-RAG-MR] Ollama summarization error: ${e.message}. Falling back to raw context.`,
        e,
      );
    }
  } else {
    const summarizerEndpointOption = {
      ...endpointOption,
      modelOptions: {
        ...(endpointOption?.modelOptions || endpointOption?.model_parameters || {}),
        model: SUMMARIZER_MODEL,
        streaming: false,
      },
    };

    try {
      finalContext = await ragCondenseContext({
        req,
        res,
        endpointOption: summarizerEndpointOption,
        contextText,
        userQuery,
        budgetChars: parseInt(process.env.RAG_SUMMARY_BUDGET || '12000', 10),
        chunkChars: parseInt(process.env.RAG_CHUNK_CHARS || '20000', 10),
        graphContext,
      });
      logger.info(
        `[DIAG-RAG-MR] Finished Map-Reduce using Vertex AI. Final context length: ${finalContext.length}`,
      );
    } catch (e) {
      logger.error(`[DIAG-RAG-MR] Vertex AI Map-Reduce failed: ${e.message}. Falling back to raw context.`, e);
    }
  }

  return finalContext;
}

const omitTitleOptions = new Set([
  'stream',
  'thinking',
  'streaming',
  'clientOptions',
  'thinkingConfig',
  'thinkingBudget',
  'includeThoughts',
  'maxOutputTokens',
  'additionalModelRequestFields',
]);

const DEBUG_SSE = (process.env.DEBUG_SSE || 'false').toLowerCase() === 'true';
function canWrite(res) {
  return Boolean(res) && res.writable !== false && !res.writableEnded;
}
function sseDebug(res, payload) {
  if (!DEBUG_SSE) return;
  try {
    if (canWrite(res)) {
      res.write(`event: message\ndata: ${JSON.stringify({ event: 'debug', data: payload })}\n\n`);
    }
  } catch (_) {}
}

const IngestedHistory = new Set();
const HIST_LONG_USER_TO_RAG = parseInt(process.env.HIST_LONG_USER_TO_RAG || '20000', 10);
const OCR_TO_RAG_THRESHOLD = parseInt(process.env.OCR_TO_AG_THRESHOLD || '15000', 10);
const WAIT_FOR_RAG_INGEST_MS = parseInt(process.env.WAIT_FOR_RAG_INGEST_MS || '0', 10);
const ASSIST_LONG_TO_RAG = parseInt(process.env.ASSIST_LONG_TO_RAG || '15000', 10);
const ASSIST_SNIPPET_CHARS = parseInt(process.env.ASSIST_SNIPPET_CHARS || '1500', 10);
const RAG_INGEST_MARK_TTL = parseInt(process.env.RAG_INGEST_MARK_TTL || '2592000', 10);
const GOOGLE_CHAIN_BUFFER = (process.env.GOOGLE_CHAIN_BUFFER || 'off').toLowerCase();
const GEMINI_CHAIN_WINDOW = parseInt(process.env.GEMINI_CHAIN_WINDOW || '5', 10);
const USE_GRAPH_CONTEXT = (process.env.USE_GRAPH_CONTEXT || 'true').toLowerCase() !== 'false';
const GRAPH_RELATIONS_LIMIT = parseInt(process.env.GRAPH_RELATIONS_LIMIT || '40', 10);
const GRAPH_CONTEXT_LINE_LIMIT = parseInt(process.env.GRAPH_CONTEXT_LINE_LIMIT || '20', 10);
const GRAPH_REQUEST_TIMEOUT_MS = parseInt(process.env.GRAPH_REQUEST_TIMEOUT_MS || '10000', 10);
const GRAPH_QUERY_HINT_MAX_CHARS = parseInt(process.env.GRAPH_QUERY_HINT_MAX_CHARS || '2000', 10);


function makeIngestKey(convId, msgId, raw) {
  if (msgId) return `ing:${convId}:${msgId}`;
  const hash = crypto.createHash('md5').update(String(raw || '')).digest('hex');
  return `ing:${convId}:${hash}`;
}

function isGoogleModel(agent) {
  const model = agent?.model_parameters?.model || agent?.model || '';
  return agent?.provider === Providers.GOOGLE || /gemini/i.test(model);
}

const payloadParser = ({ req, agent, endpoint }) => {
  if (isAgentsEndpoint(endpoint)) {
    return { model: undefined };
  } else if (endpoint === EModelEndpoint.bedrock) {
    const parsedValues = bedrockInputSchema.parse(agent.model_parameters);
    if (parsedValues.thinking == null) {
      parsedValues.thinking = false;
    }
    return parsedValues;
  }
  return req.body.endpointOption.model_parameters;
};

const noSystemModelRegex = [/\b(o1-preview|o1-mini|amazon\.titan-text)\b/gi];

function createTokenCounter(encoding) {
  return function (message) {
    const countTokens = (text) => Tokenizer.getTokenCount(text, encoding);
    return getTokenCountForMessage(message, countTokens);
  };
}

function logToolError(graph, error, toolId) {
  logAxiosError({
    error,
    message: `[api/server/controllers/agents/client.js #chatCompletion] Tool Error "${toolId}"`,
  });
}

class AgentClient extends BaseClient {
  constructor(options = {}) {
    super(null, options);
    this.clientName = EModelEndpoint.agents;
    this.contextStrategy = 'discard';
    this.isChatCompletion = true;
    this.run;

    const {
      agentConfigs,
      contentParts,
      collectedUsage,
      artifactPromises,
      maxContextTokens,
      ...clientOptions
    } = options;

    this.agentConfigs = agentConfigs;
    this.maxContextTokens = maxContextTokens;
    if (!this.maxContextTokens) this.maxContextTokens = 32000;
    this.contentParts = contentParts;
    this.collectedUsage = collectedUsage;
    this.artifactPromises = artifactPromises;
    this.options = Object.assign({ endpoint: options.endpoint }, clientOptions);
    this.model = this.options.agent.model_parameters.model;
    this.inputTokensKey = 'input_tokens';
    this.outputTokensKey = 'output_tokens';
    this.usage;
    this.indexTokenCountMap = {};
    this.processMemory;
    const TRACE_PIPELINE = (process.env.TRACE_PIPELINE || 'false').toLowerCase() === 'true';
    this.trace = (label, data = {}) => {
      try {
        if (!TRACE_PIPELINE) return;
        const meta = { label, cid: this.conversationId, rid: this.responseMessageId, pid: process.pid };
        const safe = (v) => {
          try {
            if (typeof v === 'string' && v.length > 500) return v.slice(0,250) + ' … ' + v.slice(-150);
            return v;
          } catch { return v; }
        };
        const cleaned = {};
        for (const [k, v] of Object.entries(data || {})) cleaned[k] = safe(v);
        const { logger } = require('@librechat/data-schemas');
        logger.info(`[trace] ${JSON.stringify(Object.assign(meta, cleaned))}`);
      } catch {}
    };
  }

  getContentParts() {
    return this.contentParts;
  }

  setOptions(options) {
    logger.info('[api/server/controllers/agents/client.js] setOptions', options);
  }

  checkVisionRequest() {}

  getSaveOptions() {
    let runOptions = {};
    try {
      runOptions = payloadParser(this.options);
    } catch (error) {
      logger.error(
        '[api/server/controllers/agents/client.js #getSaveOptions] Error parsing options',
        error,
      );
    }

    return removeNullishValues(
      Object.assign(
        {
          endpoint: this.options.endpoint,
          agent_id: this.options.agent.id,
          modelLabel: this.options.modelLabel,
          maxContextTokens: this.options.maxContextTokens,
          resendFiles: this.options.resendFiles,
          imageDetail: this.options.imageDetail,
          spec: this.options.spec,
          iconURL: this.options.iconURL,
        },
        runOptions,
      ),
    );
  }

  getBuildMessagesOptions() {
    return {
      instructions: this.options.agent.instructions,
      additional_instructions: this.options.agent.additional_instructions,
    };
  }

  async addImageURLs(message, attachments) {
    const { files, text: ocrText, image_urls } = await encodeAndFormat(
      this.options.req,
      attachments,
      this.options.agent.provider,
      VisionModes.agents,
    );

    const RAG_QUEUE = process.env.REDIS_MEMORY_QUEUE_NAME;
    const convId = this.options.req.body.conversationId;
    const userId = this.options.req.user.id;

    const isTextFile = files && files.length > 0 && files[0].type && files[0].type.startsWith('text/');
    const isLargeEnough = ocrText && ocrText.length > (OCR_TO_RAG_THRESHOLD ?? 15000);

    if (isTextFile && isLargeEnough) {
      if (RAG_QUEUE && convId && userId) {
        const file = files[0];
        const task = {
            type: 'index_file',
            payload: {
                user_id: userId,
                file_id: file.file_id,
                text_content: ocrText
            }
        };

        const K = `ingest:file:${file.file_id}`;
        try {
            const r = typeof getRedisClient === 'function' ? getRedisClient() : null;
            let shouldEnqueue = true;
            if (r) {
                const ttl = parseInt(RAG_INGEST_MARK_TTL, 10) || 2592000;
                const exists = await r.exists(K);
                logger.info(`[dedup][diag] Checking key ${K}. Exists: ${exists}`);
                const ok = await r.set(K, '1', 'EX', ttl, 'NX');
                logger.info(`[dedup][diag] Ran SET NX for key ${K}. Result (ok): ${JSON.stringify(ok)}`);
                shouldEnqueue = !!ok;
            }

            if (shouldEnqueue) {
                await publishToRedis(RAG_QUEUE, [task]);
                logger.info(`[file-ingest] Queued INDEX_FILE task for file_id ${file.file_id}`);
            } else {
                logger.info(`[file-ingest][dedup] Skipping file_id ${file.file_id}`);
            }
        } catch (e) {
            logger.error(`[file-ingest] Failed to queue file task for ${file.file_id}`, e);
        }
      }
    } else if (image_urls && image_urls.length > 0) {
      message.image_urls = image_urls;
    }

    return files;
  }

  async buildMessages(
    messages,
    parentMessageId,
    { instructions = null, additional_instructions = null },
    opts,
  ) {
    let orderedMessages = this.constructor.getMessagesForConversation({
      messages,
      parentMessageId,
      summary: this.shouldSummarize,
    });
    try { this.trace('trace:build.start', {
      total: orderedMessages.length,
      lastIds: orderedMessages.slice(-3).map(m => m && m.messageId).join(',')
    }); } catch {}

    try {
      const RAG_QUEUE = process.env.REDIS_MEMORY_QUEUE_NAME;
      const { RAG_INGEST_MARK_TTL } = this.options.req.app.locals.config || {};
      const convId = this.conversationId || this.options?.req?.body?.conversationId;
      const userId = this.options?.req?.user?.id;

      const toIngest = [];
      const r = typeof getRedisClient === 'function' ? getRedisClient() : null;

      for (let idx = 0; idx < orderedMessages.length; idx++) {
        const m = orderedMessages[idx];
        try {
          const rawText =
            m?.text ||
            (Array.isArray(m?.content)
              ? m.content
                  .filter((p) => p && p.type === 'text' && p.text)
                  .map((p) => p.text)
                  .join('\n')
              : '');
          const len = (rawText || '').length;

          const looksHTML =
            /<\/?[a-z][\s\S]*?>/i.test(rawText || '') &&
            /<html|<body|<div|<p|<span/i.test(rawText || '');

          let hasThink = false;
          if (Array.isArray(m?.content)) {
            hasThink = m.content.some((p) => p?.type === 'think' && p.think && p.think.length > 0);
          }
          if (!hasThink) {
            const t = rawText || '';
            hasThink = /(^|\n)\s*(Мысли|Рассуждения|Thoughts|Chain of Thought)\s*:/i.test(t);
          }

          const shouldShrinkUser = m?.isCreatedByUser && (len > HIST_LONG_USER_TO_RAG || looksHTML);
          const shouldShrinkAssistant = !m?.isCreatedByUser && (len > ASSIST_LONG_TO_RAG || looksHTML || hasThink);

          if ((shouldShrinkUser || shouldShrinkAssistant) && RAG_QUEUE && convId && userId && rawText) {
            const K = makeIngestKey(convId, m.messageId, rawText);
            let shouldAdd = true;

            if (IngestedHistory.has(K)) {
              shouldAdd = false;
            } else if (r) {
              try {
                const ttl = parseInt(RAG_INGEST_MARK_TTL, 10) || 2592000;
                const ok = await r.set(K, '1', 'EX', ttl, 'NX');
                shouldAdd = !!ok;
              } catch (e) {
                logger.warn('[dedup][hist] redis error', e);
              }
            }

            if (shouldAdd) {
              IngestedHistory.add(K);
              toIngest.push({
                message_id: m.messageId || `hist-${idx}-${Date.now()}`,
                content: rawText,
                role: m?.isCreatedByUser ? 'user' : 'assistant',
                user_id: userId,
              });
            }

            const snippetLen = m?.isCreatedByUser ? 2000 : ASSIST_SNIPPET_CHARS;
            const snippet = rawText.slice(0, snippetLen);
            const roleTag = m?.isCreatedByUser ? 'user' : 'assistant';
            m.text = `[[moved_to_memory:RAG,len=${len},role=${roleTag}]]\n\n${snippet}`;
            if (Array.isArray(m?.content)) { m.content = [{ type: 'text', text: m.text }]; }

            logger.info(`[prompt][shrink] idx=${idx}, role=${roleTag}, len=${len} -> ${snippet.length}`);
          }
        } catch (e) {
          logger.warn('[history->RAG] error while scanning message', e);
        }
      }

      if (toIngest.length) {
        const tasks = toIngest.map((t) => ({
          type: 'add_turn',
          payload: {
            conversation_id: convId,
            message_id: t.message_id,
            role: t.role,
            content: t.content,
            user_id: t.user_id,
          },
        }));
        await publishToRedis(RAG_QUEUE, tasks);
        logger.info(`[history->RAG] queued ${tasks.length} turn(s) from history (user+assistant)`);
      }
    } catch (e) {
      logger.error('[history->RAG] failed', e);
    }

    let systemContent = [instructions ?? '', additional_instructions ?? '']
      .filter(Boolean)
      .join('\n')
      .trim();
    logger.info(`[DIAG-PROMPT] Initial systemContent (from instructions/additional_instructions): ${systemContent.length} chars`);

    const useRagMemory = process.env.USE_CONVERSATION_MEMORY === 'true';
    let ragContextLength = 0;
    if (useRagMemory && this.conversationId) {
        const lastUserMessage = orderedMessages[orderedMessages.length - 1];
        const userQuery = lastUserMessage ? lastUserMessage.text : '';
        logger.info(`[DIAG-RAG] Starting RAG context retrieval for query (len=${userQuery.length}): "${userQuery.substring(0, 150)}..."`);

        const TOOLS_GATEWAY_URL = process.env.TOOLS_GATEWAY_URL || 'http://10.10.23.1:8000';
        const RAG_SEARCH_MODEL = process.env.RAG_SEARCH_MODEL || 'mxbai';
        let graphContext = null;
        let graphContextLines = [];
        let graphQueryHint = '';

        if (TOOLS_GATEWAY_URL && this.conversationId) {
            try {
                graphContext = await fetchGraphContext({
                    conversationId: this.conversationId,
                    toolsGatewayUrl: TOOLS_GATEWAY_URL,
                });
            } catch (graphError) {
                logger.error('[DIAG-GRAPH] Unexpected error while fetching graph context:', graphError?.response?.data || graphError?.message || graphError);
            }

            if (graphContext?.lines?.length) {
                graphContextLines = graphContext.lines;
                logger.info(`[DIAG-GRAPH] Retrieved ${graphContextLines.length} graph relations for conversation ${this.conversationId}.`);
            }

            if (graphContext?.queryHint) {
                graphQueryHint = graphContext.queryHint;
            }
        }

        const graphContextPayload = (graphContextLines.length || graphQueryHint)
            ? { lines: graphContextLines, queryHint: graphQueryHint }
            : null;

        let ragContext = '';
        const ragSearchQuery = graphQueryHint
            ? `${userQuery}\n\nGraph hints: ${graphQueryHint}`
            : userQuery;

        if (TOOLS_GATEWAY_URL && userQuery) {
            try {
                const hasFiles = this.options.req.body.files && this.options.req.body.files.length > 0;
                const searchScope = hasFiles ? 'all_sources' : 'conversation';
                logger.info(`[DIAG-RAG] Using search_scope: ${searchScope}`);

                const response = await axios.post(
                    `${TOOLS_GATEWAY_URL}/rag/search`,
                    {
                        query: ragSearchQuery,
                        top_k: parseInt(process.env.RAG_CONTEXT_TOPK || '12', 10),
                        embedding_model: RAG_SEARCH_MODEL,
                        conversation_id: this.conversationId,
                        user_id: this.options?.req?.user?.id,
                    },
                    { timeout: 20000 }
                );
                logger.info('[DIAG-RAG] Successfully retrieved context from tools-gateway.');
                const ctx = Array.isArray(response.data?.results) ? response.data.results : [];
                ragContext = ctx.map((chunk) => chunk.content).join('\n\n');
            } catch (error) {
                logger.error('[DIAG-RAG] Failed to retrieve context from tools-gateway:', error.response ? error.response.data : error.message);
            }
        } else if (!TOOLS_GATEWAY_URL) {
            logger.warn('[DIAG-RAG] Skipping context retrieval: TOOLS_GATEWAY_URL is missing.');
        } else {
            logger.warn('[DIAG-RAG] Skipping context retrieval: user query is missing.');
        }

        let extraContextBlocks = '';

        if (graphContextLines.length) {
            const graphBlock = `### Graph context\n${graphContextLines.join('\n')}\n\n`;
            extraContextBlocks += graphBlock;
            logger.info(`[DIAG-GRAPH] Injected graph context (lines=${graphContextLines.length}) into system instructions.`);
        }

        if (ragContext) {
            const SUM_IF_OVER = Number(process.env.RAG_SUMMARIZE_IF_OVER || '20000');
            let ctxToUse = ragContext;
            if (ragContext.length > SUM_IF_OVER) {
                logger.warn(`[DIAG-RAG] Context too large (${ragContext.length}), attempting Map-Reduce...`);
                try {
                    ctxToUse = await mapReduceContext({
                        req: this.options.req,
                        res: this.options.res,
                        endpointOption: this.options.req.body.endpointOption,
                        contextText: ragContext,
                        userQuery: userQuery,
                        graphContext: graphContextPayload,
                    });
                } catch (e) {
                    logger.error('[DIAG-RAG] Map-Reduce failed, using raw context as fallback.', e);
                }
            }

            ragContextLength = ctxToUse.length;
            const vectorBlock = `### Vector context\n${ctxToUse}\n\n`;
            extraContextBlocks += vectorBlock;
            logger.info(`[DIAG-RAG] Prepared vector context (len=${ctxToUse.length}) for system instructions.`);
        }

        if (extraContextBlocks) {
            //const stitchedBlock = `Using the following context, answer the user's query.\n\n${extraContextBlocks}---\n\n`;
            const stitchedBlock = `Ниже предоставлен внутренний контекст для твоего сведения: граф знаний и выдержки из беседы. Используй эти данные для формирования точного и полного ответа. Категорически запрещается цитировать или пересказывать этот контекст, особенно строки, содержащие "-->". Эта информация предназначена только для твоего внутреннего анализа.\n\n${extraContextBlocks}---\n\n`;
	    systemContent = stitchedBlock + systemContent;
        }

    }

    let payload;
    let promptTokens;
    let tokenCountMap = {};

    if (this.options.attachments) {
      const attachments = await this.options.attachments;

      if (this.message_file_map) {
        this.message_file_map[orderedMessages[orderedMessages.length - 1].messageId] = attachments;
      } else {
        this.message_file_map = {
          [orderedMessages[orderedMessages.length - 1].messageId]: attachments,
        };
      }

      const files = await this.addImageURLs(
        orderedMessages[orderedMessages.length - 1],
        attachments,
      );

      this.options.attachments = files;
    }

    if (this.message_file_map && !isAgentsEndpoint(this.options.endpoint)) {
      this.contextHandlers = createContextHandlers(
        this.options.req,
        orderedMessages[orderedMessages.length - 1].text,
      );
    }

    const formattedMessages = orderedMessages.map((message, i) => {
      const formattedMessage = formatMessage({
        message,
        userName: this.options?.name,
        assistantName: this.options?.modelLabel,
      });

      if (message.ocr && i !== orderedMessages.length - 1) {
        if (typeof formattedMessage.content === 'string') {
          formattedMessage.content = message.ocr + '\n' + formattedMessage.content;
        } else {
          const textPart = formattedMessage.content.find((part) => part.type === 'text');
          textPart
            ? (textPart.text = message.ocr + '\n' + textPart.text)
            : formattedMessage.content.unshift({ type: 'text', text: message.ocr });
        }
      } else if (message.ocr && i === orderedMessages.length - 1) {
        systemContent = [systemContent, message.ocr].join('\n');
      }

      const needsTokenCount =
        (this.contextStrategy && !orderedMessages[i].tokenCount) || message.ocr;

      if (needsTokenCount || (this.isVisionModel && (message.image_urls || message.files))) {
        orderedMessages[i].tokenCount = this.getTokenCountForMessage(formattedMessage);
      }

      if (this.message_file_map && this.message_file_map[message.messageId]) {
        const attachments = this.message_file_map[message.messageId];
        for (const file of attachments) {
          if (file.embedded) {
            this.contextHandlers?.processFile(file);
            continue;
          }
        }
      }

      return formattedMessage;
    });

    if (this.contextHandlers) {
      this.augmentedPrompt = await this.contextHandlers.createContext();
      systemContent = this.augmentedPrompt + systemContent;
    }

    if (systemContent) {
      instructions = {
        content: systemContent,
        tokenCount: this.getTokenCountForMessage({ content: systemContent, role: 'system' })
      };
      logger.info(`[DIAG-PROMPT] Final instructions object created. Length: ${instructions.content.length}, Tokens: ${instructions.tokenCount}`);
    } else {
      instructions = { content: '', tokenCount: 0 };
    }

    this.options.req.ragContextLength = ragContextLength;

    if (this.contextStrategy) {
      ({ payload, promptTokens, tokenCountMap, messages } = await this.handleContextStrategy({
        orderedMessages,
        formattedMessages,
        instructions,
      }));
    }

    for (let i = 0; i < messages.length; i++) {
      this.indexTokenCountMap[i] = messages[i].tokenCount;
    }

    const result = {
      tokenCountMap,
      prompt: payload,
      promptTokens,
      messages,
    };

    if (promptTokens >= 0 && typeof opts?.getReqData === 'function') {
      opts.getReqData({ promptTokens });
    }

    const withoutKeys = await this.useMemory();
    if (withoutKeys) {
      logger.warn('[DIAG-PROMPT] Memory (withoutKeys) generated but not explicitly added to prompt, as system message already formed.');
    }

    return result;
  }

  async awaitMemoryWithTimeout(memoryPromise, timeoutMs = 3000) {
    if (!memoryPromise) {
      return;
    }

    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Memory processing timeout')), timeoutMs),
      );

      const attachments = await Promise.race([memoryPromise, timeoutPromise]);
      return attachments;
    } catch (error) {
      if (error.message === 'Memory processing timed out') {
        logger.warn('[AgentClient] Memory processing timed out after 3 seconds');
      } else {
        logger.error('[AgentClient] Error processing memory:', error);
      }
      return;
    }
  }

  async useMemory() {
    const user = this.options.req.user;
    if (user.personalization?.memories === false) {
      return;
    }
    const hasAccess = await checkAccess({
      user,
      permissionType: PermissionTypes.MEMORIES,
      permissions: [Permissions.USE],
      getRoleByName,
    });

    if (!hasAccess) {
      logger.debug(
        `[api/server/controllers/agents/client.js #useMemory] User ${user.id} does not have USE permission for memories`,
      );
      return;
    }
    const appConfig = this.options.req.config;
    const memoryConfig = appConfig.memory;
    if (!memoryConfig || memoryConfig.disabled === true) {
      return;
    }

    let prelimAgent;
    const allowedProviders = new Set(
      appConfig?.endpoints?.[EModelEndpoint.agents]?.allowedProviders,
    );
    try {
      if (memoryConfig.agent?.id != null && memoryConfig.agent.id !== this.options.agent.id) {
        prelimAgent = await loadAgent({
          req: this.options.req,
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
      logger.error(
        '[api/server/controllers/agents/client.js #useMemory] Error loading agent for memory',
        error,
      );
    }

    const agent = await initializeAgent({
      req: this.options.req,
      res: this.options.res,
      agent: prelimAgent,
      allowedProviders,
      endpointOption: {
        endpoint:
          prelimAgent.id !== Constants.EPHEMERAL_AGENT_ID
            ? EModelEndpoint.agents
            : memoryConfig.agent?.provider,
      },
    });

    if (!agent) {
      logger.warn(
        '[api/server/controllers/agents/client.js #useMemory] No agent found for memory',
        memoryConfig,
      );
      return;
    }

    const llmConfig = Object.assign(
      {
        provider: agent.provider,
        model: agent.model,
      },
      agent.model_parameters,
    );

    const config = {
      validKeys: memoryConfig.validKeys,
      instructions: agent.instructions,
      llmConfig,
      tokenLimit: memoryConfig.tokenLimit,
    };

    const userId = this.options.req.user.id + '';
    const messageId = this.responseMessageId + '';
    const conversationId = this.conversationId + '';
    const [withoutKeys, processMemory] = await createMemoryProcessor({
      userId,
      config,
      messageId,
      conversationId,
      memoryMethods: {
        setMemory,
        deleteMemory,
        getFormattedMemories,
      },
      res: this.options.res,
    });

    this.processMemory = processMemory;
    return withoutKeys;
  }

  filterImageUrls(message) {
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

  async runMemory(messages) {
    try {
      if (this.processMemory == null) {
        return;
      }
      const appConfig = this.options.req.config;
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

      const filteredMessages = messagesToProcess.map((msg) => this.filterImageUrls(msg));
      const bufferString = getBufferString(filteredMessages);
      const bufferMessage = new HumanMessage(`# Current Chat:\n\n${bufferString}`);
      return await this.processMemory([bufferMessage]);
    } catch (error) {
      logger.error('Memory Agent failed to process memory', error);
    }
  }

  async sendCompletion(payload, opts = {}) {
    await this.chatCompletion({
      payload,
      onProgress: opts.onProgress,
      userMCPAuthMap: opts.userMCPAuthMap,
      abortController: opts.abortController,
    });
    return this.contentParts;
  }

  async recordCollectedUsage({
    model,
    balance,
    transactions,
    context = 'message',
    collectedUsage = this.collectedUsage,
  }) {
    if (!collectedUsage || !collectedUsage.length) {
      return;
    }
    const input_tokens =
      (collectedUsage[0]?.input_tokens || 0) +
      (Number(collectedUsage[0]?.input_token_details?.cache_creation) || 0) +
      (Number(collectedUsage[0]?.input_token_details?.cache_read) || 0);

    let output_tokens = 0;
    let previousTokens = input_tokens;
    for (let i = 0; i < collectedUsage.length; i++) {
      const usage = collectedUsage[i];
      if (!usage) {
        continue;
      }

      const cache_creation = Number(usage.input_token_details?.cache_creation) || 0;
      const cache_read = Number(usage.input_token_details?.cache_token_details?.cache_read) || 0;

      const txMetadata = {
        context,
        balance,
        transactions,
        conversationId: this.conversationId,
        user: this.user ?? this.options.req.user?.id,
        endpointTokenConfig: this.options.endpointTokenConfig,
        model: usage.model ?? model ?? this.model ?? this.options.agent.model_parameters.model,
      };

      if (i > 0) {
        output_tokens +=
          (Number(usage.input_tokens) || 0) + cache_creation + cache_read - previousTokens;
      }

      output_tokens += Number(usage.output_tokens) || 0;
      previousTokens += Number(usage.output_tokens) || 0;

      if (cache_creation > 0 || cache_read > 0) {
        spendStructuredTokens(txMetadata, {
          promptTokens: {
            input: usage.input_tokens,
            write: cache_creation,
            read: cache_read,
          },
          completionTokens: usage.output_tokens,
        }).catch((err) => {
          logger.error(
            '[api/server/controllers/agents/client.js #recordCollectedUsage] Error spending structured tokens',
            err,
          );
        });
        continue;
      }
      spendTokens(txMetadata, {
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
      }).catch((err) => {
        logger.error(
          '[api/server/controllers/agents/client.js #recordCollectedUsage] Error spending tokens',
          err,
        );
      });
    }

    this.usage = {
      input_tokens,
      output_tokens,
    };
  }

  getStreamUsage() {
    return this.usage;
  }

  getTokenCountForResponse({ content }) {
    return this.getTokenCountForMessage({
      role: 'assistant',
      content,
    });
  }

  calculateCurrentTokenCount({ tokenCountMap, currentMessageId, usage }) {
    const originalEstimate = tokenCountMap[currentMessageId] || 0;

    if (!usage || typeof usage[this.inputTokensKey] !== 'number') {
      return originalEstimate;
    }

    tokenCountMap[currentMessageId] = 0;
    const totalTokensFromMap = Object.values(tokenCountMap).reduce((sum, count) => {
      const numCount = Number(count);
      return sum + (isNaN(numCount) ? 0 : numCount);
    }, 0);
    const totalInputTokens = usage[this.inputTokensKey] ?? 0;

    const currentMessageTokens = totalInputTokens - totalTokensFromMap;
    return currentMessageTokens > 0 ? currentMessageTokens : originalEstimate;
  }

  async chatCompletion({ payload, userMCPAuthMap, abortController = null }) {
    let config;
    let run;
    let memoryPromise;
    try {
      if (!abortController) {
        abortController = new AbortController();
      }

      const req = this.options?.req;
      const res = this.options?.res;
      const onClientAbort = () => {
        try {
          abortController.abort();
        } catch {}
      };
      if (req && typeof req.once === 'function') req.once('aborted', onClientAbort);
      if (res && typeof res.once === 'function') res.once('close', onClientAbort);

      const appConfig = this.options.req.config;
      const agentsEConfig = appConfig.endpoints?.[EModelEndpoint.agents];

      config = {
        configurable: {
          thread_id: this.conversationId,
          last_agent_index: this.agentConfigs?.size ?? 0,
          user_id: this.user ?? this.options.req.user?.id,
          hide_sequential_outputs: this.options.agent.hide_sequential_outputs,
          requestBody: {
            messageId: this.responseMessageId,
            conversationId: this.conversationId,
            parentMessageId: this.parentMessageId,
          },
          user: this.options.req.user,
        },
        recursionLimit: agentsEConfig?.recursionLimit ?? 25,
        signal: abortController.signal,
        streamMode: 'values',
        version: 'v2',
      };

      const toolSet = new Set((this.options.agent.tools ?? []).map((tool) => tool && tool.name));
      let { messages: initialMessages, indexTokenCountMap } = formatAgentMessages(
        payload,
        this.indexTokenCountMap,
        toolSet,
      );

      try {
        const summarizeMsg = (m) => {
          let len = 0;
          if (typeof m.content === 'string') len = m.content.length;
          else if (Array.isArray(m.content)) {
            for (const part of m.content) {
              if (part && part.type === 'text' && typeof part.text === 'string') len += part.text.length;
            }
          }
          const role = typeof m._getType === 'function' ? m._getType() : m.role || 'unknown';
          return { role, len };
        };
        const diag = initialMessages.map(summarizeMsg);
        const top = [...diag].map((d, i) => ({ i, ...d })).sort((a, b) => b.len - a.len).slice(0, 5);
        logger.debug(`[diag][fmt] messages=${diag.length}, top=${top.map((t) => `#${t.i}:${t.role}:${t.len}`).join(', ')}`);
      } catch (e) {
        logger.error('[diag][fmt] log error', e);
      }

      const runAgent = async (agent, _messages, i = 0, contentData = [], _currentIndexCountMap) => {
        try {
          this.trace('trace:agent.run', {
            provider: agent?.provider,
            model: agent?.model_parameters?.model,
            chainWindow: process.env.GEMINI_CHAIN_WINDOW || 'default',
            chainBuffer: process.env.GOOGLE_CHAIN_BUFFER || 'off',
            step: i
          });
        } catch {}
        config.configurable.model = agent.model_parameters.model;
        const currentIndexCountMap = _currentIndexCountMap ?? indexTokenCountMap;
        if (i > 0) {
          this.model = agent.model_parameters.model;
        }
        if (i > 0 && config.signal == null) {
          config.signal = abortController.signal;
        }
        if (agent.recursion_limit && typeof agent.recursion_limit === 'number') {
          config.recursionLimit = agent.recursion_limit;
        }
        if (agentsEConfig?.maxRecursionLimit && config.recursionLimit > agentsEConfig?.maxRecursionLimit) {
          config.recursionLimit = agentsEConfig?.maxRecursionLimit;
        }
        config.configurable.agent_id = agent.id;
        config.configurable.name = agent.name;
        config.configurable.agent_index = i;
        const noSystemMessages = noSystemModelRegex.some((regex) => agent.model_parameters.model.match(regex));

        const systemMessage = Object.values(agent.toolContextMap ?? {})
          .join('\n')
          .trim();

        let instructionsForLangChain = null;
        if (typeof agent.instructions === 'string' && agent.instructions.length > 0) {
            instructionsForLangChain = new SystemMessage({ content: agent.instructions });
        } else if (agent.instructions instanceof SystemMessage) {
            instructionsForLangChain = agent.instructions;
        }

        let systemContent = [systemMessage, instructionsForLangChain?.content ?? '', i !== 0 ? agent.additional_instructions ?? '' : '']
          .filter(Boolean)
          .join('\n')
          .trim();

        if (noSystemMessages === true) {
          agent.instructions = undefined;
          agent.additional_instructions = undefined;
        } else {
          if (systemContent && (instructionsForLangChain?.content !== systemContent || !instructionsForLangChain)) {
             agent.instructions = new SystemMessage({ content: systemContent });
          } else if (!systemContent) {
             agent.instructions = null;
          }
          agent.additional_instructions = undefined;
        }

        if (noSystemMessages === true && systemContent?.length) {
          const latestMessageContent = _messages.pop().content;
          if (typeof latestMessageContent !== 'string') {
            latestMessageContent[0].text = [systemContent, latestMessageContent[0].text].join('\n');
            _messages.push(new HumanMessage({ content: latestMessageContent }));
          } else {
            const text = [systemContent, latestMessageContent].join('\n');
            _messages.push(new HumanMessage(text));
          }
        }

        let messages = _messages;
        if (agent.useLegacyContent === true) {
          messages = formatContentStrings(messages);
        }
        const defaultHeaders =
          agent.model_parameters?.clientOptions?.defaultHeaders ??
          agent.model_parameters?.configuration?.defaultHeaders;
        if (defaultHeaders?.['anthropic-beta']?.includes('prompt-caching')) {
          messages = addCacheControl(messages);
        }

        if (i === 0) {
          memoryPromise = this.runMemory(messages);
        }

        if (agent.model_parameters?.configuration?.defaultHeaders != null) {
          agent.model_parameters.configuration.defaultHeaders = resolveHeaders({
            headers: agent.model_parameters.configuration.defaultHeaders,
            body: config.configurable.requestBody,
          });
        }

        const run = await createRun({
          agent,
          req: this.options.req,
          runId: this.responseMessageId,
          signal: abortController.signal,
          customHandlers: this.options.eventHandlers,
        });

        if (!run) {
          throw new Error('Failed to create run');
        }

        if (i === 0) {
          this.run = run;
        }

        if (contentData.length) {
          const agentUpdate = {
            type: ContentTypes.AGENT_UPDATE,
            [ContentTypes.AGENT_UPDATE]: {
              index: contentData.length,
              runId: this.responseMessageId,
              agentId: agent.id,
            },
          };
          const streamData = {
            event: GraphEvents.ON_AGENT_UPDATE,
            data: agentUpdate,
          };
          this.options.aggregateContent(streamData);
          sendEvent(this.options.res, streamData);
          contentData.push(agentUpdate);
          run.Graph.contentData = contentData;
        }

        if (userMCPAuthMap != null) {
          config.configurable.userMCPAuthMap = userMCPAuthMap;
        }
        await run.processStream({ messages }, config, {
          keepContent: i !== 0,
          tokenCounter: createTokenCounter(this.getEncoding()),
          indexTokenCountMap: currentIndexCountMap,
          maxContextTokens: agent.maxContextTokens,
          callbacks: {
            [Callback.TOOL_ERROR]: logToolError,
          },
        });

        config.signal = null;
      };

      await runAgent(this.options.agent, initialMessages);

      let finalContentStart = 0;
      if (
        this.agentConfigs &&
        this.agentConfigs.size > 0 &&
        (await checkCapability(this.options.req, AgentCapabilities.chain))
      ) {
        const windowSize = GEMINI_CHAIN_WINDOW;
        let latestMessage = initialMessages.pop().content;
        if (typeof latestMessage !== 'string') {
          latestMessage = latestMessage[0].text;
        }
        let i = 1;
        let runMessages = [];

        const windowIndexCountMap = {};
        let currentIndex = windowSize - 1;
        for (let k = initialMessages.length - 1; k >= 0; k--) {
          windowIndexCountMap[currentIndex] = indexTokenCountMap[k];
          currentIndex--;
          if (currentIndex < 0) {
            break;
          }
        }
        const encoding = this.getEncoding();
        const tokenCounter = createTokenCounter(encoding);
        for (const [agentId, agent] of this.agentConfigs) {
          if (abortController.signal.aborted === true) {
            break;
          }
          const currentRun = await this.run;

          if (i === this.agentConfigs.size && config.configurable.hide_sequential_outputs === true) {
            const content = this.contentParts.filter((part) => part.type === ContentTypes.TOOL_CALL);
            if (canWrite(this.options?.res)) {
              this.options.res.write(
                `event: message\ndata: ${JSON.stringify({
                  event: 'on_content_update',
                  data: {
                    runId: this.responseMessageId,
                    content,
                  },
                })}\n\n`,
              );
            }
            sseDebug(this.options?.res, { note: 'sequential_final_update' });
          }

          const _runMessages = currentRun.Graph.getRunMessages();
          finalContentStart = this.contentParts.length;
          runMessages = runMessages.concat(_runMessages);
          const contentData = currentRun.Graph.contentData.slice();

          let currentMessages;
          if (isGoogleModel(agent) && GOOGLE_CHAIN_BUFFER === 'off') {
            const contextMessages = [];
            const runIndexCountMap = {};
            for (let wi = 0; wi < windowMessages.length; wi++) {
              const message = windowMessages[wi];
              const messageType = message._getType();
              if (
                (!agent.tools || agent.tools.length === 0) &&
                (messageType === 'tool' || (message.tool_calls?.length ?? 0) > 0)
              ) {
                continue;
              }
              runIndexCountMap[contextMessages.length] = windowIndexCountMap[wi];
              contextMessages.push(message);
            }
            const bufferMessage = new HumanMessage(latestMessage);
            runIndexCountMap[contextMessages.length] = tokenCounter(bufferMessage);
            currentMessages = [...contextMessages, bufferMessage];
          } else {
            const bufferString = getBufferString([new HumanMessage(latestMessage), ...runMessages]);
            try {
              const contextMessages = [];
              const runIndexCountMap = {};
              for (let wi = 0; wi < windowMessages.length; wi++) {
                const message = windowMessages[wi];
                const messageType = message._getType();
                if (
                  (!agent.tools || agent.tools.length === 0) &&
                  (messageType === 'tool' || (message.tool_calls?.length ?? 0) > 0)
                ) {
                  continue;
                }
                runIndexCountMap[contextMessages.length] = windowIndexCountMap[wi];
                contextMessages.push(message);
              }
              const bufferMessage = new HumanMessage(bufferString);
              runIndexCountMap[contextMessages.length] = tokenCounter(bufferMessage);
              currentMessages = [...contextMessages, bufferMessage];
            } catch (err) {
              logger.error(
                `[api/server/controllers/agents/client.js #chatCompletion] Error preparing chain buffer for agent ${agentId} (${i})`,
                err,
              );
              currentMessages = windowMessages;
            }
          }

          try {
            await runAgent(agent, currentMessages, i, contentData, undefined);
          } catch (err) {
            logger.error(
              `[api/server/controllers/agents/client.js #chatCompletion] Error running agent ${agentId} (${i})`,
              err,
            );
          }
          i++;
        }
      }

      if (config.configurable.hide_sequential_outputs !== true) {
        finalContentStart = 0;
      }

      this.contentParts = this.contentParts.filter((part, index) => {
        return index >= finalContentStart || part.type === ContentTypes.TOOL_CALL || part.tool_call_ids;
      });

      try {
        const attachments = await this.awaitMemoryWithTimeout(memoryPromise);
        if (attachments && attachments.length > 0) {
          this.artifactPromises.push(...attachments);
        }

        const balanceConfig = getBalanceConfig(appConfig);
        const transactionsConfig = getTransactionsConfig(appConfig);
        try { const u = this.getStreamUsage && this.getStreamUsage(); this.trace('trace:usage', u || {}); } catch {}
        await this.recordCollectedUsage({
          context: 'message',
          balance: balanceConfig,
          transactions: transactionsConfig,
        });
      } catch (err) {
        logger.error(
          '[api/server/controllers/agents/client.js #chatCompletion] Error recording collected usage',
          err,
        );
      }
    } catch (err) {
      const isAborted =
        (typeof AbortController !== 'undefined' && abortController?.signal?.aborted === true) ||
        err?.name === 'AbortError' ||
        String(err?.message || '').toLowerCase().includes('aborted');

      try {
        const attachments = await this.awaitMemoryWithTimeout(memoryPromise);
        if (attachments && attachments.length > 0) {
          this.artifactPromises?.push(...attachments);
        }
      } catch (_) {}

      if (isAborted) {
        logger.info('[agents/client.chatCompletion] aborted by client; ending gracefully');
        return;
      }

      logger.error('[api/server/controllers/agents/client.js #sendCompletion] Unhandled error', err);
      this.contentParts = this.contentParts || [];
      this.contentParts.push({
        type: ContentTypes.ERROR,
        [ContentTypes.ERROR]: `An error occurred while processing the request${
          err?.message ? `: ${err.message}` : ''
        }`,
      });
    }
  }

  async titleConvo({ text, abortController }) {
    const USE_OLLAMA_FOR_TITLES = (process.env.USE_OLLAMA_FOR_TITLES || 'false').toLowerCase() === 'true';
    const OLLAMA_TITLE_URL = process.env.OLLAMA_TITLE_URL || process.env.OLLAMA_URL || 'http://172.16.15.219:11434';
    const OLLAMA_TITLE_MODEL_NAME = process.env.OLLAMA_TITLE_MODEL_NAME || process.env.OLLAMA_ENTITY_EXTRACTION_MODEL_NAME || 'gemma:7b-instruct';

    if (USE_OLLAMA_FOR_TITLES) {
        try {
            const ollama_payload = {
                "model": OLLAMA_TITLE_MODEL_NAME,
                "messages": [
                    {"role": "system", "content": "Ты — эксперт по созданию коротких и релевантных заголовков для бесед. На основе текста последнего сообщения пользователя, создай краткий заголовок. Выдавай ТОЛЬКО JSON-объект с полем 'title'. Никакого дополнительного текста. Заголовок должен быть на русском языке, без кавычек, двоеточий и пояснений, до 30 символов, без слов: создание, генерация, заголовок, название, тема, описание, запрос."},
                    {"role": "user", "content": `На основе текста ниже верни один короткий суммаризированный заголовок на русском, который отражает тему последнего сообщения пользователя (до 30 символов). Текст: "${text}"`}
                ],
                "stream": false,
                "format": "json",
                "options": {
                    "temperature": 0.1
                }
            };
            const response = await axios.post(`${OLLAMA_TITLE_URL}/api/chat`, ollama_payload, { timeout: 60000 });
            if (response.data && response.data.message && response.data.message.content) {
                const raw_json_str = response.data.message.content;
                const parsed_data = JSON.parse(raw_json_str);
                if (parsed_data && parsed_data.title) {
                    logger.info(`[title] Ollama generated: "${parsed_data.title}"`);
                    return parsed_data.title;
                }
            }
            logger.warn(`[title] Ollama title generation failed or returned empty. Falling back. Response: ${JSON.stringify(response.data)}`);
        } catch (e) {
            logger.error(`[title] Ollama title generation error: ${e.message}. Falling back.`, e);
        }
        const cleaned = String(text || '').replace(/\s+/g, ' ').slice(0, 30).trim();
        logger.warn(`[title][fallback-ollama] "${cleaned}"`);
        return cleaned.length ? cleaned : 'Новый диалог';
    }

    const cleaned = String(text || '').replace(/\s+/g, ' ').slice(0, 30).trim();
    logger.warn(`[title][fallback-no-llm] "${cleaned}"`);
    return cleaned.length ? cleaned : 'Новый диалог';
  }

  async recordTokenUsage({
    model,
    usage,
    balance,
    promptTokens,
    completionTokens,
    context = 'message',
  }) {
    try {
      await spendTokens(
        {
          model,
          context,
          balance,
          conversationId: this.conversationId,
          user: this.user ?? this.options.req.user?.id,
          endpointTokenConfig: this.options.endpointTokenConfig,
        },
        { promptTokens, completionTokens },
      );

      if (usage && typeof usage === 'object' && 'reasoning_tokens' in usage && typeof usage.reasoning_tokens === 'number') {
        await spendTokens(
          {
            model,
            balance,
            context: 'reasoning',
            conversationId: this.conversationId,
            user: this.user ?? this.options.req.user?.id,
            endpointTokenConfig: this.options.endpointTokenConfig,
          },
          { completionTokens: usage.reasoning_tokens },
        );
      }
    } catch (error) {
      logger.error('[api/server/controllers/agents/client.js #recordTokenUsage] Error recording token usage', error);
    }
  }

  getEncoding() {
    const model = this.options?.agent?.model_parameters?.model || this.model;
    if (model && /gemini/i.test(model)) {
        return 'cl100k_base'; // Gemini использует похожий токенизатор
    }
    return 'o200k_base'; // Для GPT-4o
  }

  getTokenCount(text) {
    const encoding = this.getEncoding();
    return Tokenizer.getTokenCount(text, encoding);
  }
}

module.exports = AgentClient;
