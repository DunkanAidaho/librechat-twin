// /opt/open-webui/CustomConvos.js - с санитайзером тайтлов и fallback

const multer = require('multer');
const express = require('express');
const { sleep } = require('@librechat/agents');
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const configService = require('~/server/services/Config/ConfigService');
const { CacheKeys, EModelEndpoint } = require('librechat-data-provider');
const {
  createImportLimiters,
  createForkLimiters,
  configMiddleware,
} = require('~/server/middleware');
const { getConvosByCursor, deleteConvos, getConvo, saveConvo, getConversations } = require('~/models/Conversation');
// th1nk: Импортируем новую функцию и модель Message
const { getMessages, getBranchCountsForConversations } = require('~/models/Message');
// th1nk: Конец изменений импорта
const { forkConversation, duplicateConversation } = require('~/server/utils/import/fork');
const { storage, importFileFilter } = require('~/server/routes/files/multer');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { importConversations } = require('~/server/utils/import');
const { deleteToolCalls } = require('~/models/ToolCall');
const getLogStores = require('~/cache/getLogStores');
const branchLog = require('~/utils/branchLogger');

// Единый Redis-модуль
const { enqueueMemoryTasks } = require('~/server/services/RAG/memoryQueue');
const { getRedisClient } = require('~/utils/rag_redis');  // TODO: удалить после полного отказа от Redis


const branchLoggingEnabled = configService.getBoolean(
  'features.branchLogging',
  (process.env.ENABLE_BRANCH_LOGGING || 'false').toLowerCase() === 'true',
);

const redisMemoryQueueName = configService.get(
  'queues.redisMemoryQueueName',
  process.env.REDIS_MEMORY_QUEUE_NAME || null,
);

const assistantClients = {
  [EModelEndpoint.azureAssistants]: require('~/server/services/Endpoints/azureAssistants'),
  [EModelEndpoint.assistants]: require('~/server/services/Endpoints/assistants'),
};

const router = express.Router();
router.use(requireJwtAuth);

// ——— helpers для тайтла ———
function stripQuotes(s = '') {
  return String(s || '').trim().replace(/^[\s"'«»]+|[\s"'«»]+$/g, '');
}
function isBadTitle(s = '') {
  const t = String(s).toLowerCase();
  if (!t || t.length < 3) return true;
  // мета-фразы
  if (t.includes('создание короткого названия') || t.includes('название беседы') ||
      t.startsWith('название:') || t.startsWith('тема:')) {
    return true;
  }
  // "новый диалог"/"новая беседа" больше НЕ считаем плохим
  return false;
}
function tighten(s = '', max = 40) {
  let out = String(s || '').replace(/\s+/g, ' ').trim();
  if (out.length > max) out = out.slice(0, max);
  out = out.replace(/[\s,:;.!?-]+$/g, '');
  return out || 'Без названия';
}
function extractText(msg) {
  if (!msg) return '';
  if (typeof msg.text === 'string' && msg.text) return msg.text;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string' && p.text)
      .map((p) => p.text)
      .join(' ');
  }
  return '';
}
// ————————————————

router.get('/', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 25;
  const cursor = req.query.cursor;
  const isArchived = isEnabled(req.query.isArchived);
  const search = req.query.search ? decodeURIComponent(req.query.search) : undefined;
  const order = req.query.order || 'desc';

  let tags;
  if (req.query.tags) {
    tags = Array.isArray(req.query.tags) ? req.query.tags : [req.query.tags];
  }

  try {
    // th1nk: Добавил проверку на наличие branchLog, чтобы не было ошибок, если он не инициализирован
    if (branchLoggingEnabled) {
      branchLog.debug(`[CustomConvos] Fetching conversations for user ${req.user.id}`);
    }

    const result = await getConvosByCursor(req.user.id, {
      cursor,
      limit,
      isArchived,
      tags,
      search,
      order,
    });

    // =========================================================================
    // НОВАЯ ЛОГИКА: Добавление информации о ветвлениях
    // =========================================================================
    if (result?.conversations?.length) {
      const conversationIds = result.conversations.map((convo) => convo.conversationId);
      const branchCounts = await getBranchCountsForConversations(conversationIds, req.user.id);

      result.conversations = result.conversations.map((convo) => {
        const branchCount = branchCounts[convo.conversationId] ?? 0;
        return {
          ...convo,
          branchCount,
          hasBranches: branchCount > 0,
        };
      });
    }
    // =========================================================================

    res.status(200).json(result);
  } catch (error) {
    logger.error('Error fetching conversations', error);
    // th1nk: Добавил проверку на наличие branchLog, чтобы не было ошибок, если он не инициализирован
    if (branchLoggingEnabled) {
      branchLog.error(`[CustomConvos] Error fetching conversations: ${error?.message || error}`);
    }
    res.status(500).json({ error: 'Error fetching conversations' });
  }
});

router.get('/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const convo = await getConvo(req.user.id, conversationId);

  if (convo) {
    res.status(200).json(convo);
  } else {
    res.status(404).end();
  }
});

// Генерация/получение тайтла с санитайзером и fallback
router.post('/gen_title', async (req, res) => {
  const { conversationId } = req.body;
  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  const key = `${req.user.id}-${conversationId}`;
  let title = await titleCache.get(key);

  /* no wait */

  if (!title) {
    return res.status(404).json({
      message: "Title not found or method not implemented for the conversation's endpoint",
    });
  }

  await titleCache.delete(key);

  try {
    // th1nk: Добавил проверку на наличие branchLog, чтобы не было ошибок, если он не инициализирован
    if (branchLoggingEnabled) {
      branchLog.debug(`[CustomConvos] Generating title for conversation ${conversationId}`);
    }

    let finalTitle = stripQuotes(title);

    if ((finalTitle.toLowerCase() !== 'новый диалог') && (isBadTitle(finalTitle) || finalTitle.length > 60)) {
      // Fallback из текста сообщений
      // th1nk: Используем импортированную модель Message
      const messages = await getMessages({ conversationId });
      const firstUserMsg = messages.find((m) => m && m.isCreatedByUser && extractText(m));
      const source = extractText(firstUserMsg) || extractText(messages[0]) || '';
      finalTitle = tighten(source, 40);
    }

    // Сохраняем заголовок в БД, чтобы фронт не путался
    try {
      // th1nk: Добавил проверку на наличие branchLog, чтобы не было ошибок, если он не инициализирован
      if (branchLoggingEnabled) {
        branchLog.debug(`[CustomConvos] Saving generated title: ${finalTitle}`);
      }
      await saveConvo(req, { conversationId, title: finalTitle }, { context: 'gen_title_auto' });
    } catch (e) {
      logger.warn('[gen_title] saveConvo title failed (non-critical):', e.message || e);
    }

    return res.status(200).json({ title: finalTitle });
  } catch (e) {
    logger.error('[gen_title] post-process error:', e);
    return res.status(200).json({ title: tighten(String(title || ''), 40) });
  }
});

async function sendDeleteTaskToRedis(conversationId) {
  try {
    // th1nk: Добавил проверку на наличие branchLog, чтобы не было ошибок, если он не инициализирован
    if (branchLoggingEnabled) {
      branchLog.debug(`[CustomConvos] Sending delete task to Redis for conversation ${conversationId}`);
    }
    const queueName = redisMemoryQueueName;
    if (!queueName) {
      logger.warn('[RAG] redisMemoryQueueName is not configured. Skipping delete task.');
      return;
    }
    const client = getRedisClient();
    if (!client) {
      logger.error('[RAG] Redis client is not initialized. Skipping delete task.');
      return;
    }
    const task = { type: 'delete_conversation', payload: { conversation_id: conversationId } };
    await client.rpush(queueName, JSON.stringify(task));
    logger.info(`[RAG] Sent delete task for conversation ${conversationId} to Redis.`);
  } catch (error) {
    logger.error(`[RAG] Failed to send delete task for conversation ${conversationId} to Redis.`, error);
  }
}

router.delete('/', async (req, res) => {
  let filter = {};
  const { conversationId, source, thread_id, endpoint } = req.body.arg;

  if (!conversationId && !source && !thread_id && !endpoint) {
    return res.status(400).json({ error: 'no parameters provided' });
  }

  if (conversationId) {
    filter = { conversationId };
  } else if (source === 'button') {
    return res.status(200).send('No conversationId provided');
  }

  if (
    typeof endpoint !== 'undefined' &&
    Object.prototype.propertyIsEnumerable.call(assistantClients, endpoint)
  ) {
    const { openai } = await assistantClients[endpoint].initializeClient({ req, res });
    try {
      // th1nk: Добавил проверку на наличие branchLog, чтобы не было ошибок, если он не инициализирован
            if (branchLoggingEnabled) {
        branchLog.debug(`[CustomConvos] Deleting OpenAI thread ${thread_id}`);
      }
      const response = await openai.beta.threads.delete(thread_id);
      logger.debug('Deleted OpenAI thread:', response);
    } catch (error) {
      logger.error('Error deleting OpenAI thread:', error);
    }
  }

  try {
    // th1nk: Добавил проверку на наличие branchLog, чтобы не было ошибок, если он не инициализирован
    if (branchLoggingEnabled) {
      branchLog.debug(`[CustomConvos] Deleting conversation from DB ${conversationId}`);
    }
    const dbResponse = await deleteConvos(req.user.id, filter);
    await deleteToolCalls(req.user.id, filter.conversationId);

    if (dbResponse.acknowledged && dbResponse.deletedCount > 0 && conversationId) {
      try {
        await enqueueMemoryTasks([
          {
            type: 'delete_conversation',
            payload: {
              conversation_id: conversationId,
              message_id: `delete-${conversationId}-${Date.now()}`,
            },
          },
        ]);
      } catch (err) {
        logger.error('[RAG] delete_conversation → JetStream не доступен:', err);
      }
    }

    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error clearing conversations', error);
    res.status(500).send('Error clearing conversations');
  }
});

router.delete('/all', async (req, res) => {
  try {
    // th1nk: Добавил проверку на наличие branchLog, чтобы не было ошибок, если он не инициализирован
    if (branchLoggingEnabled) {
      branchLog.debug(`[CustomConvos] Deleting all conversations for user ${req.user.id}`);
    }
    const conversations = await getConversations(req.user.id);
    const convoIds = conversations.map(c => c.conversationId);

    const dbResponse = await deleteConvos(req.user.id, {});
    await deleteToolCalls(req.user.id);

    if (dbResponse.acknowledged && dbResponse.deletedCount > 0) {
      logger.info(`[RAG] Queueing delete tasks for ${convoIds.length} conversations.`);
      for (const convoId of convoIds) {
        await sendDeleteTaskToRedis(convoId);
      }
    }

    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error clearing conversations', error);
    res.status(500).send('Error clearing conversations');
  }
});

router.post('/update', async (req, res) => {
  const update = req.body.arg;

  if (!update.conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  try {
    // th1nk: Добавил проверку на наличие branchLog, чтобы не было ошибок, если он не инициализирован
    if (branchLoggingEnabled) {
      branchLog.debug('[CustomConvos] Updating conversation:', update.conversationId);
    }
    const dbResponse = await saveConvo(req, update, {
      context: `POST /api/convos/update ${update.conversationId}`,
    });
    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error updating conversation', error);
    res.status(500).send('Error updating conversation');
  }
});

const { importIpLimiter, importUserLimiter } = createImportLimiters();
const { forkIpLimiter, forkUserLimiter } = createForkLimiters();
const upload = multer({ storage: storage, fileFilter: importFileFilter });

router.post(
  '/import',
  importIpLimiter,
  importUserLimiter,
  configMiddleware,
  upload.single('file'),
  async (req, res) => {
    try {
      // th1nk: Добавил проверку на наличие branchLog, чтобы не было ошибок, если он не инициализирован
            if (branchLoggingEnabled) {
        branchLog.debug(`[CustomConvos] Importing file ${req.file.path}`);
      }
      await importConversations({ filepath: req.file.path, requestUserId: req.user.id });
      res.status(201).json({ message: 'Conversation(s) imported successfully' });
    } catch (error) {
      logger.error('Error processing file', error);
      res.status(500).send('Error processing file');
    }
  },
);

router.post('/fork', forkIpLimiter, forkUserLimiter, async (req, res) => {
  try {
    // th1nk: Добавил проверку на наличие branchLog, чтобы не было ошибок, если он не инициализирован
    if (branchLoggingEnabled) {
      branchLog.debug(`[CustomConvos] Forking conversation ${req.body.conversationId}`);
    }
    const { conversationId, messageId, option, splitAtTarget, latestMessageId } = req.body;
    const result = await forkConversation({
      requestUserId: req.user.id,
      originalConvoId: conversationId,
      targetMessageId: messageId,
      latestMessageId,
      records: true,
      splitAtTarget,
      option,
    });

    res.json(result);
  } catch (error) {
    logger.error('Error forking conversation:', error);
    res.status(500).send('Error forking conversation');
  }
});

router.post('/duplicate', async (req, res) => {
  const { conversationId, title } = req.body;

  try {
    // th1nk: Добавил проверку на наличие branchLog, чтобы не было ошибок, если он не инициализирован
    if (branchLoggingEnabled) {
      branchLog.debug(`[CustomConvos] Duplicating conversation ${conversationId}`);
    }
    const result = await duplicateConversation({
      userId: req.user.id,
      conversationId,
      title,
    });
    res.status(201).json(result);
  } catch (error) {
    logger.error('Error duplicating conversation:', error);
    res.status(500).send('Error duplicating conversation');
  }
});

module.exports = router;
