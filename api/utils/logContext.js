'use strict';

function extractFromReq(req = {}) {
  if (!req || typeof req !== 'object') {
    return {};
  }

  const requestId =
    req.context?.requestId || req.headers?.['x-request-id'] || req.headers?.['x-trace-id'];
  const conversationId =
    req.conversationId ||
    req.body?.conversationId ||
    req.params?.conversationId ||
    req.query?.conversationId;
  const userId = req.user?.id || req.body?.userId;
  const agentId = req.body?.agentId || req.params?.agentId;

  return {
    requestId,
    conversationId,
    userId,
    agentId,
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

function getRequestContext(req) {
  if (!req) {
    return {};
  }
  return extractFromReq(req);
}

module.exports = {
  buildContext,
  getRequestContext,
};