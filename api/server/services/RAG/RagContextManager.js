"use strict";

const { sanitizeInput } = require("~/utils/security");

const POLICY_INTRO =
  'Ниже предоставлен внутренний контекст для твоего сведения: граф знаний и выдержки из беседы. ' +
  'Используй эти данные для формирования точного и полного ответа. ' +
  'Категорически запрещается цитировать или пересказывать этот контекст, особенно строки, содержащие "-->". ' +
  'Эта информация предназначена только для твоего внутреннего анализа.\n\n';

const GRAPH_TITLE = "### Graph context";
const VECTOR_TITLE = "### Vector context";
const BLOCK_FOOTER = "---\n\n";

function coerceLines(lines) {
  if (!Array.isArray(lines)) {
    return [];
  }
  return lines
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter(Boolean);
}

function buildRagBlock({ policyIntro = POLICY_INTRO, graphLines = [], vectorText = "" } = {}) {
  const safeGraphLines = coerceLines(graphLines);
  const graphSection = safeGraphLines.length
    ? `${GRAPH_TITLE}\n${safeGraphLines.join("\n")}\n\n`
    : "";

  const trimmedVector = typeof vectorText === "string" ? vectorText.trim() : "";
  const vectorSection = trimmedVector ? `${VECTOR_TITLE}\n${trimmedVector}\n\n` : "";

  const block = `${policyIntro}${graphSection}${vectorSection}${BLOCK_FOOTER}`;
  return sanitizeInput(block);
}

function replaceRagBlock(systemContent = "", newBlock = "") {
  const safeBlock = sanitizeInput(newBlock);
  if (typeof systemContent !== "string" || !systemContent.trim()) {
    return safeBlock + (systemContent || "");
  }

  const introSnippet = POLICY_INTRO.slice(0, 16).trim();
  const introIndex = systemContent.indexOf(introSnippet);
  if (introIndex === -1) {
    return safeBlock + systemContent;
  }

  const suffix = systemContent.slice(introIndex).replace(/^[\s\S]*?---\n\n/, "");
  return `${safeBlock}${suffix}`;
}

function setDeferredContext(req, context = null) {
  if (!req) return;
  if (context) {
    req.deferredRagContext = {
      ...context,
      createdAt: Date.now(),
    };
  } else {
    delete req.deferredRagContext;
  }
}

function getDeferredContext(req) {
  const snapshot = req?.deferredRagContext;
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }
  const { policyIntro, graphLines, vectorText, vectorChunks } = snapshot;
  if (!Array.isArray(graphLines) || typeof vectorText !== 'string') {
    return null;
  }
  return snapshot;
}

function consumeDeferredContext(req) {
  const snapshot = getDeferredContext(req);
  if (snapshot) {
    delete req.deferredRagContext;
  }
  return snapshot;
}

function clearDeferredContext(req) {
  if (!req) return;
  delete req.deferredRagContext;
}

module.exports = {
  POLICY_INTRO,
  buildRagBlock,
  replaceRagBlock,
  setDeferredContext,
  getDeferredContext,
  consumeDeferredContext,
  clearDeferredContext,
};