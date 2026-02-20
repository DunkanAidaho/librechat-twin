"use strict";

const { logger } = require('@librechat/data-schemas');
const { Tokenizer } = require('@librechat/api');

function ensureTokenCount(message, encoding = 'o200k_base') {
  if (typeof message.tokenCount === 'number' && message.tokenCount >= 0) {
    return message.tokenCount;
  }
  try {
    const text = typeof message.text === 'string' && message.text.length
      ? message.text
      : Array.isArray(message.content)
        ? message.content
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
        : '';
    const tokens = Tokenizer.getTokenCount(text || '', encoding);
    message.tokenCount = tokens;
    return tokens;
  } catch (error) {
    logger.warn('[historyTrimmer] Failed to count tokens, fallback to length', {
      messageId: message?.messageId,
      error: error?.message,
    });
    const fallback = (message?.text || '').length;
    message.tokenCount = fallback;
    return fallback;
  }
}

class HistoryTrimmer {
  constructor({
    tokenizerEncoding = 'o200k_base',
    keepLastN = 6,
    tokenBudget = 16000,
    layer1Ratio = 0.35,
    layer2Ratio = 0.25,
    contextHeadroom = 1024,
    importanceScorer = null,
    compressor = null,
  } = {}) {
    this.tokenizerEncoding = tokenizerEncoding;
    this.keepLastN = keepLastN;
    this.tokenBudget = tokenBudget;
    this.layer1Ratio = layer1Ratio;
    this.layer2Ratio = layer2Ratio;
    this.contextHeadroom = contextHeadroom;
    this.importanceScorer = importanceScorer || ((msg) => msg?.importance ?? 0);
    this.compressor = compressor;
  }

  buildLayers(messages = []) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return [];
    }

    const layers = [[], [], []];
    const total = messages.length;
    const baseCount = Math.max(0, total - this.keepLastN);
    const passthrough = messages.map((message, index) => ({
      message,
      originalIndex: index,
    }));

    const midCount = Math.floor(baseCount * this.layer1Ratio);
    const farCount = Math.floor(baseCount * this.layer2Ratio);

    let compressibleIndex = 0;
    passthrough.forEach(({ message, originalIndex }) => {
      ensureTokenCount(message, this.tokenizerEncoding);

      if (originalIndex >= total - this.keepLastN) {
        layers[0].push({ message, originalIndex });
        return;
      }

      if (compressibleIndex < midCount) {
        layers[1].push({ message, originalIndex });
      } else if (compressibleIndex < midCount + farCount) {
        layers[2].push({ message, originalIndex });
      } else {
        layers[2].push({ message, originalIndex });
      }
      compressibleIndex += 1;
    });

    const stableSortByImportance = (items) =>
      items
        .map((entry, idx) => ({ ...entry, stableOrder: idx, score: this.importanceScorer(entry.message) }))
        .sort((a, b) => {
          if (b.score === a.score) {
            return a.stableOrder - b.stableOrder;
          }
          return b.score - a.score;
        })
        .map(({ message, originalIndex }) => ({ message, originalIndex }));

    return layers.map((layer) => stableSortByImportance(layer));
  }

  async compressLayers(layers = []) {
    if (!this.compressor || typeof this.compressor.compress !== 'function') {
      return layers;
    }

    const compressed = [];
    for (let i = 0; i < layers.length; i++) {
      if (i < 2) {
        compressed.push(layers[i]);
        continue;
      }

      const layer = layers[i];
      const compressedMsgs = [];
      for (const entry of layer) {
        const msg = entry.message;
        try {
          const summary = await this.compressor.compress(msg);
          if (summary) {
            msg.metadata = Object.assign({}, msg.metadata, { compressed: true });
            msg.text = summary;
            msg.tokenCount = Tokenizer.getTokenCount(summary, this.tokenizerEncoding);
            if (Array.isArray(msg.content)) {
              msg.content = [{ type: 'text', text: summary }];
            } else if (typeof msg.content === 'string') {
              msg.content = summary;
            }
            compressedMsgs.push({ ...entry, message: msg });
            continue;
          }
        } catch (error) {
          logger.error('[historyTrimmer] Failed to compress message', {
            messageId: msg?.messageId,
            error: error?.message,
          });
        }
        compressedMsgs.push(entry);
      }
      compressed.push(compressedMsgs);
    }

    return compressed;
  }

  flatten(layers = []) {
    return layers.flat();
  }

  selectWithinBudget(layers = [], tokenBudget = Infinity) {
    const stats = layers.map((layer, layerIndex) => {
      const tokenSum = layer.reduce((sum, entry) => sum + (entry.message.tokenCount ?? 0), 0);
      return {
        layer: layerIndex,
        messageCount: layer.length,
        tokens: tokenSum,
      };
    });

    let remaining = tokenBudget;
    const kept = [];
    const dropped = [];

    layers.forEach((layer, layerIndex) => {
      for (const { message, originalIndex } of layer) {
        ensureTokenCount(message, this.tokenizerEncoding);
        message.metadata = Object.assign({}, message.metadata || {}, {
          compressionLayer: layerIndex,
          originalIndex,
        });

        const fits = remaining - message.tokenCount >= 0;

        if (fits) {
          kept.push({ message, originalIndex });
          remaining -= message.tokenCount;
        } else {
          dropped.push({ message, originalIndex });
          message.metadata = Object.assign({}, message.metadata, { truncatedByTrimmer: true });
        }
      }
    });

    const sortByOriginalIndex = (entries) =>
      entries
        .sort((a, b) => a.originalIndex - b.originalIndex)
        .map((entry) => entry.message);

    return {
      keptMessages: sortByOriginalIndex(kept),
      droppedMessages: sortByOriginalIndex(dropped),
      stats,
      remainingTokens: remaining,
    };
  }
}

module.exports = {
  HistoryTrimmer,
  ensureTokenCount,
};