// /opt/open-webui/request.js - ИСПРАВЛЕННАЯ ВЕРСИЯ
const { condenseContext } = require("~/server/services/RAG/condense");
const axios = require('axios');
const { sendEvent, Tokenizer } = require('@librechat/api'); // <-- ДОБАВЛЕН Tokenizer
const { logger } = require('@librechat/data-schemas');
const { Constants } = require('librechat-data-provider');
const {
  handleAbortError,
  createAbortController,
} = require('~/server/middleware');
const { disposeClient, clientRegistry, requestDataMap } = require('~/server/cleanup');

const {
  saveMessage,
  getConvo,
  getMessages,
  getConvoTitle,
  saveConvo,
} = require('~/models');

const { enqueueMemoryTasks } = require('~/server/services/RAG/memoryQueue');
const { getRedisClient, publishToRedis } = require('../../../utils/rag_redis');

const REDIS_LAST_SUM_KEY = "summarization:last_index:";
async function getLastSummarizedIndex(conversationId) {
  try { const r = getRedisClient(); if (!r) return 0;
    const v = await r.get(REDIS_LAST_SUM_KEY + conversationId);
    const n = v ? parseInt(v, 10) : 0; return isNaN(n) ? 0 : n;
  } catch { return 0; }
}
async function setLastSummarizedIndex(conversationId, idx) {

  try { const r = getRedisClient(); if (!r) return;
    await r.set(REDIS_LAST_SUM_KEY + conversationId, String(idx), 'EX', 604800);
  } catch {}
}


const HEADLESS_STREAM = (process.env.HEADLESS_STREAM || 'false').toLowerCase() === 'true';
const MAX_USER_MSG_TO_MODEL_CHARS = parseInt(process.env.MAX_USER_MSG_TO_MODEL_CHARS || '200000', 10);
const RAG_CONTEXT_MAX_CHARS = parseInt(process.env.RAG_CONTEXT_MAX_CHARS || '60000', 10);
const RAG_CONTEXT_TOPK = parseInt(process.env.RAG_CONTEXT_TOPK || '12', 10);
const GOOGLE_NOSTREAM_THRESHOLD = parseInt(process.env.GOOGLE_NOSTREAM_THRESHOLD || '120000', 10);

const SUMMARIZATION_THRESHOLD = 10;
const MAX_MESSAGES_PER_SUMMARY = 40;
const SUMMARIZATION_LOCK_TTL = 20;

async function enqueueMemoryTasksSafe(tasks, meta = {}) {
  try {
    await enqueueMemoryTasks(tasks, meta);
  } catch (err) {
    logger.error(
      '[MemoryQueue] enqueue failed reason=%s conv=%s: %s',
      meta?.reason,
      meta?.conversationId,
      err?.message || err
    );
  }
}

// Note: retrieveContext function is no longer needed here as logic is moved to client.js

function canWrite(res) {
  return Boolean(res) && res.writable !== false && !res.writableEnded;
}
function makeDetachableRes(res) {
  let detached = false;
  return {
    setDetached(v = true) { detached = v; },
    write(...args) { if (!detached && canWrite(res)) { try { return res.write(...args); } catch(_) { return true; } } return true; },
    end(...args) { if (!detached && canWrite(res)) { try { return res.end(...args); } catch(_) {} } },
    flushHeaders() { if (!detached && typeof res.flushHeaders === 'function') { try { res.flushHeaders(); } catch(_) {} } },
    get headersSent() { return detached ? true : res.headersSent; },
    get finished() { return detached ? true : res.finished; },
    on: (...args) => res.on(...args),
    removeListener: (...args) => res.removeListener(...args),
  };
}

// Генерим заголовок только при первом обмене и если title пустой/"New Chat"
async function shouldGenerateTitle(req, conversationId) {
  try {
    const convo = await getConvo(req.user.id, conversationId);
    const title = (convo?.title || '').trim();
    if (title && !/new chat/i.test(title)) return false;
    const msgs = await getMessages({ conversationId });
    return (msgs?.length || 0) <= 2; // user + первый assistant
  } catch (e) {
    logger.error('[title] check failed', e);
    return false;
  }
}

const AgentController = async (req, res, next, initializeClient, addTitle) => {
  let {
    text,
    isRegenerate,
    endpointOption,
    conversationId: initialConversationId,
    isContinued = false,
    editedContent = null,
    parentMessageId = null,
    overrideParentMessageId = null,
    responseMessageId: editedResponseMessageId = null,
  } = req.body;

  let conversationId = initialConversationId;

// =================================================================
// [НОВЫЙ ПАТЧ v2] "Удар на опережение" для индексации файлов
// =================================================================
if (req.body.files && req.body.files.length > 0) {
  try {
    const { encodeAndFormat } = require('../../services/Files/images/encode');
    const { files, text: ocrText } = await encodeAndFormat(req, req.body.files);

    const userId = req.user.id;
    const file = files && files[0];
    const isTextLike =
      file?.type &&
      (file.type.startsWith('text/') ||
        file.type.includes('html') ||
        file.type.includes('json') ||
        file.type.includes('javascript') ||
        file.type.includes('python'));

    const textToIndex = isTextLike ? ocrText : null;
    if (!textToIndex) {
      logger.info('[Pre-emptive Ingest] file_id=%s пропущен (тип=%s, текст отсутствует).', file?.file_id, file?.type);
    } else if (!conversationId) {
      logger.warn('[Pre-emptive Ingest] нет conversationId для file_id=%s, user=%s.', file.file_id, userId);
    } else {
      const { RAG_INGEST_MARK_TTL } = req.app.locals.config || {};
      const redis = getRedisClient();
      const dedupKey = `ingest:file:${file.file_id}`;
      let skip = false;

      if (redis) {
        try {
          const ttl = parseInt(RAG_INGEST_MARK_TTL, 10) || 2592000;
          const ok = await redis.set(dedupKey, '1', 'EX', ttl, 'NX');
          skip = !ok;
        } catch (err) {
          logger.error('[Pre-emptive Ingest] Redis dedup error file_id=%s: %s', file.file_id, err?.message || err);
        }
      }

      if (skip) {
        logger.info('[Pre-emptive Ingest][dedup] file_id=%s уже в работе.', file.file_id);
      } else {
        const task = {
          type: 'index_file',
          payload: {
            user_id: userId,
            conversation_id: conversationId,
            file_id: file.file_id,
            text_content: textToIndex,
            source_filename: file.originalname || file.filename || null,
            mime_type: file.type || null,
            file_size: file.size || null,
          },
          meta: { dedupe_key: dedupKey },
        };

        await enqueueMemoryTasks([task], {
          reason: 'index_file',
          conversationId,
          userId,
          fileId: file.file_id,
          textLength: textToIndex.length,
        });
      }
    }
  } catch (e) {
    logger.error('[Pre-emptive Ingest] Сбой подготовки файлов. conv=%s user=%s err=%s', conversationId, req.user?.id, e?.message || e);
  }
}
// =================================================================
// [КОНЕЦ ПАТЧА v2]
// =================================================================
  const useRagMemory = process.env.USE_CONVERSATION_MEMORY === 'true';
  const userId = req.user.id;

  let sender;
  let userMessage;
  let response;
  let promptTokens;
  let userMessageId;
  let responseMessageId;
  let userMessagePromise;
  let getAbortData;
  let client = null;
  let cleanupHandlers = [];

  let getReqData = (data = {}) => {
    for (let key in data) {
      if (key === 'userMessage') {
        userMessage = data[key];
        userMessageId = data[key].messageId;
      } else if (key === 'userMessagePromise') {
        userMessagePromise = data[key];
      } else if (key === 'responseMessageId') {
        responseMessageId = data[key];
      } else if (key === 'promptTokens') {
        promptTokens = data[key];
      } else if (key === 'sender') {
        sender = data[key];
      } else if (!conversationId && key === 'conversationId') {
        conversationId = data[key];
      }
    }
  };

  const performCleanup = () => {
    if (Array.isArray(cleanupHandlers)) {
      for (const handler of cleanupHandlers) {
        try { if (typeof handler === 'function') handler(); } catch (e) {
          logger.error('[AgentController] Error in cleanup handler', e);
        }
      }
    }
    if (client) disposeClient(client);
  };

  try {
    const originalUserText = text || '';
    if (originalUserText.length > MAX_USER_MSG_TO_MODEL_CHARS) {
      const convId = initialConversationId || req.body.conversationId;
      const fileId = `pasted-${Date.now()}`;
      try {
        if (convId) {
          const tasks = [{
            type: 'index_file',
            payload: {
              user_id: userId,
              conversation_id: convId,
              file_id: fileId,
              text_content: originalUserText,
              source_filename: 'pasted_text.txt',
              mime_type: 'text/plain',
              file_size: originalUserText.length,
            },
          }];

          await enqueueMemoryTasks(tasks, {
            reason: 'index_file',
            conversationId: convId,
            userId,
            fileId,
            textLength: originalUserText.length,
          });

          triggerSummarization(req, convId).catch((err) => logger.error('[Summarizer] Background trigger failed', err));
        } else {
          logger.warn('[AgentController] No conversationId available for large text ingestion task');
        }
      } catch (e) {
        logger.error('[AgentController] Failed to enqueue big user text for indexing', e);
      }

      const ackConversationId = convId || conversationId || initialConversationId;
      const ack = {
        text: `Принял большой фрагмент (~${(originalUserText.length/1024/1024).toFixed(2)} МБ). Индексация. Спросите по содержанию — отвечу через память (RAG).`,
        messageId: `ack-${Date.now()}`,
        createdAt: new Date().toISOString(),
      };

      sendEvent(res, {
        final: true,
        conversation: { id: ackConversationId },
        title: undefined,
        requestMessage: { text: '[Большой текст принят, отправлен в индексирование]', messageId: `usr-${Date.now()}` },
        responseMessage: ack,
      });
      try { res.end(); } catch {}
      return;
    }

    // [PATCHED-RAG-MOVE-OUT]
    // ----- RAG LOGIC MOVED TO client.js (see patch RAG-MOVE-IN) -----
    logger.info('[DIAG] Skipping RAG context retrieval in request.js. It will be handled by the client.');
    const originalTextForDisplay = text || '';
    // -----------------------------------------------------------------

    if (!HEADLESS_STREAM) {
      let prelimAbortController = new AbortController();
      const prelimCloseHandler = () => { try { prelimAbortController.abort(); } catch {} };
      res.once('close', prelimCloseHandler);
      req.once('aborted', prelimCloseHandler);

          // Если google и большой payload, отключаем стрим заранее
    try {
      const approxLen = (text?.length || 0);
      function isGoogleEndpoint(endpointOption) {
        return endpointOption && endpointOption.endpoint === 'google';
      }
      if (isGoogleEndpoint(endpointOption) && approxLen > GOOGLE_NOSTREAM_THRESHOLD) {
        endpointOption.model_parameters = endpointOption.model_parameters || {};
        endpointOption.model_parameters.streaming = false;
        logger.info('[AgentController] google: streaming disabled (size limit)');
      }
    } catch(_) {}

    // !!! ГЛАВНОЕ ИСПРАВЛЕНИЕ В request.js !!!
    // Если инструкции - это просто строка, а не объект, 
    // то мы сами создаем правильный объект { content, tokenCount }.
    // Это делает request.js гибким и исправляет подсчет бюджета.
    if (endpointOption.model_parameters && typeof endpointOption.model_parameters.instructions === 'string') {
      const instructions = endpointOption.model_parameters.instructions;
      // Предполагаем, что getTokenCountForMessage в BaseClient использует Tokenizer.getTokenCount
      // Для простоты здесь используем прямой вызов Tokenizer.getTokenCount
      // Если BaseClient использует другую кодировку, это может быть не идеально,
      // но для системных инструкций обычно подходит общая
      const tokenCount = Tokenizer.getTokenCount(instructions, 'o200k_base'); // Указываем кодировку по умолчанию
      endpointOption.model_parameters.instructions = {
        content: instructions,
        tokenCount: tokenCount,
      };
      logger.info(`[request.js] Converted string instructions to a proper object for budgeting. Length: ${instructions.length}, Tokens: ${tokenCount}`);
    }


const result = await initializeClient({ req, res, endpointOption, signal: prelimAbortController.signal });

      try { res.removeListener('close', prelimAbortController); req.removeListener('aborted', prelimAbortController); } catch (_) {}

      if (!result || !result.client) throw new Error('Failed to initialize client (no result or client)');
      if (prelimAbortController.signal?.aborted) throw new Error('Request aborted before init');

      client = result.client;
      if (clientRegistry) clientRegistry.register(client, { userId }, client);
      requestDataMap.set(req, { client });

      const contentRef = new WeakRef(client.contentParts || []);
      getAbortData = () => {
        const content = contentRef.deref();
        return {
          sender,
          content: content || [],
          userMessage,
          promptTokens,
          conversationId,
          userMessagePromise,
          messageId: responseMessageId,
          parentMessageId: overrideParentMessageId ?? userMessageId,
        };
      };

      const { abortController, onStart } = createAbortController(req, res, getAbortData, getReqData);

      const onClientAbort = () => {
        if (!abortController.signal.aborted) { try { abortController.abort(); } catch {} logger.info('[AgentController] client aborted (HTTP 499-like)'); }
      };
      res.once('close', onClientAbort);
      req.once('aborted', onClientAbort);
      cleanupHandlers.push(() => { try { res.removeListener('close', onClientAbort); } catch {} try { req.removeListener('aborted', onClientAbort); } catch {} });

      const messageOptions = {
        user: userId,
        onStart,
        getReqData,
        isContinued,
        isRegenerate,
        editedContent,
        conversationId,
        parentMessageId,
        abortController,
        overrideParentMessageId,
        isEdited: !!editedContent,
        userMCPAuthMap: result.userMCPAuthMap,
        responseMessageId: editedResponseMessageId,
        progressOptions: { res },
      };

      try {
        response = await client.sendMessage(text, messageOptions);
      } catch (e) {
        const msg = String(e && (e.message || e))
        function isGoogleEndpoint(endpointOption) {
            return endpointOption && endpointOption.endpoint === 'google';
        }
        function disableGoogleStreaming(endpointOption) {
            if (endpointOption && isGoogleEndpoint(endpointOption)) {
                endpointOption.model_parameters = endpointOption.model_parameters || {};
                endpointOption.model_parameters.streaming = false;
            }
        }
        if (isGoogleEndpoint(endpointOption) && (msg.includes('Symbol(Symbol.asyncIterator)') || msg.includes('ERR_INTERNAL_ASSERTION'))) {
            logger.error('[AgentController] google stream error, retry non-stream once');
            try { disableGoogleStreaming(endpointOption); } catch(_) {}
            // Переинициализируем клиента, чтобы он подхватил non-stream
            const reinit = await initializeClient({ req, res, endpointOption, signal: prelimAbortController.signal });
            if (!reinit || !reinit.client) throw e;
            client = reinit.client;
            response = await client.sendMessage(text, messageOptions);
        } else { throw e; }
      }

      const safeEndpoint =
        (endpointOption && endpointOption.endpoint) ||
        result?.endpoint ||
        client?.options?.endpoint ||
        client?.endpoint ||
        'unknown';
      if (response) response.endpoint = safeEndpoint;

      if (!abortController.signal.aborted && response && canWrite(res)) {
        const databasePromise = response.databasePromise;
        delete response.databasePromise;

        const { conversation: convoData = {} } = await databasePromise;
        const conversation = { ...convoData };
        conversation.title = conversation?.title || (await getConvoTitle(req.user.id, conversationId));

        if (req.body.files && client.options?.attachments && userMessage) {
          userMessage.files = [];
          const messageFiles = new Set(req.body.files.map((f) => f.file_id));
          for (let attachment of client.options.attachments) {
            if (messageFiles.has(attachment.file_id)) userMessage.files.push({ ...attachment });
          }
          delete userMessage.image_urls;
        }

        // показываем исходный текст
        if (userMessage && text !== originalTextForDisplay) userMessage.text = originalTextForDisplay;

        // Память RAG
        if (useRagMemory) {
          const tasks = [];
          const userContent = userMessage ? (userMessage.text || '') : '';
          let assistantText = response ? (response.text || '') : '';
          if (!assistantText && Array.isArray(response?.content)) {
            assistantText = response.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n');
          }
          
          // Проверяем наличие createdAt в userMessage и response
          const userCreatedAt = userMessage?.createdAt || new Date().toISOString();
          const assistantCreatedAt = response?.createdAt || new Date().toISOString();

          if (userContent) tasks.push({ type: 'add_turn', payload: { conversation_id: conversationId, message_id: userMessage.messageId, role: 'user', content: userContent, user_id: req.user.id, created_at: userCreatedAt } });
          if (assistantText) tasks.push({ type: 'add_turn', payload: { conversation_id: conversationId, message_id: response.messageId, role: 'assistant', content: assistantText, user_id: req.user.id, created_at: assistantCreatedAt } });
          if (tasks.length > 0) {
            await enqueueMemoryTasksSafe(tasks, {
              reason: 'regular_turn',
              conversationId,
              userId: req.user.id,
              fileId: null,
              textLength: (userContent?.length || 0) + (assistantText?.length || 0),
            });
          }
        }

        try {
          if (userMessage && !client.skipSaveUserMessage) await saveMessage(req, userMessage);
          if (response) await saveMessage(req, { ...response, user: userId });
        } catch (e) {
          logger.error('[AgentController] Error saving messages', e);
        }

        // ТОЛЬКО ПРИ ПЕРВОМ ОБМЕНЕ и без названия
        if (response && typeof addTitle === 'function') {
          try {
            const need = await shouldGenerateTitle(req, conversationId);
            if (need) {
              const titleSourceText = (userMessage?.text || originalTextForDisplay || req.body?.text || '').slice(0, 500);
              await addTitle(req, { text: titleSourceText, input: titleSourceText, abortController, conversationId, endpoint: safeEndpoint, client, response, endpointOption });
            }
          } catch (e) {
            logger.error('[AgentController] addTitle failed', e);
          }
        }

        if (response) {
          sendEvent(res, { final: true, conversation, title: conversation.title, requestMessage: userMessage, responseMessage: response });
          try { res.end(); } catch {}
        }

        if (useRagMemory) {
          triggerSummarization(req, conversationId).catch((err) => logger.error('[Summarizer] Background trigger failed', err));
        }
      }
      return;
    }

    // HEADLESS_STREAM (detach)
    const dres = makeDetachableRes(res);
    let detached = false;
    const onClose = () => {
      if (!detached) { dres.setDetached(true); detached = true; logger.info('[AgentController] client disconnected, detach streaming'); }
    };
    res.once('close', onClose);
    req.once('aborted', onClose);

        // Для Google в headless: отключаем стрим у провайдера, чтобы не ловить gaxios asyncIterator/ERR_INTERNAL_ASSERTION
    try {
      if (endpointOption && endpointOption.endpoint === 'google') {
        endpointOption.model_parameters = endpointOption.model_parameters || {};
        endpointOption.model_parameters.streaming = false;
        logger.info('[AgentController] google: streaming disabled in headless mode');
      }
    } catch (_) {}

    // !!! ГЛАВНОЕ ИСПРАВЛЕНИЕ В request.js (для headless) !!!
    if (endpointOption.model_parameters && typeof endpointOption.model_parameters.instructions === 'string') {
      const instructions = endpointOption.model_parameters.instructions;
      const tokenCount = Tokenizer.getTokenCount(instructions, 'o200k_base');
      endpointOption.model_parameters.instructions = {
        content: instructions,
        tokenCount: tokenCount,
      };
      logger.info(`[request.js] (headless) Converted string instructions to a proper object for budgeting. Length: ${instructions.length}, Tokens: ${tokenCount}`);
    }

const result = await initializeClient({ req, res: dres, endpointOption, signal: undefined });
    if (!result || !result.client) throw new Error('Failed to initialize client (no result or client)');

    client = result.client;
    if (clientRegistry) clientRegistry.register(client, { userId }, client);
    requestDataMap.set(req, { client });
    const contentRef = new WeakRef(client.contentParts || []);
    getAbortData = () => {
      return { sender, content: contentRef.deref() || [], userMessage, promptTokens, conversationId, userMessagePromise, messageId: responseMessageId, parentMessageId: userMessageId };
    };

    const { abortController, onStart } = createAbortController(req, dres, getAbortData, getReqData);

    const messageOptions = { user: userId, onStart, getReqData, isContinued, isRegenerate, editedContent, conversationId, parentMessageId, abortController, overrideParentMessageId, isEdited: !!editedContent, userMCPAuthMap: result.userMCPAuthMap, responseMessageId: editedResponseMessageId, progressOptions: { res: dres } };

    response = await client.sendMessage(text, messageOptions);
    const safeEndpoint =
      (endpointOption && endpointOption.endpoint) || result?.endpoint || client?.options?.endpoint || client?.endpoint || 'unknown';
    if (response) response.endpoint = safeEndpoint;

    // показываем исходный текст
    if (userMessage && text !== originalTextForDisplay) userMessage.text = originalTextForDisplay;

    try {
      if (userMessage && !client.skipSaveUserMessage) await saveMessage(req, userMessage);
      if (response) await saveMessage(req, { ...response, user: userId });
    } catch (e) {
      logger.error('[AgentController] Error saving messages', e);
    }

    // ТОЛЬКО ПРИ ПЕРВОМ ОБМЕНЕ
    if (response && typeof addTitle === 'function') {
      try {
        const need = await shouldGenerateTitle(req, conversationId);
        if (need) {
          const titleSourceText = (userMessage?.text || originalUserText || req.body?.text || '').slice(0, 500); // <-- ИСПРАВЛЕНО: userMessage?.text или originalUserText
          await addTitle(req, { text: titleSourceText, input: titleSourceText, abortController, conversationId, endpoint: safeEndpoint, client, response, endpointOption });
        }
      } catch (e) {
        logger.error('[AgentController] addTitle (headless) failed', e);
      }
    }

    if (!detached && canWrite(dres) && response) {
      sendEvent(dres, { final: true, conversation: {}, title: undefined, requestMessage: userMessage, responseMessage: response });
      try { dres.end(); } catch {}
    } else {
      logger.info('[AgentController] finished in background; client detached');
    }

    if (useRagMemory) {
      triggerSummarization(req, conversationId).catch((err) => logger.error('[Summarizer] Background trigger failed', err));
    }
  } catch (error) {
    handleAbortError(res, req, error, { conversationId, sender, messageId: responseMessageId, parentMessageId: overrideParentMessageId ?? userMessageId ?? parentMessageId, userMessageId });
  } finally {
    performCleanup();
  }
};

async function triggerSummarization(req, conversationId) {
  const userId = req.user.id;
  const redis = getRedisClient();
  if (!redis) { logger.error('[Summarizer] Redis client not available.'); return; }

  const lockKey = `summarization_lock:${conversationId}`;
  try {
    const isLocked = await redis.get(lockKey);
    if (isLocked) {
      logger.info(`[Summarizer] ${conversationId} in progress. Skipping.`);
      return;
    }

    const convo = await getConvo(userId, conversationId);
    if (!convo) return;

    const allMessages = await getMessages({ conversationId });
    const messageCount = allMessages.length;
    let lastSummarized = convo.lastSummarizedIndex || 0;
    const redisLast = await getLastSummarizedIndex(conversationId);
    if (redisLast > lastSummarized) lastSummarized = redisLast;

    logger.info(`[Summarizer] Check for ${conversationId}: Total ${messageCount}, Last ${lastSummarized}`);

    if (messageCount - lastSummarized < SUMMARIZATION_THRESHOLD) return;

    await redis.set(lockKey, '1', 'EX', SUMMARIZATION_LOCK_TTL);
    logger.info(`[Summarizer] Lock acquired for ${conversationId}.`);

    const cleanAssistantText = (text) => {
      if (!text) return '';
      if (text.includes('***')) return text.split('***').pop().trim();
      if (text.includes('Рассуждения:')) {
        const parts = text.split(/Рассуждения:|Финальный ответ:/);
        return parts.length > 1 ? parts[parts.length - 1].trim() : text.trim();
      }
      return text.trim();
    };

    const extractText = (msg) => {
      const rawText =
        msg.text ||
        (Array.isArray(msg.content)
          ? msg.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n')
          : '');
      return msg.isCreatedByUser ? rawText : cleanAssistantText(rawText);
    };

    const messagesToSummarize = allMessages.slice(lastSummarized, lastSummarized + MAX_MESSAGES_PER_SUMMARY);
    if (messagesToSummarize.length < 2) { await redis.del(lockKey); return; }

    const formatted = messagesToSummarize
      .map((m) => ({ role: m.isCreatedByUser ? 'user' : 'assistant', content: extractText(m) }))
      .filter((m) => m.content);

    const task = {
      type: 'summarize_conversation', // <-- ТИП ЗАДАЧИ ДЛЯ SUMMARIZATION-WORKER
      payload: {
        conversation_id: conversationId,
        user_id: userId,
        messages: formatted,
        start_message_id: messagesToSummarize[0].messageId,
        end_message_id: messagesToSummarize[messagesToSummarize.length - 1].messageId,
      },
    };

    const totalContentLength = formatted.reduce(
      (acc, msg) => acc + (msg.content?.length || 0),
      0
    );

    await enqueueMemoryTasksSafe([task], {
      reason: 'summarization',
      conversationId,
      userId,
      fileId: null,
      textLength: totalContentLength,
    });
    const newIndex = lastSummarized + messagesToSummarize.length;
    await saveConvo(req, { conversationId, lastSummarizedIndex: newIndex }, { context: 'triggerSummarization' });
    await setLastSummarizedIndex(conversationId, newIndex);
    logger.info(`[Summarizer] Enqueued; lastSummarizedIndex -> ${newIndex}`);
  } catch (error) {
    logger.error(`[Summarizer] Error for ${conversationId}:`, error);
    try { const redis2 = getRedisClient(); if (redis2) await redis2.del(lockKey); } catch(_) {}
  }
};

module.exports = AgentController;
