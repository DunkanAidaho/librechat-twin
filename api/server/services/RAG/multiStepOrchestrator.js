'use strict';

const { logger } = require('@librechat/data-schemas');
const { withTimeout, createAbortError } = require('~/utils/async');
const { observeSegmentTokens, setContextLength } = require('~/utils/ragMetrics');

const DEFAULT_TIMEOUT_MS = 20000;

function normalizeEntities(intentAnalysis = {}, maxEntities = 3) {
  const entities = Array.isArray(intentAnalysis?.entities)
    ? intentAnalysis.entities
    : [];
  return entities
    .filter((entity) => entity?.name)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, maxEntities)
    .map((entity) => ({
      name: entity.name,
      type: entity.type || 'unknown',
      confidence: Number(entity.confidence) || 0,
      hints: Array.isArray(entity.hints) ? entity.hints : [],
    }));
}

function createEntityState(entity) {
  return {
    name: entity.name,
    type: entity.type,
    confidence: entity.confidence,
    hints: entity.hints,
    passes: 0,
    graphLines: [],
    vectorChunks: [],
    tokens: 0,
  };
}

async function enqueueFollowUp({ entity, passIndex, enqueueMemoryTasks, signal, timeoutMs, userId, conversationId }) {
  if (!enqueueMemoryTasks || !entity) {
    return { status: 'skipped' };
  }

  const task = {
    type: 'rag_followup',
    payload: {
      entity: entity.name,
      hints: entity.hints,
      passIndex,
      user_id: userId,
      conversation_id: conversationId,
    },
  };

  const start = Date.now();
  try {
    const promise = enqueueMemoryTasks([task], {
      reason: `rag_followup:${entity.name}`,
      conversationId,
      userId,
      fireAndForget: true,
    });

    const result = await withTimeout(
      promise,
      timeoutMs,
      'follow-up enqueue timed out',
      signal,
    );

    const status = result?.status || 'queued_async';
    logger.info('[rag.followup.memory]', {
      entity: entity.name,
      passIndex,
      duration: Date.now() - start,
      outcome: status,
    });

    return { status };
  } catch (error) {
    const duration = Date.now() - start;
    const outcome = error?.name === 'AbortError' ? 'aborted' : 'failed';
    logger.error('[rag.followup.memory.error]', {
      entity: entity.name,
      passIndex,
      duration,
      outcome,
      message: error?.message,
    });
    return { status: outcome };
  }
}

async function fetchGraph({ fetchGraphContext, entity, passIndex, config, signal }) {
  if (!fetchGraphContext || !entity) {
    return { lines: [], status: 'skipped' };
  }

  try {
    const graphContext = await withTimeout(
      fetchGraphContext({
        entity: entity.name,
        relationHints: entity.hints,
        limit: config?.maxLines,
        timeoutMs: config?.timeoutMs || DEFAULT_TIMEOUT_MS,
        signal,
      }),
      config?.timeoutMs || DEFAULT_TIMEOUT_MS,
      'Graph follow-up timed out',
      signal,
    );

    if (!graphContext) {
      return { lines: [], status: 'empty' };
    }

    const lines = Array.isArray(graphContext.lines) ? graphContext.lines : [];
    logger.info('[rag.followup.graph]', {
      entity: entity.name,
      passIndex,
      lines: lines.length,
    });
    return { lines, status: 'ok' };
  } catch (error) {
    const outcome = error?.name === 'AbortError' ? 'aborted' : 'failed';
    logger.error('[rag.followup.graph.error]', {
      entity: entity.name,
      passIndex,
      outcome,
      message: error?.message,
    });
    return { lines: [], status: outcome };
  }
}

function accumulateTokens(entityState, segment, tokens, length, endpoint, model) {
  if (!tokens) {
    return;
  }

  entityState.tokens += tokens;
  try {
    observeSegmentTokens({
      segment,
      tokens,
      endpoint,
      model,
    });
    setContextLength({
      segment,
      length,
      endpoint,
      model,
    });
  } catch (error) {
    logger.warn('[rag.followup.metrics.error]', { message: error?.message });
  }
}

async function runMultiStepRag({
  intentAnalysis,
  runtimeCfg,
  baseContext,
  fetchGraphContext,
  enqueueMemoryTasks,
  conversationId,
  userId,
  endpoint,
  model,
  signal,
}) {
  const config = runtimeCfg?.multiStepRag || {};
  if (!config.enabled) {
    return {
      globalContext: baseContext,
      entities: [],
      passesUsed: 0,
      queueStatus: { memory: 'skipped', graph: 'skipped' },
    };
  }

  const entities = normalizeEntities(intentAnalysis, config.maxEntities);
  if (entities.length === 0) {
    logger.info('[rag.context.multiStep.skip]', {
      conversationId,
      reason: 'no_entities',
    });
    return {
      globalContext: baseContext,
      entities: [],
      passesUsed: 0,
      queueStatus: { memory: 'skipped', graph: 'skipped' },
    };
  }

  const entityStates = entities.map(createEntityState);
  const queueStatus = { memory: 'skipped', graph: 'skipped' };
  let passesUsed = 0;

  for (let passIndex = 0; passIndex < config.maxPasses; passIndex++) {
    if (signal?.aborted) {
      throw createAbortError(signal);
    }

    passesUsed = passIndex;
    logger.info('[rag.followup.pass]', {
      conversationId,
      passIndex,
      entities: entityStates.map((e) => e.name),
    });

    if (passIndex === 0) {
      continue;
    }

    for (const entityState of entityStates) {
      entityState.passes += 1;

      const graphResult = await fetchGraph({
        fetchGraphContext:
          config.graph?.followUp === false ? null : fetchGraphContext,
        entity: entityState,
        passIndex,
        config: config.graph,
        signal,
      });

      logger.info('[rag.followup.graph]', {
        entity: entityState.name,
        passIndex,
        lines: graphResult.lines?.length || 0,
        status: graphResult.status,
      });

      if (graphResult.lines?.length) {
        entityState.graphLines.push(...graphResult.lines);
        queueStatus.graph = graphResult.status || 'ok';
        accumulateTokens(
          entityState,
          'rag_graph_followup',
          graphResult.lines.join('\n').length / 4,
          graphResult.lines.join('\n').length,
          endpoint,
          model,
        );
      }

      const memoryResult = await enqueueFollowUp({
        entity: entityState,
        passIndex,
        enqueueMemoryTasks,
        signal,
        timeoutMs: config.followUpTimeoutMs || DEFAULT_TIMEOUT_MS,
        userId,
        conversationId,
      });

      logger.info('[rag.followup.vector]', {
        entity: entityState.name,
        passIndex,
        status: memoryResult.status,
      });

      queueStatus.memory = memoryResult.status;
    }

    const shouldStop = entityStates.every(
      (entity) => entity.graphLines.length >= (config.graph?.maxLines ?? 0),
    );

    if (shouldStop) {
      break;
    }
  }

  logger.info('[rag.context.multiStep]', {
    conversationId,
    entities: entityStates.map((entity) => ({
      name: entity.name,
      passes: entity.passes,
      tokens: entity.tokens,
      graphLines: entity.graphLines.length,
      vectorChunks: entity.vectorChunks.length,
    })),
    globalTokens: baseContext?.length || 0,
    queueStatus,
    passesUsed,
  });

  return {
    globalContext: baseContext,
    entities: entityStates,
    passesUsed,
    queueStatus,
  };
}

module.exports = {
  runMultiStepRag,
};
