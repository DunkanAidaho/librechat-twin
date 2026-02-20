'use strict';

const configService = require('~/server/services/Config/ConfigService');

let memoized;

function buildMemoryConfig() {
  const memory = configService.getSection('memory');
  const rag = configService.getSection('rag');
  const logging = configService.getSection('logging');
  const pricing = configService.get('pricing', {});
  const limits = configService.getSection('limits');
  const historyCompression = configService.getSection('historyCompression');
  const multiStepRag = configService.getSection('multiStepRag');

  return Object.freeze({
    useConversationMemory: memory.useConversationMemory,
    enableMemoryCache: memory.enableMemoryCache ?? memory.useConversationMemory,
    ragCacheTtl: rag.cache?.ttl ?? 900,
    memoryActivationThreshold: memory.activationThreshold ?? 6,
    tokenLimits: Object.freeze({
      maxMessageTokens: limits.token?.maxMessageTokens ?? 0,
      truncateLongMessages: limits.token?.truncateLongMessages ?? true,
      maxUserMessageChars: limits.maxUserMsgToModelChars ?? 0,
      promptPerMsgMax: limits.promptPerMsgMax ?? 0,
    }),
    history: Object.freeze({
      dontShrinkLastN: limits.dontShrinkLastN ?? 4,
      tokenBudget: memory.history?.tokenBudget ?? 8000,
    }),
    historyCompression: Object.freeze({
      enabled: historyCompression.enabled,
      layer1Ratio: historyCompression.layer1Ratio,
      layer2Ratio: historyCompression.layer2Ratio,
      contextHeadroom: historyCompression.contextHeadroom,
    }),
    toolsGateway: Object.freeze({
      url: rag.gateway?.url ?? 'http://127.0.0.1:8000',
      timeoutMs: rag.gateway?.timeoutMs ?? 20000,
    }),
    ragQuery: Object.freeze({
      maxChars: rag.query?.maxChars ?? 6000,
    }),
    graphContext: Object.freeze({
      maxLines: rag.graph?.maxLines ?? 8,
      maxLineChars: rag.graph?.maxLineChars ?? 200,
      summaryLineLimit: rag.graph?.summaryLineLimit ?? 8,
      summaryHintMaxChars: rag.graph?.summaryHintMaxChars ?? 2000,
    }),
    vectorContext: Object.freeze({
      maxChunks: rag.vector?.maxChunks ?? 3,
      maxChars: rag.vector?.maxChars ?? 2000,
      topK: rag.vector?.topK ?? 12,
      embeddingModel: rag.vector?.embeddingModel ?? 'mxbai',
    }),
    summarization: Object.freeze({
      enabled: rag.summarization?.enabled ?? true,
      budgetChars: rag.summarization?.budgetChars ?? 12000,
      chunkChars: rag.summarization?.chunkChars ?? 20000,
      provider: rag.summarization?.provider ?? '',
    }),
    logging: Object.freeze({
      tokenUsageReportMode: logging.tokenUsageReportMode ?? 'json',
    }),
    pricing: Object.freeze({
      apiKey: pricing.apiKey ?? '',
      url: pricing.url ?? '',
      refreshIntervalSec: pricing.refreshIntervalSec ?? 86400,
      cachePath: pricing.cachePath ?? './api/cache/openrouter_pricing.json',
    }),
    multiStepRag: Object.freeze({
      enabled: multiStepRag.enabled,
      maxEntities: multiStepRag.maxEntities,
      maxPasses: multiStepRag.maxPasses,
      graphRetryLimit: multiStepRag.graphRetryLimit,
      followUpTimeoutMs: multiStepRag.followUpTimeoutMs,
    }),
  });
}

function getMemoryConfig() {
  if (!memoized) {
    memoized = buildMemoryConfig();
  }
  return memoized;
}

function refreshMemoryConfig() {
  memoized = buildMemoryConfig();
  return memoized;
}

module.exports = {
  getMemoryConfig,
  refreshMemoryConfig,
};
