'use strict';

const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');
const { withTimeout, createAbortError } = require('~/utils/async');
const { observeSegmentTokens, setContextLength } = require('~/utils/ragMetrics');

const DEFAULT_TIMEOUT_MS = 20000;
const logger = getLogger('rag.multiStep');

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

async function enqueueFollowUp({
  entity,
  passIndex,
  enqueueMemoryTasks,
  signal,
  timeoutMs,
  userId,
  conversationId,
  context,
}) {
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
  const baseContext =
    context || buildContext({ conversationId, userId }, { entity: entity.name, passIndex });
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
    logger.info(
      'rag.multiStep.memory_enqueue',
      buildContext(baseContext, {
        durationMs: Date.now() - start,
        outcome: status,
      }),
    );

    return { status };
  } catch (error) {
    const duration = Date.now() - start;
    const outcome = error?.name === 'AbortError' ? 'aborted' : 'failed';
    logger.error(
      'rag.multiStep.memory_error',
      buildContext(baseContext, {
        durationMs: duration,
        outcome,
        err: error,
      }),
    );
    return { status: outcome };
  }
}

async function fetchGraph({
  fetchGraphContext,
  entity,
  passIndex,
  config,
  signal,
  baseContext,
  relationHints,
}) {
  if (!fetchGraphContext || !entity) {
    return { lines: [], status: 'skipped' };
  }

  const ctx = baseContext
    ? buildContext(baseContext, { entity: entity.name, passIndex })
    : buildContext({}, { entity: entity.name, passIndex });
  try {
    const graphContext = await withTimeout(
      fetchGraphContext({
        entity: entity.name,
        relationHints: relationHints || entity.hints,
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
    logger.info(
      'rag.multiStep.graph_fetch',
      buildContext(ctx, {
        lines: lines.length,
      }),
    );
    return { lines, status: 'ok' };
  } catch (error) {
    const outcome = error?.name === 'AbortError' ? 'aborted' : 'failed';
    logger.error(
      'rag.multiStep.graph_error',
      buildContext(ctx, {
        outcome,
        err: error,
      }),
    );
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
    logger.warn('rag.multiStep.metrics_error', buildContext({}, { err: error }));
  }
}

function collectGlobalGraphHints({ graphQueryHint, graphContextLines, maxHints = 6 }) {
  const safeGraphLines = Array.isArray(graphContextLines) ? graphContextLines : [];
  const safeHint = typeof graphQueryHint === 'string' ? graphQueryHint : '';
  const hints = [];
  const pushHint = (value) => {
    if (!value || hints.length >= maxHints) {
      return;
    }
    const trimmed = String(value).replace(/\s+/g, ' ').trim();
    if (!trimmed) {
      return;
    }
    hints.push(trimmed.slice(0, 200));
  };

  if (safeHint) {
    pushHint(safeHint);
  }

  for (const rawLine of safeGraphLines) {
    const line = typeof rawLine === 'string' ? rawLine : '';
    const segments = line
      .split(/-->/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    for (const segment of segments) {
      pushHint(segment);
      if (hints.length >= maxHints) {
        break;
      }
    }
    if (hints.length >= maxHints) {
      break;
    }
  }

  return Array.from(new Set(hints)).slice(0, maxHints);
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
  graphContextLines = [],
  graphQueryHint = '',
}) {
  const config = runtimeCfg?.multiStepRag || {};
  const requestId = baseContext?.context?.requestId || baseContext?.requestId;
  const baseLogContext = buildContext(
    { conversationId, userId, requestId },
    { endpoint, model },
  );
  const safeGraphLines = Array.isArray(graphContextLines) ? graphContextLines : [];
  const safeGraphHint = typeof graphQueryHint === 'string' ? graphQueryHint : '';
  if (!config.enabled) {
    return {
      globalContext: baseContext,
      entities: [],
      passesUsed: 0,
      queueStatus: { memory: 'skipped', graph: 'skipped' },
    };
  }

  if (!safeGraphLines.length && !safeGraphHint) {
    logger.debug(
      'rag.multiStep.graph_context.empty',
      buildContext(baseLogContext, { reason: 'no_graph_data' }),
    );
  }

  const entities = normalizeEntities(intentAnalysis, config.maxEntities);
  if (entities.length === 0) {
    logger.info('rag.multiStep.fallback_entities_missing', buildContext(baseLogContext, {
      intentProvided: Boolean(intentAnalysis),
    }));
  }

  const entityStates = entities.map(createEntityState);
  const globalGraphHints = collectGlobalGraphHints({
    graphQueryHint: safeGraphHint,
    graphContextLines: safeGraphLines,
    maxHints: config?.graph?.maxHints || 6,
  });
  const queueStatus = { memory: 'skipped', graph: 'skipped' };
  let passesUsed = 0;

  for (let passIndex = 0; passIndex < config.maxPasses; passIndex++) {
    if (signal?.aborted) {
      throw createAbortError(signal);
    }

    passesUsed = passIndex;
    logger.info(
      'rag.multiStep.pass_start',
      buildContext(baseLogContext, {
        passIndex,
        entities: entityStates.map((e) => e.name),
      }),
    );

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
        baseContext: baseLogContext,
        relationHints: Array.from(
          new Set([...(entityState.hints || []), ...globalGraphHints]),
        ),
      });

      logger.info(
        'rag.multiStep.graph_result',
        buildContext(baseLogContext, {
          entity: entityState.name,
          passIndex,
          lines: graphResult.lines?.length || 0,
          status: graphResult.status,
        }),
      );

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
        context: baseLogContext,
      });

      logger.info(
        'rag.multiStep.vector_enqueue',
        buildContext(baseLogContext, {
          entity: entityState.name,
          passIndex,
          status: memoryResult.status,
        }),
      );

      queueStatus.memory = memoryResult.status;
    }

    const shouldStop = entityStates.every(
      (entity) => entity.graphLines.length >= (config.graph?.maxLines ?? 0),
    );

    if (shouldStop) {
      break;
    }
  }

  logger.info(
    'rag.multiStep.summary',
    buildContext(baseLogContext, {
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
    }),
  );

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
