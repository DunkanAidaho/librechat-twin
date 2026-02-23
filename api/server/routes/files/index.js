// /opt/open-webui/api/server/routes/files/index.js
const express = require('express');
const { randomUUID } = require('crypto');
const {
  createFileLimiters,
  configMiddleware,
  requireJwtAuth,
  uaParser,
  checkBan,
} = require('~/server/middleware');
const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');
const { avatar: asstAvatarRouter } = require('~/server/routes/assistants/v1');
const { avatar: agentAvatarRouter } = require('~/server/routes/agents/v1');
const { createMulterInstance } = require('./multer');

const files = require('./files');
const images = require('./images');
const avatar = require('./avatar');
const speech = require('./speech');
const rag = require('./rag'); // саброут RAG

const logger = getLogger('routes.files');

function attachRequestId(req, _res, next) {
  req.context = req.context || {};
  req.context.requestId = req.context.requestId || randomUUID();
  next();
}

const initialize = async () => {
  const router = express.Router();

  router.use(attachRequestId);

  // 1) RAG — до глобальной авторизации, со своей собственной аутентификацией внутри rag
  router.use('/rag', await rag.initialize());

  // 2) Остальные middleware для всех прочих путей
  router.use(requireJwtAuth);
  router.use(configMiddleware);
  router.use(checkBan);
  router.use(uaParser);

  const upload = await createMulterInstance();
  router.post('/speech/stt', upload.single('audio'));
  router.use('/speech', speech);

  const { fileUploadIpLimiter, fileUploadUserLimiter } = createFileLimiters();
  router.post('*', fileUploadIpLimiter, fileUploadUserLimiter);
  router.post('/', upload.single('file'));
  router.post('/images', upload.single('file'));
  router.post('/images/avatar', upload.single('file'));
  router.post('/images/agents/:agent_id/avatar', upload.single('file'));
  router.post('/images/assistants/:assistant_id/avatar', upload.single('file'));

  router.use((req, _res, next) => {
    logger.debug('routes.files.request', buildContext(req, { path: req.path, method: req.method }));
    next();
  });

  router.use('/', files);
  router.use('/images', images);
  router.use('/images/avatar', avatar);
  router.use('/images/agents', agentAvatarRouter);
  router.use('/images/assistants', asstAvatarRouter);

  return router;
};

module.exports = { initialize };
