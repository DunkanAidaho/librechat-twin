'use strict';

function extractFromReq(req = {}) {
  return {
    requestId: req.context?.requestId,
    conversationId:
      req.body?.conversationId || req.params?.conversationId || req.query?.conversationId || undefined,
    userId: req.user?.id,
    agentId: req.body?.agentId || req.params?.agentId || undefined,
  };
}

function buildContext(source, extra = {}) {
  if (!source) {
    return { ...extra };
  }

  if (source.context || source.user || source.body || source.params || source.query) {
    return {
      ...extractFromReq(source),
      ...extra,
    };
  }

  return {
    requestId: source.requestId,
    conversationId: source.conversationId,
    userId: source.userId,
    agentId: source.agentId,
    ...extra,
  };
}

module.exports = {
  buildContext,
};