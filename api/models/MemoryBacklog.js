// /opt/open-webui/models/MemoryBacklog.js
const mongoose = require('mongoose');

const memoryBacklogSchema = new mongoose.Schema(
  {
    tasks: { type: Array, required: true },
    metadata: { type: Object, required: true },
  },
  {
    timestamps: true, // createdAt/updatedAt
  }
);

// TTL-индекс: храним записи не дольше 7 суток
memoryBacklogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

module.exports = mongoose.model('MemoryBacklog', memoryBacklogSchema);
