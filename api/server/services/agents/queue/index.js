const { enqueueMemoryTasks } = require('~/server/services/RAG/memoryQueue');
const { enqueueGraphTask, enqueueSummaryTask } = require('~/utils/temporalClient');
const { clearDedupeKey } = require('~/server/services/Deduplication/clearDedupeKey');
const ingestDeduplicator = require('~/server/services/Deduplication/ingestDeduplicator');

function createQueueGateway(overrides = {}) {
  const impl = Object.assign(
    {
      enqueueMemoryTasks,
      enqueueGraphTask,
      enqueueSummaryTask,
      clearDedupeKey,
      ingestDeduplicator,
    },
    overrides,
  );

  return Object.freeze({
    enqueueMemory: (tasks, meta = {}, options = {}) =>
      impl.enqueueMemoryTasks(tasks, meta, options),
    enqueueGraph: (payload, options = {}) => impl.enqueueGraphTask(payload, options),
    enqueueSummary: (payload, options = {}) => impl.enqueueSummaryTask(payload, options),
    clearDedupeKey: (key, logPrefix) => impl.clearDedupeKey(key, logPrefix),
    markAsIngested: (key, mode) => impl.ingestDeduplicator.markAsIngested(key, mode),
    getDeduplicator: () => impl.ingestDeduplicator,
  });
}

const queueGateway = createQueueGateway();

module.exports = {
  createQueueGateway,
  queueGateway,
};
