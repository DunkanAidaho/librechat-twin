const express = require('express');
const { getLogger } = require('~/utils/logger');

const router = express.Router();
const logger = getLogger('routes.summary');

router.post('/ingest', express.json({ limit: '1mb' }), async (req, res) => {
  const payload = req.body || {};
  logger.info('summary.ingest.received', {
    conversationId: payload.conversation_id || payload.conversationId,
    summaryLevel: payload.summary_level || payload.summaryLevel,
    requestId: req.context?.requestId,
  });
  res.json({ status: 'accepted' });
});

module.exports = router;
