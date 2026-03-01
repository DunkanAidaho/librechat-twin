const MessageHistoryManager = require('~/server/services/agents/MessageHistoryManager');
const { HistoryTrimmer } = require('~/server/services/agents/historyTrimmer');
const { enqueueMemoryTasks } = require('~/server/services/RAG/memoryQueue');

function createHistoryMemoryService(overrides = {}) {
  const impl = Object.assign(
    {
      MessageHistoryManager,
      HistoryTrimmer,
      enqueueMemoryTasks,
    },
    overrides,
  );

  return Object.freeze({
    MessageHistoryManager: impl.MessageHistoryManager,
    HistoryTrimmer: impl.HistoryTrimmer,
    enqueueMemoryTasks: (tasks, meta, options) =>
      impl.enqueueMemoryTasks(tasks, meta, options),
  });
}

const historyMemoryService = createHistoryMemoryService();

module.exports = {
  createHistoryMemoryService,
  historyMemoryService,
};
