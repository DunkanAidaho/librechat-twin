"use strict";

const { sanitizeInput } = require("~/utils/security");
const { quickHash } = require("~/utils/hash");

const POLICY_INTRO =
  '!!! ВНИМАНИЕ: НИЖЕ ПРИВЕДЕНЫ АКТУАЛЬНЫЕ НОВОСТИ ИЗ БАЗЫ ДАННЫХ ЗА ЗАПРОШЕННЫЙ ПЕРИОД. ИСПОЛЬЗУЙ ИХ ДЛЯ ОТВЕТА !!!\n' +
  'Ниже предоставлен внутренний контекст для твоего сведения: граф знаний и выдержки из беседы. ' +
  'Используй эти данные для формирования точного и полного ответа. ' +
  'Категорически запрещается цитировать или пересказывать этот контекст, особенно строки, содержащие "-->". ' +
  'Эта информация предназначена только для твоего внутреннего анализа.\n\n';

const GRAPH_TITLE = "### Graph context";
const VECTOR_TITLE = "### Vector context";
const BLOCK_FOOTER = "\n<!-- /RAG_CONTEXT_BLOCK -->\n";

function coerceLines(lines) {
  if (!Array.isArray(lines)) {
    return [];
  }
  return lines
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter(Boolean);
}

function buildRagBlock({
  policyIntro = POLICY_INTRO,
  graphLines = [],
  vectorText = "",
  maxChars = null,
} = {}) {
  const safeGraphLines = coerceLines(graphLines);
  const graphSection = safeGraphLines.length
    ? `${GRAPH_TITLE}\n${safeGraphLines.join("\n")}\n\n`
    : "";

  const trimmedVector = typeof vectorText === "string" ? vectorText.trim() : "";
  const vectorSection = trimmedVector ? `${VECTOR_TITLE}\n${trimmedVector}\n\n` : "";

  let content = `${policyIntro}${graphSection}${vectorSection}`;
  if (Number.isFinite(maxChars) && maxChars > 0 && content.length > maxChars) {
    content = `${content.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  const sanitizedContent = sanitizeInput(content);
  return `${sanitizedContent}${BLOCK_FOOTER}`;
}

function replaceRagBlock(systemContent = "", newBlock = "", logger = null) {
  const safeBlock = typeof newBlock === "string" ? newBlock : "";
  const safeSystem = typeof systemContent === "string" ? systemContent : "";

  if (!safeSystem.trim()) {
    return safeBlock + (systemContent || "");
  }

  const introSnippet = POLICY_INTRO.slice(0, 16).trim();
  const blockStart = safeSystem.indexOf(introSnippet);

  if (blockStart === -1) {
    if (safeSystem.trim()) {
      return `${safeBlock}\n${safeSystem}`;
    }
    return safeBlock;
  }

  const blockEnd = safeSystem.indexOf(BLOCK_FOOTER, blockStart);

  if (blockEnd === -1) {
    logger?.warn?.("[replaceRagBlock] footer_missing", {
      contentLength: safeSystem.length,
      introIndex: blockStart,
      hash: quickHash(safeSystem),
    });
    const before = safeSystem.slice(0, blockStart);
    return `${before}${safeBlock}`;
  }

  const before = safeSystem.slice(0, blockStart);
  const after = safeSystem.slice(blockEnd + BLOCK_FOOTER.length);
  return `${before}${safeBlock}${after}`;
}

function setDeferredContext(req, context = null) {
  if (!req) return;
  if (context) {
    req.deferredRagContext = context;
  } else {
    delete req.deferredRagContext;
  }
}

function getDeferredContext(req) {
  return req?.deferredRagContext || null;
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
