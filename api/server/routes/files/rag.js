// /opt/open-webui/api/server/routes/files/rag.js
const express = require('express');
const { randomUUID } = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer'); // ВАЖНО: свой multer, не общий
const { requireJwtAuth } = require('~/server/middleware');
const { configService } = require('../../services/Config/ConfigService');
const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');

// ИЗМЕНЕНО: Теперь RAG_API_URL указывает на tools-gateway
const logger = getLogger('routes.files.rag');
const TOOLS_GATEWAY_URL = configService.get('rag.gateway.url');
const INTERNAL_KEY = configService.get('security.ragInternalKey', '');

function attachRequestId(req, _res, next) {
  req.context = req.context || {};
  req.context.requestId = req.context.requestId || randomUUID();
  next();
}

function internalOrJwtAuth() {
  return (req, res, next) => {
    try {
      const key = req.get('x-internal-key') || req.get('X-Internal-Key');
      if (INTERNAL_KEY && key && key === INTERNAL_KEY) {
        req.user = req.user || { id: 'internal', role: 'admin' };
        req.isInternalBypass = true;
        logger.info('routes.files.rag.internal_bypass', buildContext(req));
        return next();
      }
      logger.info('routes.files.rag.jwt_auth', buildContext(req));
      return requireJwtAuth(req, res, next);
    } catch (e) {
      logger.error('routes.files.rag.auth_error', buildContext(req, { err: e }));
      return res.status(500).json({ error: 'Auth middleware error' });
    }
  };
}

async function initialize() {
  const router = express.Router();

  router.use(attachRequestId);

  // Только наша аутентификация
  router.use(internalOrJwtAuth());

  if (!TOOLS_GATEWAY_URL) {
    logger.error('routes.files.rag.gateway_missing', buildContext({}));
    router.use((_req, res) => res.status(500).json({ error: 'RAG tools gateway URL is not configured' }));
    return router;
  }

  // Свой multer: принимаем любые типы, хранение в памяти
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
    fileFilter: (_req, _file, cb) => cb(null, true),
  });

  // CSV ingest
  router.post('/ingest/csv', upload.single('file'), async (req, res) => {
    try {
      logger.info('routes.files.rag.ingest_csv.start', buildContext(req, {
        internal: !!req.isInternalBypass,
        hasFile: !!req.file,
        mimetype: req.file?.mimetype,
        size: req.file?.size,
      }));

      // ИЗМЕНЕНО: Теперь обращаемся к tools-gateway
      if (!req.file) {
        return res.status(400).json({ error: 'No file provided (field name must be "file")' });
      }

      // TODO: Реализовать эндпоинт /ingest/csv в tools-gateway
      // Пока просто возвращаем ошибку, так как tools-gateway не имеет такого эндпоинта
      return res.status(501).json({ error: 'CSV ingest not yet implemented in tools-gateway' });

      /*
      // Пример, как это выглядело бы, если бы tools-gateway поддерживал ingest/csv
      const form = new FormData();
      form.append('file', req.file.buffer, {
        filename: req.file.originalname || 'upload.csv',
        contentType: req.file.mimetype || 'text/csv',
      });

      const resp = await axios.post(`${TOOLS_GATEWAY_URL}/ingest/csv`, form, {
        headers: {
          ...form.getHeaders(),
          // Authorization: `Bearer ${RAG_API_TOKEN}`, // Если tools-gateway требует токен
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      logger.info('[/files/rag/ingest/csv] ok', { status: resp.status, data: resp.data });
      return res.status(resp.status).json(resp.data);
      */
    } catch (error) {
      const status = error.response?.status || 500;
      const msg = error.response?.data || error.message || 'CSV ingest proxy error';
      logger.error('routes.files.rag.ingest_csv.error', buildContext(req, { status, msg }));
      return res.status(status).json({ error: msg });
    }
  });

  // JSON ingest
  router.post('/ingest/json', express.json({ limit: '50mb' }), async (req, res) => {
    try {
      logger.info('routes.files.rag.ingest_json.start', buildContext(req, {
        internal: !!req.isInternalBypass,
        keys: Object.keys(req.body || {}),
      }));

      // TODO: Реализовать эндпоинт /ingest/json в tools-gateway
      // Пока просто возвращаем ошибку, так как tools-gateway не имеет такого эндпоинта
      return res.status(501).json({ error: 'JSON ingest not yet implemented in tools-gateway' });

      /*
      // Пример, как это выглядело бы, если бы tools-gateway поддерживал ingest/json
      const resp = await axios.post(`${TOOLS_GATEWAY_URL}/ingest/json`, req.body, {
        headers: {
          'Content-Type': 'application/json',
          // Authorization: `Bearer ${RAG_API_TOKEN}`,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      logger.info('[/files/rag/ingest/json] ok', { status: resp.status, data: resp.data });
      return res.status(resp.status).json(resp.data);
      */
    } catch (error) {
      const status = error.response?.status || 500;
      const msg = error.response?.data || error.message || 'JSON ingest proxy error';
      logger.error('routes.files.rag.ingest_json.error', buildContext(req, { status, msg }));
      return res.status(status).json({ error: msg });
    }
  });

  // Search
  router.post('/search', express.json({ limit: '10mb' }), async (req, res) => {
    try {
      logger.info('routes.files.rag.search.start', buildContext(req, {
        internal: !!req.isInternalBypass,
        keys: Object.keys(req.body || {}),
      }));

      // ИЗМЕНЕНО: Обращаемся к tools-gateway
      const resp = await axios.post(`${TOOLS_GATEWAY_URL}/rag/search`, req.body, {
        headers: {
          'Content-Type': 'application/json',
          // Authorization: `Bearer ${RAG_API_TOKEN}`, // Если tools-gateway требует токен
        },
      });

      logger.info(
        'routes.files.rag.search.success',
        buildContext(req, { status: resp.status, results: resp.data?.results?.length }),
      );
      return res.status(resp.status).json(resp.data);
    } catch (error) {
      const status = error.response?.status || 500;
      const msg = error.response?.data || error.message || 'Search proxy error';
      logger.error('routes.files.rag.search.error', buildContext(req, { status, msg }));
      return res.status(status).json({ error: msg });
    }
  });

  return router;
}

module.exports = { initialize };
