const express = require('express');
const { randomUUID } = require('crypto');
const { generateCheckAccess, skipAgentCheck } = require('@librechat/api');
const { PermissionTypes, Permissions, PermissionBits } = require('librechat-data-provider');
const {
  setHeaders,
  moderateText,
  // validateModel,
  validateConvoAccess,
  buildEndpointOption,
  canAccessAgentFromBody,
} = require('~/server/middleware');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const addTitle = require('~/server/services/Endpoints/agents/title');
const AgentController = require('~/server/controllers/agents/request');
const { getRoleByName } = require('~/models/Role');
const { renderMetrics } = require('~/utils/metrics');
const { getLogger } = require('~/utils/logger');
const ingestDeduplicator = require('~/server/services/Deduplication/ingestDeduplicator');
const { validateAgentRequest } = require('~/server/middleware/requestValidators');

const router = express.Router();
const logger = getLogger('routes.agents.chat');

router.use(moderateText);

router.use((req, _res, next) => {
  req.context = req.context || {};
  if (!req.context.requestId) {
    req.context.requestId = randomUUID();
  }
  next();
});

const checkAgentAccess = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE],
  skipCheck: skipAgentCheck,
  getRoleByName,
});
const checkAgentResourceAccess = canAccessAgentFromBody({
  requiredPermission: PermissionBits.VIEW,
});

router.use(checkAgentAccess);
router.use(checkAgentResourceAccess);
router.use(validateAgentRequest);
router.use(validateConvoAccess);
router.use(buildEndpointOption);
router.use(setHeaders);
const controller = async (req, res, next) => {
  await AgentController(req, res, next, initializeClient, addTitle);
};

router.post('/', controller);

/**
 * @route POST /:endpoint (ephemeral agents)
 * @desc Chat with an assistant
 * @access Public
 * @param {express.Request} req - The request object, containing the request data.
 * @param {express.Response} res - The response object, used to send back a response.
 * @returns {void}
 */
router.post('/:endpoint', controller);

/**
 * @route GET /metrics
 * @desc Get agent metrics
 * @access Public (with METRICS_AUTH)
 */
router.get('/metrics', (req, res) => {
  if (process.env.METRICS_AUTH) {
    const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Basic ') || auth !== process.env.METRICS_AUTH) {
      return res.status(401).send('Unauthorized');
    }
  }
  try {
    const metrics = renderMetrics();
    res.setHeader('Content-Type', 'text/plain');
    res.send(metrics);
  } catch (err) {
    logger.error('metrics.fetch_failed', {
      err,
      requestId: req.context?.requestId,
    });
    res.status(500).send('Error');
  }
});

/**
 * @route GET /diagnostics/ingest-dedupe
 * @desc Get ingest dedupe diagnostics
 * @access Public (with auth check)
 */
router.get('/diagnostics/ingest-dedupe', checkAgentAccess, async (req, res) => {
  try {
    await ingestDeduplicator.initialize();
    const allMarks = await ingestDeduplicator.getAllIngestMarks();
    const limit = 1000;
    const marks = allMarks.slice(0, limit);
    const totalMarks = allMarks.length;
      const diagnostics = {
        totalMarks,
        sampleKeys: marks.slice(0, 10),
        status: totalMarks > limit ? `warning: showing only first ${limit} of ${totalMarks} entries` : 'ok',
        warning: 'Hit/miss counters are not available; this view shows raw keys only.',
      };
    res.json(diagnostics);
  } catch (err) {
    logger.error('diagnostics.fetch_failed', {
      err,
      requestId: req.context?.requestId,
    });
    res.status(500).json({ error: 'Failed to fetch diagnostics' });
  } finally {
    await ingestDeduplicator
      .shutdown()
      .catch((shutdownErr) =>
        logger.error('diagnostics.shutdown_failed', {
          err: shutdownErr,
          requestId: req.context?.requestId,
        }),
      );
  }
});
module.exports = router;
