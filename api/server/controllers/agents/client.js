// /opt/open-webui/client.js - Финальная версия с исправленной логикой индексации и RAG через tools-gateway
require('events').EventEmitter.defaultMaxListeners = 100;
const { createHash } = require('crypto');
const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');
const configService = require('~/server/services/Config/ConfigService');
const axios = require('axios');
const { DynamicStructuredTool } = require('@langchain/core/tools');
const { getBufferString, HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { EventService } = require('../../services/Events/EventService');
const {
  createRun,
  Tokenizer,
  resolveHeaders,
  getBalanceConfig,
  memoryInstructions,
  formatContentStrings,
  getTransactionsConfig,
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
  VisionModes,
  ContentTypes,
  EModelEndpoint,
  isAgentsEndpoint,
  AgentCapabilities,
  bedrockInputSchema,
  removeNullishValues,
} = require('librechat-data-provider');
const { addCacheControl } = require('~/app/clients/prompts');
const { normalizeInstructionsPayload } = require('~/app/clients/utils/instructions');
const { encodeAndFormat } = require('~/server/services/Files/images/encode');
const { getProviderConfig } = require('~/server/services/Endpoints');
const { checkCapability } = require('~/server/services/Config');
const BaseClient = require('~/app/clients/BaseClient');
const { getMCPManager } = require('~/config');
const runtimeMemoryConfig = require('~/utils/memoryConfig');
const MessageHistoryManager = require('~/server/services/agents/MessageHistoryManager');
const { ContextCompressor, MessageCompressorBridge } = require('~/server/services/agents/ContextCompressor');
const { analyzeIntent } = require('~/server/services/RAG/intentAnalyzer');
const { condenseContext: ragCondense } = require('~/server/services/RAG/condense');
const { runMultiStepRag } = require('~/server/services/RAG/multiStepOrchestrator');
const {
  setDeferredContext,
  getDeferredContext,
  clearDeferredContext,
  replaceRagBlock,
  POLICY_INTRO,
  buildRagBlock,
} = require('~/server/services/RAG/RagContextManager');
const { HistoryTrimmer } = require('~/server/services/agents/historyTrimmer');
const { queueGateway } = require('~/server/services/agents/queue');
const { createAgentMemoryService } = require('~/server/services/agents/memory/agentMemoryService');
const { createAgentToolsService } = require('~/server/services/agents/tools');
const { agentUsageService } = require('~/server/services/agents/usage');
const { applyOverflowGuard } = require('~/server/services/agents/OverflowGuardService');
const {
  compressMessagesForRetry,
  detectContextOverflow,
} = require('~/server/services/agents/utils');
const {
  buildContext: contextBuild,
  fetchGraphContext,
  calculateAdaptiveTimeout,
  mapReduceContext,
  applyDeferredCondensation,
  withTimeout,
} = require('~/server/services/agents/context');
const {
  extractMessageText,
  normalizeMemoryText,
  makeIngestKey,
} = require('~/server/utils/messageUtils');
const TokenCounter = require('~/server/services/tokens/TokenCounter');

const AUGMENTED_CONTEXT_HEADER = '[ATTACHMENTS_CONTEXT]';
const AUGMENTED_CONTEXT_FOOTER = '[/ATTACHMENTS_CONTEXT]';
const OCR_CONTEXT_HEADER = '[OCR_CONTEXT]';
const OCR_CONTEXT_FOOTER = '[/OCR_CONTEXT]';
const RAG_SECTIONS_HEADER = '[RAG_SECTIONS]';
const RAG_SECTIONS_FOOTER = '[/RAG_SECTIONS]';
const RAG_BLOCK_FOOTER = '---\n\n';
const MAP_SUMMARY_GUARD_RATIO = configService.getNumber('rag.guard.mapSummaryRatio', 1.35);

const replaceAugmentedBlock = (systemContent = '', augmentedBlock = '') => {
  const safeBlock = typeof augmentedBlock === 'string' ? augmentedBlock : '';
  if (!safeBlock.trim()) {
    return systemContent || '';
  }
  const wrapped = `${AUGMENTED_CONTEXT_HEADER}\n${safeBlock}\n${AUGMENTED_CONTEXT_FOOTER}\n`;
  if (typeof systemContent !== 'string' || !systemContent.trim()) {
    return wrapped + (systemContent || '');
  }
  const start = systemContent.indexOf(AUGMENTED_CONTEXT_HEADER);
  const end = systemContent.indexOf(AUGMENTED_CONTEXT_FOOTER);
  if (start !== -1 && end !== -1 && end > start) {
    const before = systemContent.slice(0, start);
    const after = systemContent.slice(end + AUGMENTED_CONTEXT_FOOTER.length);
    return `${before}${wrapped}${after}`;
  }
  return `${wrapped}${systemContent}`;
};

const replaceOcrBlock = (systemContent = '', ocrBlock = '') => {
  const safeBlock = typeof ocrBlock === 'string' ? ocrBlock : '';
  if (!safeBlock.trim()) {
    return systemContent || '';
  }
  const wrapped = `${OCR_CONTEXT_HEADER}\n${safeBlock}\n${OCR_CONTEXT_FOOTER}\n`;
  if (typeof systemContent !== 'string' || !systemContent.trim()) {
    return wrapped + (systemContent || '');
  }
  const start = systemContent.indexOf(OCR_CONTEXT_HEADER);
  const end = systemContent.indexOf(OCR_CONTEXT_FOOTER);
  if (start !== -1 && end !== -1 && end > start) {
    const before = systemContent.slice(0, start);
    const after = systemContent.slice(end + OCR_CONTEXT_FOOTER.length);
    return `${before}${wrapped}${after}`;
  }
  return `${wrapped}${systemContent}`;
};

const replaceRagSectionsBlock = (systemContent = '', ragSectionsBlock = '') => {
  const safeBlock = typeof ragSectionsBlock === 'string' ? ragSectionsBlock : '';
  const safeSystem = typeof systemContent === 'string' ? systemContent : (systemContent ?? '');
  const trimmedBlock = safeBlock.trim();
  const start = safeSystem.indexOf(RAG_SECTIONS_HEADER);
  const end = safeSystem.indexOf(RAG_SECTIONS_FOOTER);
  const hasExistingBlock = start !== -1 && end !== -1 && end > start;

  if (!trimmedBlock.length) {
    if (!hasExistingBlock) {
      return safeSystem || '';
    }
    const before = safeSystem.slice(0, start);
    const after = safeSystem.slice(end + RAG_SECTIONS_FOOTER.length);
    return `${before}${after}`;
  }

  const wrapped = `${RAG_SECTIONS_HEADER}\n${safeBlock}\n${RAG_SECTIONS_FOOTER}\n`;

  if (!safeSystem.trim()) {
    return wrapped;
  }

  if (hasExistingBlock) {
    const before = safeSystem.slice(0, start);
    const after = safeSystem.slice(end + RAG_SECTIONS_FOOTER.length);
    return `${before}${wrapped}${after}`;
  }

  return `${wrapped}${safeSystem}`;
};

const extractRagBlock = (content = '') => {
  if (typeof content !== 'string' || !content.trim()) {
    return '';
  }
  const introSnippet = typeof POLICY_INTRO === 'string' ? POLICY_INTRO.slice(0, 16).trim() : '';
  if (!introSnippet) {
    return '';
  }
  const introIndex = content.indexOf(introSnippet);
  if (introIndex === -1) {
    return '';
  }
  const footerIndex = content.indexOf(RAG_BLOCK_FOOTER, introIndex);
  if (footerIndex === -1) {
    return '';
  }
  return content.slice(introIndex, footerIndex + RAG_BLOCK_FOOTER.length);
};

/** @type {Map<string, { expiresAt: number, payload: object }>} */


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

const featuresConfig = configService.getSection('features');
const memoryStaticConfig = configService.getSection('memory');
const agentsConfig = configService.getSection('agents');

const getBoolean = (path, fallback) => configService.getBoolean(path, fallback);
const getNumber = (path, fallback) => configService.getNumber(path, fallback);
const getString = (path, fallback) => {
  const value = configService.get(path, fallback);
  return value == null ? fallback : value;
};

const DEBUG_SSE = configService.getBoolean('logging.debugSse', false);

const IngestedHistory = new Set();

const HIST_LONG_USER_TO_RAG = configService.getNumber('rag.history.histLongUserToRag', 20000);
const OCR_TO_RAG_THRESHOLD = configService.getNumber('rag.history.ocrToRagThreshold', 15000);
const WAIT_FOR_RAG_INGEST_MS = configService.getNumber('rag.history.waitForIngestMs', 0);
const ASSIST_LONG_TO_RAG = configService.getNumber('rag.history.assistLongToRag', 15000);
const ASSIST_SNIPPET_CHARS = configService.getNumber('rag.history.assistSnippetChars', 1500);

const GOOGLE_CHAIN_BUFFER = (configService.get('features.googleChainBuffer', 'off') || 'off').toLowerCase();
const GEMINI_CHAIN_WINDOW = configService.getNumber('features.geminiChainWindow', 5);

const USE_GRAPH_CONTEXT = typeof memoryStaticConfig.useGraphContext === 'boolean'
  ? memoryStaticConfig.useGraphContext
  : configService.getBoolean('features.useGraphContext', true);

const GRAPH_RELATIONS_LIMIT = configService.getNumber('memory.graphContext.maxLines', 40);
const GRAPH_CONTEXT_LINE_LIMIT = configService.getNumber('memory.graphContext.maxLines', 40);
const GRAPH_CONTEXT_MAX_LINE_CHARS = configService.getNumber('memory.graphContext.maxLineChars', 200);
const GRAPH_REQUEST_TIMEOUT_MS = configService.getNumber('memory.graphContext.requestTimeoutMs', 10000);
const GRAPH_QUERY_HINT_MAX_CHARS = configService.getNumber('memory.graphContext.summaryHintMaxChars', 2000);
const RAG_QUERY_MAX_CHARS = configService.getNumber('memory.ragQuery.maxChars', 6000);

const MEMORY_TASK_TIMEOUT_MS = configService.getNumber('memory.queue.taskTimeoutMs', 30000);
const DEFAULT_SYSTEM_PROMPT = 'Ты самый полезный ИИ-помощник. Всегда в приоритете используй русский язык для ответов.';

const logger = getLogger('agents.client');
const memoryService = createAgentMemoryService();
const toolsService = createAgentToolsService({ logger });

/**
 * Provides safe logger methods with environment-aware fallbacks.
 */
const createSafeLogger = () => ({
  info: (...args) => logger.info(...args),
  warn: (...args) => logger.warn(...args),
  error: (...args) => logger.error(...args),
});

const { error: safeError } = createSafeLogger();

/**
 * Checks if the agent uses a Google/Gemini model.
 */
function isGoogleModel(agent) {
  const model = agent?.model_parameters?.model || agent?.model || '';
  return agent?.provider === Providers.GOOGLE || /gemini/i.test(model);
}

/**
 * Parses model parameters based on endpoint type.
 */
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


/**
 * Marks messages as stored in memory (bulk update)
 * @param {Object} req - Request object
 * @param {Array<string>} messageIds - Array of message IDs to mark
 * @returns {Promise<void>}
 */
async function markMessagesAsStored(req, messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return;
  }

  try {
    const Message = require('~/db/models').Message;
    const result = await Message.updateMany(
      {
        messageId: { $in: messageIds },
        user: req.user.id,
      },
      {
        $set: { isMemoryStored: true },
      },
    );

    logger.debug('[markMessagesAsStored] Marked messages as stored', {
      messageIds,
      modifiedCount: result?.modifiedCount,
    });
  } catch (error) {
    logger.error('[markMessagesAsStored] Failed to mark messages', {
      messageIds,
      error: error?.message,
    });
  }
}

/**
 * Agent client for handling AI agent interactions, RAG, and tool integrations.
 */
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
    logger.info('[AgentClient:init.max_context]', {
      maxContextTokens: this.maxContextTokens,
      optionsMaxContextTokens: maxContextTokens,
      agentMaxContextTokens: this.options?.agent?.maxContextTokens,
      agentModel: this.model,
      provider: this.options?.agent?.provider,
    });
    this.inputTokensKey = 'input_tokens';
    this.outputTokensKey = 'output_tokens';
    this.usage;
    this.indexTokenCountMap = {};
    this.processMemory;
    this.historyManager = new MessageHistoryManager({
      ingestedHistory: IngestedHistory,
      get config() {
        return runtimeMemoryConfig.getMemoryConfig();
      },
      memoryTaskTimeout: MEMORY_TASK_TIMEOUT_MS,
    });

    const TRACE_PIPELINE = configService.getBoolean('logging.tracePipeline', false);
    this.trace = (label, data = {}) => {
      try {
        if (!TRACE_PIPELINE) {
          return;
        }
        const meta = {
          label,
          cid: this.conversationId,
          rid: this.responseMessageId,
          pid: process.pid,
        };
        const safe = (v) => {
          try {
            if (typeof v === 'string' && v.length > 500) {
              return `${v.slice(0, 250)} … ${v.slice(-150)}`;
            }
            return v;
          } catch {
            return v;
          }
        };
        const cleaned = {};
        for (const [k, v] of Object.entries(data || {})) {
          cleaned[k] = safe(v);
        }
        logger.info('[trace]', { ...meta, ...cleaned });
      } catch (error) {
        logger.warn(
          `[trace] failed to emit trace log: ${error?.message || error}`,
        );
      }
    };
  }

  getContentParts() {
    return this.contentParts;
  }

  setOptions(options) {
    logger.debug('[AgentClient] setOptions', options);
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

    const convId = this.options.req.body.conversationId;
    const userId = this.options.req.user.id;

    const isTextFile = files && files.length > 0 && files[0].type && files[0].type.startsWith('text/');
    const isLargeEnough = ocrText && ocrText.length > (OCR_TO_RAG_THRESHOLD ?? 15000);

    if (isTextFile && isLargeEnough && convId && userId) {
      const file = files[0];
      const dedupeKey = makeIngestKey(convId, file.file_id, ocrText);
      if (IngestedHistory.has(dedupeKey)) {
        logger.info(`[file-ingest][dedup] файл ${file.file_id} уже в работе.`);
      } else {
        IngestedHistory.add(dedupeKey);
        const task = {
          type: 'index_file',
          payload: {
            user_id: userId,
            conversation_id: convId,
            file_id: file.file_id,
            text_content: ocrText,
            source_filename: file.originalname || file.filename || null,
            mime_type: file.type || null,
            file_size: file.size || null,
          },
        };

        try {
          const result = await withTimeout(
            queueGateway.enqueueMemory(
              [task],
              {
                reason: 'index_file',
                conversationId: convId,
                userId,
                fileId: file.file_id,
                textLength: ocrText.length,
              },
            ),
            Math.min(MEMORY_TASK_TIMEOUT_MS, 10000),
            'Memory indexing timed out',
          );
            
          if (this.options?.req && result?.status === 'queued') {
            this.options.req.didEnqueueIngest = true;
          }
        } catch (queueError) {
          safeError('[file-ingest] Failed to enqueue memory task', {
            conversationId: convId,
            fileId: file.file_id,
            message: queueError?.message,
          });
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
    const runtimeCfg = runtimeMemoryConfig.getMemoryConfig();
    let pendingIngest = null;

    if (opts?.isRegenerate && parentMessageId && this.options?.req) {
      try {
        const { deleteMessagesSince } = require('~/models/Message');
        const result = await deleteMessagesSince(this.options.req, {
          messageId: parentMessageId,
          conversationId: this.conversationId,
        });
        const removedCount = typeof result === 'number'
          ? result
          : Number(result?.deletedCount ?? result?.n ?? result?.acknowledged ? result?.deletedCount : 0) || 0;
        if (removedCount > 0) {
          logger.info('[AgentClient][regen.deleteMessagesSince]', {
            conversationId: this.conversationId,
            parentMessageId,
            removedCount,
          });
        }
      } catch (deleteError) {
        logger.error('[AgentClient][regen.deleteMessagesSince.error]', {
          conversationId: this.conversationId,
          parentMessageId,
          message: deleteError?.message,
          stack: deleteError?.stack,
        });
      }
      try {
        if (this.options.req.agentConfigs?.delete(this.agent_id)) {
          logger.debug('[AgentClient][regen.agentConfigs.cleared]', {
            conversationId: this.conversationId,
            agentId: this.agent_id,
          });
        }
      } catch (agentCfgError) {
        logger.warn('[AgentClient][regen.agentConfigs.error]', {
          conversationId: this.conversationId,
          agentId: this.agent_id,
          message: agentCfgError?.message,
        });
      }

      const pruneMessagesAfterParent = () => {
        if (!Array.isArray(messages) || !messages.length) {
          return messages;
        }
        const parentIdx = messages.findIndex((msg) => msg?.messageId === parentMessageId);
        if (parentIdx === -1) {
          return messages;
        }
        const allowed = parentIdx + 1;
        const pruned = messages.slice(0, allowed);
        const removed = messages.length - pruned.length;
        if (removed > 0) {
          logger.info('[AgentClient][regen.local_prune]', {
            conversationId: this.conversationId,
            parentMessageId,
            removed,
          });
        }
        return pruned;
      };

      messages = pruneMessagesAfterParent();
    }

    let orderedMessages = this.constructor.getMessagesForConversation({
      messages,
      parentMessageId,
      summary: this.shouldSummarize,
    });

    orderedMessages = orderedMessages.filter((message) => {
      if (typeof message?.text === 'string' && message.text.startsWith('[[moved_to_memory')) {
        logger.warn('[rag.history.legacy_stub]', {
          conversationId: this.conversationId,
          messageId: message?.messageId,
        });
        return false;
      }
      return true;
    });

    const historyCompressionCfg = runtimeCfg?.historyCompression ?? {};
    const historyCfg = runtimeCfg?.history ?? {};
    const dontShrinkLastN = Number.isFinite(historyCfg?.dontShrinkLastN)
      ? Math.max(historyCfg.dontShrinkLastN, 1)
      : 1;
    const MAX_MESSAGES_TO_PROCESS = historyCompressionCfg?.enabled ? Infinity : 25;
    const conversationId = this.conversationId || this.options?.req?.body?.conversationId;
    const requestUserId = this.options?.req?.user?.id || null;

    let systemMessage = orderedMessages.find(m => m.role === 'system');
    let otherMessages = orderedMessages.filter(m => m.role !== 'system');
    let droppedMessages = [];

    if (otherMessages.length > MAX_MESSAGES_TO_PROCESS) {
      const keptMessages = otherMessages.slice(-MAX_MESSAGES_TO_PROCESS);
      droppedMessages = otherMessages.slice(0, otherMessages.length - MAX_MESSAGES_TO_PROCESS);

      orderedMessages = systemMessage ? [systemMessage, ...keptMessages] : keptMessages;

      logger.warn(`[PROMPT-LIMIT] Принудительно усекаем историю с ${otherMessages.length} до ${MAX_MESSAGES_TO_PROCESS} сообщений. Dropped: ${droppedMessages.length}`);
      
      if (conversationId && requestUserId && droppedMessages.length) {
        setImmediate(() =>
          this.historyManager.processDroppedMessages({
            droppedMessages,
            conversationId,
            userId: requestUserId,
          }),
        );
      }
    }
    logger.debug({
      msg: '[config.history]',
      conversationId: this.conversationId,
      dontShrinkLastN: runtimeCfg?.history?.dontShrinkLastN,
      historyTokenBudget: runtimeCfg?.history?.tokenBudget ?? configService.getNumber('memory.history.tokenBudget', 0),
    });
    const ragCacheTtlMs = Math.max(Number(runtimeCfg?.ragCacheTtl) * 1000, 0);
    const condenseConfig = runtimeCfg?.rag?.condense || {};
    const overflowCfg = configService.get('limits.overflow', {});
    const shouldCompressHistory = Boolean(historyCompressionCfg?.enabled);
    const endpointOption = this.options?.req?.body?.endpointOption ?? this.options?.endpointOption ?? {};
    logger.debug({
      msg: '[AgentClient.buildMessages] start',
      conversationId: this.conversationId,
      orderedMessagesCount: orderedMessages.length,
    });
    try { this.trace('trace:build.start', {
      total: orderedMessages.length,
      lastIds: orderedMessages.slice(-3).map(m => m && m.messageId).join(',')
    }); } catch {}

    const computeImportanceScore = (message = {}, intent = null) => {
      const text =
        typeof message.text === 'string'
          ? message.text
          : Array.isArray(message.content)
            ? message.content
                .filter((part) => part?.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text)
                .join('\n')
            : '';
      const lowered = text.toLowerCase();
      const keywordHits = ['важно', 'инструкция', 'ошибка', 'предупреждение', 'note', 'important']
        .filter((word) => lowered.includes(word)).length;

      let score = 0;
      if (message.isCreatedByUser || message.role === 'user') {
        score += 0.5;
      } else if (message.role === 'assistant') {
        score += 0.3;
      }

      if (keywordHits > 0) {
        score += Math.min(0.3, keywordHits * 0.1);
      }

      const interactions =
        Number(message?.metadata?.likes ?? message?.metadata?.rating ?? 0) || 0;
      if (interactions > 0) {
        score += Math.min(0.2, interactions * 0.05);
      }

      if (intent?.temporalRange?.from && intent?.temporalRange?.to) {
        const temporalText = `${intent.temporalRange.from}-${intent.temporalRange.to}`.toLowerCase();
        if (lowered.includes(intent.temporalRange.from.toLowerCase()) ||
            lowered.includes(intent.temporalRange.to.toLowerCase()) ||
            lowered.includes(temporalText)) {
          score += 0.6;
        }
      }

      if (Array.isArray(intent?.entities) && intent.entities.length) {
        const entityMatches = intent.entities
          .map((entity) => String(entity?.name || '').toLowerCase())
          .filter(Boolean)
          .filter((name) => lowered.includes(name)).length;
        if (entityMatches) {
          score += Math.min(0.3, entityMatches * 0.1);
        }
      }

      return Math.max(0, Math.min(1, score));
    };

    const tokenize = (text = '') => {
      try {
        return Tokenizer.getTokenCount(text, this.getEncoding());
      } catch (err) {
        logger.warn('[history->budget] failed to count tokens, fallback to length', {
          message: err?.message,
        });
        return text.length;
      }
    };

    let systemContent = [instructions ?? '', additional_instructions ?? '']
      .filter(Boolean)
      .join('\n')
      .trim();

    const blockRegistry = {
      rag: null,
      augmented: null,
      ocr: null,
      ragSections: null,
    };

    const blockMarkers = {
      augmented: { header: AUGMENTED_CONTEXT_HEADER, footer: AUGMENTED_CONTEXT_FOOTER },
      ocr: { header: OCR_CONTEXT_HEADER, footer: OCR_CONTEXT_FOOTER },
      ragSections: { header: RAG_SECTIONS_HEADER, footer: RAG_SECTIONS_FOOTER },
    };

    const registerBlock = (type, payload = '') => {
      const text = typeof payload === 'string' ? payload.trim() : '';
      const hash = text.length ? createHash('sha256').update(text).digest('hex') : null;
      blockRegistry[type] = hash;
      return hash;
    };

    const syncBlockRegistryWithContent = (content = '') => {
      const safeContent = typeof content === 'string' ? content : '';
      Object.entries(blockMarkers).forEach(([type, markers]) => {
        const hasHeader = safeContent.includes(markers.header);
        const hasFooter = safeContent.includes(markers.footer);
        if (!hasHeader || !hasFooter) {
          blockRegistry[type] = null;
        }
      });
    };

    if (orderedMessages.length === 0 && systemContent.length === 0) {
        systemContent = DEFAULT_SYSTEM_PROMPT;
        logger.debug('[AgentClient] Applied default system prompt for new chat');
    }
    logger.debug(`[AgentClient] Initial systemContent: ${systemContent.length} chars`);

    const PromptBudgetManager = require('~/server/services/agents/PromptBudgetManager');
    const budgetManager = new PromptBudgetManager({ configService });
    const budgetModel =
      this.options?.endpointOption?.model ||
      this.options?.req?.body?.endpointOption?.model ||
      this.options?.req?.body?.model ||
      this.options?.agent?.model_parameters?.model ||
      this.model;
    const budget = await budgetManager.getBudget({
      model: budgetModel,
      runtimeCfg,
      requestContext: buildContext({
        conversationId: this.conversationId,
        userId: requestUserId,
        requestId: this.options?.req?.requestId,
        agentId: this.agent_id,
      }),
      encoding: this.getEncoding(),
    });
    logger.info('[context.budget.model]', {
      conversationId: this.conversationId,
      model: budgetModel,
    });

    let historyTrimmer = null;
    let historyTokenBudget = 0;
    const headroom = Number(historyCompressionCfg?.contextHeadroom) || 0;
    const ragTokens = Number(this.options?.req?.ragContextTokens) || 0;
    let instructionsTokensEstimate = tokenize(systemContent);
    const maxContextTokens = budget?.safeBudget ||
      this.maxContextTokens ||
      Number(runtimeCfg?.tokenLimits?.maxPromptTokens) ||
      Number(runtimeCfg?.tokenLimits?.maxMessageTokens) ||
      Number(historyCfg?.tokenBudget) ||
      0;

    const measureInstructionsTokens = (label = 'initial', referenceContent = systemContent) => {
      const reference = typeof referenceContent === 'string' ? referenceContent : (referenceContent ?? '');
      instructionsTokensEstimate = tokenize(reference);
      try {
        logger.info('[context.instructions.tokens]', {
          conversationId: this.conversationId,
          label,
          instructionsTokens: instructionsTokensEstimate,
          ragTokens,
        });
      } catch {}
      if (this.options?.req) {
        this.options.req.instructionsTokens = instructionsTokensEstimate;
      }
      return instructionsTokensEstimate;
    };

    const rebalanceHistoryBudget = (label = 'initial', referenceContent = systemContent) => {
      const safeBudget = Number(budget?.safeBudget) || maxContextTokens;
      const historyCeiling = Number.isFinite(budget?.budgets?.history)
        ? Math.min(Number(budget?.budgets?.history), safeBudget)
        : safeBudget;
      const instructionsTokens = measureInstructionsTokens(label, referenceContent);
      const ragAllowance = Math.max(ragTokens, 0);
      const baseHistoryBudget = Math.max(historyCeiling - instructionsTokens - ragAllowance, 0);
      const rawSafetyFactor = Number(runtimeCfg?.history?.safetyFactor ?? 0.65);
      const safetyFactor = Number.isFinite(rawSafetyFactor)
        ? Math.min(Math.max(rawSafetyFactor, 0), 1)
        : 0.65;
      historyTokenBudget = Math.floor(baseHistoryBudget * safetyFactor);
      logger.info('[context.budget.rebalance]', {
        conversationId: this.conversationId,
        label,
        safeBudget,
        historyCeiling,
        ragAllowance,
        instructionsTokens,
        historyTokenBudget,
        safetyFactor,
        headroom,
      });
      return historyTokenBudget;
    };

    rebalanceHistoryBudget('pre_history_manager');

    const intentAnalysis = runtimeCfg?.multiStepRag?.enabled
      ? await analyzeIntent({
          message: orderedMessages[orderedMessages.length - 1],
          context: orderedMessages.slice(-8),
          signal: this.options?.req?.abortController?.signal,
          timeoutMs: runtimeCfg.multiStepRag?.intentTimeoutMs || 2000,
        })
      : { entities: [], needsFollowUps: false };
    if (this.options?.req) {
      this.options.req.intentAnalysis = intentAnalysis;
    }

    logger.debug('[buildMessages.conversationId]', {
      local: conversationId,
      instance: this.conversationId,
      match: conversationId === this.conversationId,
    });

    if (historyCompressionCfg?.enabled) {
      const availableBudget = Math.max(historyTokenBudget - headroom, 0);

      if (availableBudget > 0) {
        historyTrimmer = new HistoryTrimmer({
          tokenizerEncoding: this.getEncoding(),
          keepLastN: dontShrinkLastN || 6,
          layer1Ratio: historyCompressionCfg.layer1Ratio,
          layer2Ratio: historyCompressionCfg.layer2Ratio,
          contextHeadroom: headroom,
          importanceScorer: (message) => computeImportanceScore(message, this.options?.req?.intentAnalysis),
          compressor: new MessageCompressorBridge({ reduction: historyCompressionCfg.layer2Ratio ?? 0.25 }),
          loggerInstance: logger,
        });
        logger.info('[contextCompression.enabled]', {
          conversationId: this.conversationId,
          budgetTokens: availableBudget,
          headroom,
        });
      } else {
        logger.warn('[contextCompression.disabled.budget]', {
          conversationId: this.conversationId,
          budgetTokens: availableBudget,
          ragTokens,
          instructionsTokens: instructionsTokensEstimate,
          headroom,
          maxContextTokens,
        });
      }
    }

    try {
      logger.debug('[history->RAG] start', {
        conversationId: this.conversationId,
        orderedMessages: orderedMessages.length,
        histLongUserToRag: HIST_LONG_USER_TO_RAG,
        assistLongToRag: ASSIST_LONG_TO_RAG,
      });
      orderedMessages = orderedMessages.map((message) => ({
        ...message,
        importance: computeImportanceScore(message),
      }));

      const hasFreshContext = Boolean(
        (this.options?.req?.ragContextTokens > 0) ||
        (this.options?.req?.ragMultiStep?.ragContext?.entities?.length > 0)
      );

      const {
        toIngest = [],
        modifiedMessages,
        liveWindowStats,
      } = await this.historyManager.processMessageHistory({
        orderedMessages,
        conversationId,
        userId: requestUserId,
        histLongUserToRag: HIST_LONG_USER_TO_RAG,
        assistLongToRag: ASSIST_LONG_TO_RAG,
        assistSnippetChars: ASSIST_SNIPPET_CHARS,
        dontShrinkLastN,
        trimmer: historyTrimmer,
        tokenBudget: historyTokenBudget,
        contextHeadroom: headroom,
        condenseContext: ragCondense,
        condenseChain: condenseConfig?.chain || [],
        hasFreshContext,
      });

      orderedMessages = modifiedMessages;

      if (liveWindowStats) {
        logger.info('[history.live_window.applied]', {
          conversationId: this.conversationId,
          mode: liveWindowStats.mode,
          requestedSize: runtimeCfg?.history?.liveWindow?.size,
          kept: liveWindowStats.kept,
          dropped: liveWindowStats.dropped,
        });
      }

      if (toIngest.length && conversationId) {
        pendingIngest = {
          toIngest,
          conversationId,
          userId: requestUserId,
          reason: 'history_sync',
        };
      }
      logger.debug('[history->RAG] done', {
        conversationId: this.conversationId,
        toIngest: toIngest.length,
        modifiedMessages: orderedMessages.length,
      });
    } catch (error) {
      logger.error('[history->RAG] failed', {
        conversationId: this.conversationId,
        message: error?.message,
        stack: error?.stack,
      });
    }

    let ragContextLength = 0;
    let ragCacheStatus = 'skipped';
    let multiStepResult = {
      globalContext: systemContent,
      entities: [],
      passesUsed: 0,
      queueStatus: {},
    };
    const req = this.options?.req;
    const res = this.options?.res;

    if (req) {
      req.ragCacheStatus = ragCacheStatus;
    }

    const waitMsRaw = Number(runtimeCfg?.rag?.history?.waitForIngestMs ?? runtimeCfg?.history?.waitForIngestMs ?? 0);
    const waitMs = Math.min(Math.max(waitMsRaw, 0), 3000);
    const didIngest = Boolean(req?.didEnqueueIngest);
    
    if (didIngest && waitMs > 0) {
      logger.debug('[history->RAG] waiting before rag/search', { 
        conversationId: this.conversationId, 
        waitMs,
        reqDidEnqueueIngest: req?.didEnqueueIngest
      });
      await new Promise((r) => setTimeout(r, waitMs));
    }

    try {
      const toolsGatewayUrl = runtimeCfg?.toolsGateway?.url || this.options?.req?.config?.queues?.toolsGatewayUrl;

      const fetchGraphLinesForEntity = async ({ entity, relationHints, limit, signal, passIndex }) => {
        const entityName = typeof entity === 'string' ? entity : entity?.name;
        if (!toolsGatewayUrl || !entityName) {
          return { lines: [], status: 'skipped' };
        }

        const hints = Array.isArray(relationHints)
          ? relationHints.filter(Boolean)
          : Array.isArray(entity?.hints)
            ? entity.hints.filter(Boolean)
            : [];

        try {
          const graphContext = await fetchGraphContext({
            conversationId: this.conversationId,
            toolsGatewayUrl,
            limit: limit ?? runtimeCfg?.graphContext?.maxLines ?? GRAPH_RELATIONS_LIMIT,
            timeoutMs: runtimeCfg?.graphContext?.requestTimeoutMs ?? GRAPH_REQUEST_TIMEOUT_MS,
            entity: typeof entity === 'string' ? { name: entity } : entity,
            relationHints: hints,
            passIndex,
            signal,
            logger,
          });

          if (!graphContext?.lines?.length) {
            return { lines: [], status: 'empty' };
          }

          return { lines: graphContext.lines, status: 'ok' };
        } catch (error) {
          logger.error('[rag.followup.graph.fetch.error]', {
            conversationId: this.conversationId,
            entity: entityName,
            message: error?.message,
          });
          return { lines: [], status: 'failed' };
        }
      };

      logger.debug('[multiStep.conversationId]', {
        local: conversationId,
        instance: this.conversationId,
      });

      multiStepResult = runtimeCfg?.multiStepRag?.enabled
        ? await runMultiStepRag({
            intentAnalysis,
            runtimeCfg,
            baseContext: systemContent,
            graphContext: req?.graphContext,
            fetchGraphContext: fetchGraphLinesForEntity,
            enqueueMemoryTasks: queueGateway.enqueueMemory,
            conversationId,
            userId: requestUserId,
            endpoint: this.options?.endpoint,
            model: this.model,
            signal: this.options?.req?.abortController?.signal,
          })
        : { globalContext: systemContent, entities: [], passesUsed: 0, queueStatus: {} };

      systemContent = multiStepResult.globalContext || systemContent;
      if (req?.graphContext?.summary && !systemContent.includes(req.graphContext.summary)) {
        systemContent = `Краткое содержание беседы: ${req.graphContext.summary}\n\n${systemContent}`;
      }
      rebalanceHistoryBudget('post_multistep_global', systemContent);
      const deferred = getDeferredContext(req);
      if (deferred && deferred.vectorText?.length) {
        await this.applyDeferredCondensation({
          req,
          res,
          endpointOption,
          runtimeCfg,
          userQuery: req?.ragUserQuery || '',
          systemContentRef: () => systemContent,
          updateSystemContent: (next) => {
            systemContent = next;
            rebalanceHistoryBudget('post_deferred_apply_rag', systemContent);
          },
          deferredContext: deferred,
        });
      }

      const ragContextObject = {
        global: multiStepResult.globalContextSummary || multiStepResult.globalContext || '',
        entities: multiStepResult.entities?.map((entity) => ({
          name: entity.name,
          graphContext: entity.graphLines,
          vectorContext: entity.vectorChunks,
          graphSummary: entity.graphSummary,
          vectorSummary: entity.vectorSummary,
          tokens: entity.tokens,
          passes: entity.passes,
        })) || [],
      };

      if (req) {
        req.ragMultiStep = {
          enabled: Boolean(runtimeCfg?.multiStepRag?.enabled),
          passesUsed: multiStepResult.passesUsed,
          entities: multiStepResult.entities?.map((entity) => ({
            name: entity.name,
            passes: entity.passes,
            tokens: entity.tokens,
            graphLines: entity.graphLines.length,
            vectorChunks: entity.vectorChunks.length,
          })),
          queueStatus: multiStepResult.queueStatus,
          ragContext: ragContextObject,
        };
      } else if (this.options?.req) {
        this.options.req.ragMultiStep = { ragContext: ragContextObject };
      }
    } catch (multiStepError) {
      logger.error('[rag.multistep.error]', {
        conversationId: this.conversationId,
        message: multiStepError?.message,
        stack: multiStepError?.stack,
      });
      clearDeferredContext(req);
    }

    try {
      const ragBudgetTokens = budget?.budgets?.rag;
      const budgetShares = runtimeCfg?.rag?.budgetShares || {};
      const shortQueryMaxChars = Number(budgetShares.shortQueryMaxChars ?? 80);
      const lastQuery = String(req?.ragUserQuery || '').trim();
      const useShort = lastQuery && lastQuery.length <= shortQueryMaxChars;
      const useEntityHeavy = Array.isArray(req?.intentAnalysis?.entities)
        ? req.intentAnalysis.entities.length > 0
        : false;
      const selectedShares = useShort
        ? budgetShares.shortQuery
        : useEntityHeavy
          ? budgetShares.entityHeavy
          : budgetShares.default;
      const shareVector = Number(selectedShares?.vector ?? 0.5);
      const shareGraph = Number(selectedShares?.graph ?? 0.5);
      const shareTotal = shareVector + shareGraph;
      const normalizedVector = shareTotal > 0 ? shareVector / shareTotal : 0.5;
      const normalizedGraph = shareTotal > 0 ? shareGraph / shareTotal : 0.5;
      const graphBudgetTokens = Number.isFinite(ragBudgetTokens)
        ? Math.floor(ragBudgetTokens * normalizedGraph)
        : undefined;
      const vectorBudgetTokens = Number.isFinite(ragBudgetTokens)
        ? Math.floor(ragBudgetTokens * normalizedVector)
        : undefined;

      logger.debug('[rag.budget.shares]', {
        conversationId: this.conversationId,
        ragBudgetTokens,
        shortQueryMaxChars,
        useShort,
        useEntityHeavy,
        vectorShare: normalizedVector,
        graphShare: normalizedGraph,
        graphBudgetTokens,
        vectorBudgetTokens,
      });

      const ragResult = await contextBuild({
        orderedMessages,
        systemContent,
        runtimeCfg,
        req,
        res,
        endpointOption,
        logger,
        encoding: this.getEncoding(),
        ragBudgetTokens,
        graphBudgetTokens,
        vectorBudgetTokens,
      });

      if (pendingIngest) {
        const ingestPayload = pendingIngest;
        pendingIngest = null;
        setImmediate(() =>
          this.historyManager.enqueueMemoryTasks(ingestPayload),
        );
      }

      if (ragResult && typeof ragResult === 'object') {
        const ragBlockCandidate = typeof ragResult.ragBlock === 'string'
          ? ragResult.ragBlock
          : ragResult.patchedSystemContent;

        const ragOriginalContextLength = Number(ragResult.originalContextLength) || 0;
        const ragSummaryLength = typeof ragBlockCandidate === 'string' ? ragBlockCandidate.length : 0;
        const shouldFallbackRagBlock =
          ragOriginalContextLength > 0 &&
          ragSummaryLength > ragOriginalContextLength * MAP_SUMMARY_GUARD_RATIO;

        if (typeof ragBlockCandidate === 'string' && ragBlockCandidate.trim()) {
          let effectiveRagBlock = ragBlockCandidate;
          if (shouldFallbackRagBlock) {
            logger.warn('[AgentClient][rag.guard_exceeded]', {
              conversationId: this.conversationId,
              summaryLength: ragSummaryLength,
              originalLength: ragOriginalContextLength,
              guardRatio: MAP_SUMMARY_GUARD_RATIO,
            });

            const fallbackVectorText = Array.isArray(ragResult?.vectorChunks)
              ? ragResult.vectorChunks.join('\n\n').trim()
              : typeof ragResult?.vectorText === 'string'
                ? ragResult.vectorText.trim()
                : '';

            const fallbackGraphLines = Array.isArray(ragResult?.graphLines) ? ragResult.graphLines : [];
            const fallbackPolicyIntro = typeof ragResult?.policyIntro === 'string' ? ragResult.policyIntro : '';

            if (fallbackVectorText || fallbackGraphLines.length || fallbackPolicyIntro) {
              effectiveRagBlock = buildRagBlock({
                policyIntro: fallbackPolicyIntro,
                graphLines: fallbackGraphLines,
                vectorText: fallbackVectorText || ragBlockCandidate,
              });
            } else {
              effectiveRagBlock = ragBlockCandidate.slice(0, ragOriginalContextLength || ragSummaryLength);
            }
          }
          const ragHash = createHash('sha256').update(ragBlockCandidate).digest('hex');
          if (ragHash !== blockRegistry.rag) {
            logger.debug('[diag.systemContent.pre_first_replace]', {
              conversationId: this.conversationId,
              systemContentLength: systemContent.length,
              containsBlockFooter: systemContent.includes('\n<!-- /RAG_CONTEXT_BLOCK -->\n'),
              containsPolicyIntroSnippet: systemContent.includes('Ниже предоставлен'),
              effectiveRagBlockLength: effectiveRagBlock?.length,
              effectiveRagBlockEndsWithFooter: effectiveRagBlock?.endsWith('\n<!-- /RAG_CONTEXT_BLOCK -->\n'),
              effectiveRagBlockContainsFooter: effectiveRagBlock?.includes('\n<!-- /RAG_CONTEXT_BLOCK -->\n'),
            });
            systemContent = replaceRagBlock(systemContent, effectiveRagBlock);
            syncBlockRegistryWithContent(systemContent);
            blockRegistry.rag = ragHash;
            rebalanceHistoryBudget('post_rag_patch', systemContent);
            logger.debug('[AgentClient][rag.applied]', {
              conversationId: this.conversationId,
              ragBlockLength: effectiveRagBlock.length,
              systemContentLength: systemContent.length,
            });
          } else {
            logger.debug('[AgentClient][rag.skip_duplicate]', {
              conversationId: this.conversationId,
              ragHash,
            });
          }
        }
        const contextLengthCandidate = Number(ragResult.contextLength);
        ragContextLength = Number.isFinite(contextLengthCandidate) ? contextLengthCandidate : 0;
        ragCacheStatus = ragResult.cacheStatus ?? ragCacheStatus;

        if (req) {
          req.ragCacheStatus = ragCacheStatus;
          if (ragResult.metrics && typeof ragResult.metrics === 'object') {
            req.ragMetrics = Object.assign({}, req.ragMetrics, ragResult.metrics);
          }
        }
      }

      if (ragContextLength > 0) {
        logger.info('[rag.context.applied]', {
          conversationId: this.conversationId,
          cacheStatus: ragCacheStatus,
          contextLength: ragContextLength,
          contextTokens: ragResult?.metrics?.contextTokens ?? 0,
          graphTokens: ragResult?.metrics?.graphTokens ?? 0,
          vectorTokens: ragResult?.metrics?.vectorTokens ?? 0,
        });
      }
    } catch (ragError) {
      logger.error('[rag.context.error]', {
        conversationId: this.conversationId,
        message: ragError?.message,
        stack: ragError?.stack,
      });
      if (req) {
        req.ragCacheStatus = 'error';
      }
    }

    if (this.options?.req) {
      this.options.req.ragContextLength = ragContextLength;
    }

    const shouldCondense = Boolean(
      runtimeCfg?.multiStepRag?.enabled &&
        multiStepResult?.entities?.length &&
        (req?.ragCondenseQuery ?? '').length === 0,
    );

    if (shouldCondense) {
      const lastUserMessage = orderedMessages[orderedMessages.length - 1];
      const lastUserText = lastUserMessage?.text || '';
      if (req && lastUserText) {
        req.ragCondenseQuery = lastUserText;
      }
      const deferred = getDeferredContext(req);
      if (deferred && deferred.vectorText?.length) {
        await this.applyDeferredCondensation({
          req,
          res,
          endpointOption,
          runtimeCfg,
          userQuery: lastUserText,
          systemContentRef: () => systemContent,
          updateSystemContent: (next) => {
            systemContent = next;
            syncBlockRegistryWithContent(systemContent);
            rebalanceHistoryBudget('post_deferred_apply_condense', systemContent);
          },
          deferredContext: deferred,
        });
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
      this.contextHandlers = toolsService.createPromptContextHandlers(
        this.options.req,
        orderedMessages[orderedMessages.length - 1].text,
      );
    }

    const formattedMessages = orderedMessages.map((message, i) => {
      if (i === orderedMessages.length - 1) {
        logger.debug('[AgentClient] last_message_pre_format', {
          conversationId: this.conversationId,
          role: message?.role,
          rawTextLength: message?.text?.length || 0,
          contentParts: Array.isArray(message?.content) ? message.content.length : 0,
        });
      }
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
        const maxOcrChars = Number(runtimeCfg?.limits?.promptPerMsgMax) > 0
          ? Number(runtimeCfg?.limits?.promptPerMsgMax)
          : 120000;
        let sanitizedOcr = message.ocr.trim();
        if (sanitizedOcr.length > maxOcrChars) {
          sanitizedOcr = sanitizedOcr.slice(0, maxOcrChars);
          logger.warn('[AgentClient][ocr.truncated]', {
            conversationId: this.conversationId,
            originalLength: message.ocr.length,
            truncatedLength: sanitizedOcr.length,
            maxOcrChars,
          });
        }
        const ocrHash = createHash('sha256').update(sanitizedOcr).digest('hex');
        if (ocrHash !== blockRegistry.ocr) {
          systemContent = replaceOcrBlock(systemContent, sanitizedOcr);
          syncBlockRegistryWithContent(systemContent);
          blockRegistry.ocr = ocrHash;
          rebalanceHistoryBudget('post_ocr_block', systemContent);
        } else {
          logger.info('[AgentClient][ocr.skip_duplicate]', {
            conversationId: this.conversationId,
            length: sanitizedOcr.length,
          });
        }
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

      formattedMessage.metadata = formattedMessage.metadata || {};
      orderedMessages[i] = orderedMessages[i] || {};
      orderedMessages[i].metadata = orderedMessages[i].metadata || {};

      if (!message.isCreatedByUser && i !== orderedMessages.length - 1) {
        formattedMessage.metadata.isRagContext = true;
        orderedMessages[i].metadata.isRagContext = true;
      }

      if (i === orderedMessages.length - 1) {
        const formattedLength = Array.isArray(formattedMessage.content)
          ? formattedMessage.content
              .filter((part) => part?.type === 'text' && typeof part.text === 'string')
              .reduce((sum, part) => sum + part.text.length, 0)
          : typeof formattedMessage.content === 'string'
            ? formattedMessage.content.length
            : 0;
        logger.debug('[AgentClient] last_message_post_format', {
          conversationId: this.conversationId,
          formattedLength,
          contentType: Array.isArray(formattedMessage.content)
            ? 'array'
            : typeof formattedMessage.content,
        });
      }

      return formattedMessage;
    });

    if (this.contextHandlers) {
      this.augmentedPrompt = await this.contextHandlers.createContext();
      const augmentedRegistry = this.options?.req?.augmentedPromptRegistry || new Map();
      if (this.options?.req && !this.options.req.augmentedPromptRegistry) {
        this.options.req.augmentedPromptRegistry = augmentedRegistry;
      }
      if (typeof this.augmentedPrompt === 'string' && this.augmentedPrompt.trim()) {
        const maxAugmentedChars = Number(runtimeCfg?.limits?.promptPerMsgMax) > 0
          ? Number(runtimeCfg?.limits?.promptPerMsgMax)
          : 120000;
        let trimmedAugmented = this.augmentedPrompt.trim();
        if (trimmedAugmented.length > maxAugmentedChars) {
          trimmedAugmented = trimmedAugmented.slice(0, maxAugmentedChars);
          logger.warn('[AgentClient][augmentedPrompt.truncated]', {
            conversationId: this.conversationId,
            originalLength: this.augmentedPrompt.length,
            truncatedLength: trimmedAugmented.length,
            maxAugmentedChars,
          });
        }
        const augmentedHash = createHash('sha256').update(trimmedAugmented).digest('hex');
        const registryHash = augmentedRegistry.get(this.conversationId);
        if (augmentedHash !== blockRegistry.augmented || augmentedHash !== registryHash) {
          systemContent = replaceAugmentedBlock(systemContent, trimmedAugmented);
          syncBlockRegistryWithContent(systemContent);
          blockRegistry.augmented = augmentedHash;
          augmentedRegistry.set(this.conversationId, augmentedHash);
          rebalanceHistoryBudget('post_augmented_block', systemContent);
          logger.info('[AgentClient][augmentedPrompt.applied]', {
            conversationId: this.conversationId,
            length: trimmedAugmented.length,
          });
        } else {
          logger.info('[AgentClient][augmentedPrompt.skip_duplicate]', {
            conversationId: this.conversationId,
            length: trimmedAugmented.length,
          });
        }
      }
      this.contextHandlers = null;
    }

    const ragSections = this.options?.req?.ragMultiStep?.ragContext
      ? await this.instructionsBuilder?.buildRagSections(this.options.req.ragMultiStep.ragContext, {
          getEncoding: () => this.getEncoding(),
          compressor: new MessageCompressorBridge({ reduction: historyCompressionCfg?.layer2Ratio ?? 0.25 }),
        })
      : '';

    let combinedSystemContent = systemContent;

    if (typeof ragSections === 'string' && ragSections.trim()) {
      const ragSectionsHash = createHash('sha256').update(ragSections).digest('hex');
      if (ragSectionsHash !== blockRegistry.ragSections) {
        logger.info('[AgentClient][ragSections.applied]', {
          conversationId: this.conversationId,
          ragSectionsLength: ragSections.length,
        });
      } else {
        logger.debug('[AgentClient][ragSections.skip_duplicate]', {
          conversationId: this.conversationId,
          ragSectionsHash,
        });
      }

      combinedSystemContent = replaceRagSectionsBlock(systemContent, ragSections);
      syncBlockRegistryWithContent(combinedSystemContent);
      blockRegistry.ragSections = ragSectionsHash;
      rebalanceHistoryBudget('post_rag_sections', combinedSystemContent);
    } else {
      const withoutRagSections = replaceRagSectionsBlock(systemContent, '');
      if (withoutRagSections !== systemContent) {
        combinedSystemContent = withoutRagSections;
        syncBlockRegistryWithContent(combinedSystemContent);
        rebalanceHistoryBudget('post_rag_sections_cleanup', combinedSystemContent);
      } else {
        combinedSystemContent = systemContent;
      }
      blockRegistry.ragSections = null;
    }

    const combinedSystemHash = createHash('sha256')
      .update(combinedSystemContent || '')
      .digest('hex');

    logger.info('[DIAG-PROMPT] combinedSystemContent.parts', {
      conversationId: this.conversationId,
      ragSectionsLength: ragSections?.length ?? 0,
      systemContentLength: systemContent?.length ?? 0,
      combinedLength: combinedSystemContent.length,
      combinedHash: combinedSystemHash,
    });

    instructions = normalizeInstructionsPayload(
      combinedSystemContent,
      () => this.getEncoding(),
      '[DIAG-PROMPT]',
    );
    logger.info(
      `[DIAG-PROMPT] Final instructions object created. Length: ${instructions.content.length}, Tokens: ${instructions.tokenCount}`,
    );

    if (
      this.clientName === EModelEndpoint.agents &&
      typeof instructions?.content === 'string' &&
      instructions.content.length
    ) {
      const patchedAgent = Object.assign({}, this.options?.agent, {
        instructions: instructions.content,
      });
      this.options.agent = patchedAgent;
      logger.debug('[AgentClient][instructions.patched]', {
        conversationId: this.conversationId,
        length: instructions.content.length,
      });
    }

    const tailCount = Math.min(2, formattedMessages.length);
    if (tailCount > 0) {
      const tail = formattedMessages.slice(-tailCount).map((message) => {
        const contentText = Array.isArray(message?.content)
          ? message.content
              .filter((part) => part?.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text)
              .join('\n')
          : typeof message?.content === 'string'
            ? message.content
            : '';
        const preview = contentText.slice(0, 120);
        return {
          role: message?.role,
          messageId: message?.messageId,
          length: contentText.length,
          preview,
        };
      });
      logger.info('[diag.prompt.tail_messages]', {
        conversationId: this.conversationId,
        tail,
      });
    }
    if (this.contextStrategy) {
   ({ payload, promptTokens, tokenCountMap, messages } = await this.handleContextStrategy({
     orderedMessages,
     formattedMessages,
     instructions,
   }));
   logger.debug('[prompt.payload]', {
     conversationId: this.conversationId,
     promptTokens,
     ragContextTokens: this.options?.req?.ragContextTokens ?? 0,
     instructionsTokens: instructions?.tokenCount ?? 0,
     messageCount: messages.length,
   });
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

    this.promptTokenContext = agentUsageService.buildPromptTokenContext({
      conversationId: this.conversationId,
      instructionsTokens: instructions?.tokenCount,
      ragMetrics: this.options?.req?.ragMetrics,
      orderedMessages,
      promptTokensEstimate: promptTokens,
    });

    if (promptTokens >= 0 && typeof opts?.getReqData === 'function') {
      opts.getReqData({ promptTokens });
    }

    const withoutKeys = await this.useMemory();
    if (withoutKeys) {
      logger.debug('[AgentClient] Memory (withoutKeys) generated but not explicitly added to prompt, as system message already formed.');
    }

    return result;
  }

  async awaitMemoryWithTimeout(memoryPromise, timeoutMs = 3000) {
    return memoryService.awaitMemoryWithTimeout(memoryPromise, timeoutMs, logger);
  }

  async useMemory() {
    const { withoutKeys, processMemory } = await memoryService.useMemory({
      req: this.options.req,
      res: this.options.res,
      agent: this.options.agent,
      responseMessageId: this.responseMessageId,
      conversationId: this.conversationId,
      logger,
    });

    this.processMemory = processMemory;
    return withoutKeys;
  }

  async enrichContextWithMemoryAgent(messages) {
    return memoryService.enrichContextWithMemoryAgent({
      messages,
      processMemory: this.processMemory,
      req: this.options.req,
      logger,
    });
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
    const modelName = this.options.agent.model_parameters?.model ?? this.model;

    const { usage } = await agentUsageService.recordCollectedUsage({
      model: model ?? modelName,
      balance,
      transactions,
      context,
      collectedUsage,
      conversationId: this.conversationId,
      user: this.user ?? this.options.req.user?.id,
      endpointTokenConfig: this.options.endpointTokenConfig,
      currentMessages: Array.isArray(this.currentMessages) ? this.currentMessages : [],
      ragCacheStatus: this.options.req?.ragCacheStatus,
      pricingOverride: this.options?.req?.pricing,
    });

    if (usage) {
      this.usage = usage;
    }
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
    return TokenCounter.calculateCurrentTokenCount({
      tokenCountMap,
      currentMessageId,
      usage,
      inputTokensKey: this.inputTokensKey,
    });
  }

  async chatCompletion({ payload, userMCPAuthMap, abortController = null }) {
    let config;
    let run;
    let memoryPromise;
    let retryAttempt = 0;
    const MAX_RETRIES = 2;
    
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
    logger.debug('[diag][fmt] payload stats', {
      messageCount: diag.length,
      topEntries: top.map((t) => `#${t.i}:${t.role}:${t.len}`),
    });
      } catch (e) {
    logger.error('[diag][fmt] log error', { message: e?.message, stack: e?.stack });
      }

      const runAgent = async (agent, _messages, i = 0, contentData = [], _currentIndexCountMap) => {
        try {
          this.trace('trace:agent.run', {
            provider: agent?.provider,
            model: agent?.model_parameters?.model,
            chainWindow: configService.get('features.geminiChainWindow', 'default'),
            chainBuffer: configService.get('features.googleChainBuffer', 'off'),
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

        const systemMessage = toolsService.buildToolSystemMessage(agent.toolContextMap);

        let instructionsForLangChain = null;
        if (typeof agent.instructions === 'string' && agent.instructions.length > 0) {
            instructionsForLangChain = new SystemMessage({ content: agent.instructions });
        } else if (agent.instructions instanceof SystemMessage) {
            instructionsForLangChain = agent.instructions;
        }

        const rawToolContext = typeof systemMessage === 'string' ? systemMessage : '';
        const rawInstructions = instructionsForLangChain?.content ?? '';
        const rawAdditional = i !== 0 ? agent.additional_instructions ?? '' : '';

        let systemContent = rawInstructions;
        if (rawToolContext && !systemContent.includes(rawToolContext)) {
          systemContent = [rawToolContext, systemContent].filter(Boolean).join('\n').trim();
        }
        if (rawAdditional && !systemContent.includes(rawAdditional)) {
          systemContent = [systemContent, rawAdditional].filter(Boolean).join('\n').trim();
        }

        const systemContentHash = createHash('sha256').update(systemContent).digest('hex');

        logger.info('[AgentClient][systemContent.parts]', {
          conversationId: this.conversationId,
          agentId: agent.id,
          toolContextLength: rawToolContext.length,
          instructionsLength: rawInstructions.length,
          additionalLength: rawAdditional.length,
          totalLength: systemContent.length,
          systemContentHash,
        });

        if (!systemContent || systemContent.length === 0) {
          systemContent = DEFAULT_SYSTEM_PROMPT;
          logger.debug(`[AgentClient][runAgent:${agent.id}] Applied default system prompt`);
        }

        const normalizedSystem = normalizeInstructionsPayload(
          systemContent,
          () => this.getEncoding(),
          `[AgentClient][runAgent:${agent.id}]`,
        );
        systemContent = normalizedSystem.content;

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
          let latestMessageContent = _messages[_messages.length - 1].content;
          if (typeof latestMessageContent !== 'string') {
            latestMessageContent[0].text = [systemContent, latestMessageContent[0].text].join('\n');
            _messages[_messages.length - 1] = new HumanMessage({ content: latestMessageContent });
          } else {
            const text = [systemContent, latestMessageContent].join('\n');
            _messages[_messages.length - 1] = new HumanMessage(text);
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
          memoryPromise = this.enrichContextWithMemoryAgent(messages);
        }

        if (agent.model_parameters?.configuration?.defaultHeaders != null) {
          agent.model_parameters.configuration.defaultHeaders = resolveHeaders({
            headers: agent.model_parameters.configuration.defaultHeaders,
            body: config.configurable.requestBody,
          });
        }

        logger.debug('[agent.run.debug] Agent configuration', {
          conversationId: this.conversationId,
          agentId: agent.id,
          agentName: agent.name,
          provider: agent.provider,
          model: agent.model_parameters?.model,
          messagesCount: messages.length,
          systemContentLength: systemContent?.length || 0,
          hasInstructions: Boolean(agent.instructions),
          instructionsType: agent.instructions?.constructor?.name,
          recursionLimit: config.recursionLimit,
        });

        logger.debug('[agent.run.request] Request to model', {
          conversationId: this.conversationId,
          agentId: agent.id,
          model: agent.model_parameters?.model,
          provider: agent.provider,
          baseURL: agent.model_parameters?.configuration?.baseURL,
          messagesPreview: messages.slice(0, 2).map(m => ({
            role: typeof m._getType === 'function' ? m._getType() : m.role,
            contentLength: typeof m.content === 'string'
              ? m.content.length
              : (() => {
                  try {
                    return JSON.stringify(m.content).length;
                  } catch {
                    return 0;
                  }
                })(),
          })),
        });

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
          this.eventService.sendEvent(this.options.res, streamData);
          contentData.push(agentUpdate);
          run.Graph.contentData = contentData;
        }

        if (userMCPAuthMap != null) {
          config.configurable.userMCPAuthMap = userMCPAuthMap;
        }
        
        logger.debug('[agent.run.processStream] Starting stream processing', {
          conversationId: this.conversationId,
          agentId: agent.id,
          messagesCount: messages.length,
          maxContextTokens: agent.maxContextTokens,
        });
        
        await run.processStream({ messages }, config, {
          keepContent: i !== 0,
          tokenCounter: TokenCounter.createCounter(this.getEncoding()),
          indexTokenCountMap: currentIndexCountMap,
          maxContextTokens: agent.maxContextTokens,
          callbacks: {
            [Callback.TOOL_ERROR]: toolsService.logToolError,
          },
        });

        config.signal = null;
      };

      while (retryAttempt <= MAX_RETRIES) {
        try {
          await runAgent(this.options.agent, initialMessages);
          break;
        } catch (runError) {
          if (detectContextOverflow(runError) && retryAttempt < MAX_RETRIES) {
            retryAttempt++;
            const reductionFactor = 0.3 + (retryAttempt * 0.2);

            try {
              const overflowCfgSafe = configService.get('limits.overflow', {});
              const guardResult = await applyOverflowGuard({
                messages: initialMessages,
                encoding: this.getEncoding(),
                ragCondenseContext: ragCondense,
                loggerContext: {
                  conversationId: this.conversationId,
                  requestId: this.options?.req?.requestId,
                  userId: this.options?.req?.user?.id,
                },
                endpointOption:
                  this.options?.req?.body?.endpointOption ?? this.options?.endpointOption ?? {},
                req: this.options?.req,
                res: this.options?.res,
                config: {
                  enabled: true,
                  enableAdvancedProcessing: overflowCfgSafe?.enableAdvancedProcessing ?? true,
                  enableRagProcessing: overflowCfgSafe?.enableRagProcessing ?? true,
                  enableChunkingProcessing: overflowCfgSafe?.enableChunkingProcessing ?? true,
                  chunkingThresholdTokens: overflowCfgSafe?.chunkingThresholdTokens ?? 100000,
                  ragThresholdTokens: overflowCfgSafe?.ragThresholdTokens ?? 500000,
                  hardTruncateCapTokens: overflowCfgSafe?.hardTruncateCapTokens ?? 80000,
                  preserveHeadTail: overflowCfgSafe?.preserveHeadTail ?? true,
                  summaryTimeoutMs: overflowCfgSafe?.summaryTimeoutMs ?? 120000,
                  summaryProvider: overflowCfgSafe?.summaryProvider ?? condenseConfig?.provider ?? 'auto',
                  summaryCacheTtlMs: overflowCfgSafe?.summaryCacheTtlMs ?? 86_400_000,
                  maxUserMsgToModelChars: agentsConfig?.thresholds?.maxUserMessageChars ?? 0,
                  dynamicBudgetTokens: Math.max(
                    1,
                    Math.floor(this.maxContextTokens * 0.55),
                  ),
                  noticeRag:
                    '[Система] Получен большой текст. Запускаю фоновую обработку и пришлю сводку после завершения.',
                  noticeTruncate:
                    'Часть вашего сообщения была сокращена из-за технических ограничений. Пришлите продолжение или уточните запрос, если нужно учесть весь текст.',
                },
              });

              if (guardResult?.action === 'rag_defer') {
                this.contentParts = this.contentParts || [];
                this.contentParts.push({
                  type: ContentTypes.TEXT,
                  [ContentTypes.TEXT]: guardResult.notice,
                });
                return;
              }

              if (guardResult?.action === 'hard_truncate' && guardResult.notice) {
                this.contentParts = this.contentParts || [];
                this.contentParts.push({
                  type: ContentTypes.TEXT,
                  [ContentTypes.TEXT]: guardResult.notice,
                });
              }

              if (guardResult?.action && guardResult.action !== 'none') {
                initialMessages = guardResult.messages;
              }
            } catch (guardError) {
              logger.warn('[context.overflow.guard_error]', {
                conversationId: this.conversationId,
                message: guardError?.message,
              });
            }
            
            logger.warn('[context.overflow.retry]', {
              conversationId: this.conversationId,
              attempt: retryAttempt,
              maxRetries: MAX_RETRIES,
              reductionFactor,
              originalError: runError?.message,
            });

            initialMessages = compressMessagesForRetry(initialMessages, reductionFactor);
            
            logger.info('[context.overflow.compressed]', {
              conversationId: this.conversationId,
              attempt: retryAttempt,
              newMessageCount: initialMessages.length,
              reductionFactor,
            });

            await new Promise(resolve => setTimeout(resolve, 500 * retryAttempt));
            continue;
          }
          
          throw runError;
        }
      }

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
        const tokenCounter = TokenCounter.createCounter(encoding);
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

      if (detectContextOverflow(err) && retryAttempt >= MAX_RETRIES) {
        logger.error('[context.overflow.max_retries]', {
          conversationId: this.conversationId,
          attempts: retryAttempt,
          message: 'Max retries reached for context overflow',
        });
        
        this.contentParts = this.contentParts || [];
        this.contentParts.push({
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: 'Context window exceeded. Please try with a shorter conversation history or reduce the amount of context.',
        });
        return;
      }

      const errorDetails = {
        message: err?.message,
        code: err?.code,
        name: err?.name,
        status: err?.response?.status || err?.status,
        statusText: err?.response?.statusText || err?.statusText,
        responseData: err?.response?.data || err?.error,
        requestData: err?.request ? {
          method: err?.request?.method,
          url: err?.request?.url,
          path: err?.request?.path,
        } : undefined,
        stack: err?.stack,
        conversationId: this.conversationId,
        agentId: this.options?.agent?.id,
        model: this.options?.agent?.model_parameters?.model,
        provider: this.options?.agent?.provider,
      };
      
      logger.error(
        '[api/server/controllers/agents/client.js #sendCompletion] Unhandled error',
        errorDetails,
      );
      
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
    const ollamaConfig = configService.get('providers.ollama', {});
    const USE_OLLAMA_FOR_TITLES = configService.getBoolean('features.useOllamaForTitles', false);
    const OLLAMA_TITLE_URL = ollamaConfig.url || 'http://127.0.0.1:11434';
    const OLLAMA_TITLE_MODEL_NAME = this.options.titleModel || ollamaConfig.titleModel || 'gemma:7b-instruct';

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
            logger.warn('[title] Ollama title generation failed or returned empty. Falling back.', {
              response: response.data,
            });
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
    await agentUsageService.recordTokenUsage({
      model,
      usage,
      balance,
      promptTokens,
      completionTokens,
      context,
      conversationId: this.conversationId,
      user: this.user ?? this.options.req.user?.id,
      endpointTokenConfig: this.options.endpointTokenConfig,
    });
  }

  getEncoding() {
    const model = this.options?.agent?.model_parameters?.model || this.model;
    if (model && /gemini/i.test(model)) {
        return 'cl100k_base';
    }
    return 'o200k_base';
  }

  getTokenCount(text) {
    const encoding = this.getEncoding();
    return Tokenizer.getTokenCount(text, encoding);
  }

  emitPromptTokenBreakdown(
    {
      promptTokens: promptTokens,
      cacheRead: cacheRead = 0,
      cacheWrite: cacheWrite = 0,
      reasoningTokens: reasoningTokens = 0
    }
  ) {
    if (!this.promptTokenContext) {
      return;
    }

    const breakdown = agentUsageService.emitPromptTokenBreakdown({
      promptTokenContext: this.promptTokenContext,
      promptTokens,
      cacheRead,
      cacheWrite,
      reasoningTokens,
    });

    this.promptTokenBreakdown = breakdown;
  }

  async applyDeferredCondensation({
    req,
    res,
    endpointOption,
    runtimeCfg,
    userQuery,
    systemContentRef,
    updateSystemContent,
    deferredContext,
  }) {
    return applyDeferredCondensation({
      req,
      res,
      endpointOption,
      runtimeCfg,
      userQuery,
      systemContentRef,
      updateSystemContent,
      deferredContext,
      encoding: this.getEncoding(),
      logger,
      conversationId: this.conversationId,
      maxContextTokens: this.maxContextTokens,
    });
  }
}

module.exports = AgentClient;
