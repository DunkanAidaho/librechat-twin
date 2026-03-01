/**
 * sync_history.js
 * Административный скрипт для дозаливки истории диалогов в память.
 * Подключается к MongoDB, находит сообщения без флага isMemoryStored
 * и ставит батчи задач в Temporal/NATS через enqueueMemoryTasks.
 */
require('module-alias/register');

const mongoose = require('mongoose');
const { getLogger } = require('~/utils/logger');
const { configService } = require('./server/services/Config/ConfigService');
const { enqueueMemoryTasks } = require('~/server/services/RAG/memoryQueue');

const logger = getLogger('scripts.syncHistory');

const mongoUri = configService.get('mongo.uri');
if (!mongoUri) {
  logger.error('syncHistory.mongo_uri_missing');
  process.exit(1);
}

const BATCH_SIZE = configService.getNumber('memory.queue.historySyncBatchSize', 20);

const messageSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true },
    messageId: { type: String, required: true },
    isCreatedByUser: { type: Boolean, default: false },
    text: { type: String },
    content: { type: Array },
    isMemoryStored: { type: Boolean, default: false },
    user: { type: String },
  },
  { timestamps: true, collection: 'messages', strict: false },
);
const conversationSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true, unique: true },
    user: { type: String },
  },
  { collection: 'conversations' },
);

const Message = mongoose.model('Message', messageSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);

function extractFullText(msg) {
  if (msg.text && msg.text.trim() !== '') return msg.text;
  if (msg.content && Array.isArray(msg.content)) {
    let full = '';
    for (const item of msg.content) {
      if (item.type === 'think' && item.think) full += `Thoughts:\n${item.think}\n\n`;
      if (item.type === 'text' && item.text) full += `${item.text}\n`;
    }
    return full.trim();
  }
  return '';
}

function detectContextFlags(text) {
  const flags = [];
  if (!text) return flags;

  if (
    text.includes('USER:') ||
    text.includes('ASSISTANT:') ||
    text.includes('MODEL:') ||
    text.includes('SYSTEM:') ||
    text.includes('БОТ:')
  ) {
    flags.push('embedded_transcript');
  }
  if (text.includes('<think>') || text.includes('Thinking:')) {
    flags.push('contains_reasoning');
  }
  if (text.length > 500_000) flags.push('oversized_attachment');
  return flags;
}

async function main() {
  logger.info('syncHistory.start', { version: '3.1' });
  const targetConversationId = process.argv[2];

  try {
    await mongoose.connect(mongoUri);
    logger.info('syncHistory.mongo_connected');
  } catch (err) {
    logger.error('syncHistory.mongo_connect_failed', { err });
    process.exit(1);
  }

  let totalSynced = 0;
  let totalSkipped = 0;

  try {
    const convFilter = targetConversationId ? { conversationId: targetConversationId } : {};
    if (targetConversationId) {
      logger.info('syncHistory.target_conversation', { conversationId: targetConversationId });
    } else {
      logger.info('syncHistory.target_all');
    }

    const conversations = await Conversation.find(convFilter).lean();
    logger.info('syncHistory.conversations_found', { count: conversations.length });

    for (const convo of conversations) {
      const { conversationId, user } = convo;
      if (!user) {
        logger.warn('syncHistory.skip_no_user', { conversationId });
        continue;
      }

      const messages = await Message.find({
        conversationId,
        isMemoryStored: { $ne: true },
      }).sort({ createdAt: 1 });

      if (messages.length === 0) continue;

      const tasks = [];
      const idsToUpdate = [];
      let skippedLocal = 0;

      for (const msg of messages) {
        const fullText = extractFullText(msg);
        if (!fullText) {
          logger.debug('syncHistory.skip_no_text', { conversationId, messageId: msg.messageId });
          skippedLocal++;
          continue;
        }

        const flags = detectContextFlags(fullText);
        tasks.push({
          type: 'add_turn',
          payload: {
            conversation_id: conversationId,
            message_id: msg.messageId,
            role: msg.isCreatedByUser ? 'user' : 'assistant',
            content: fullText,
            user_id: user,
            created_at: msg.createdAt ? msg.createdAt.toISOString() : new Date().toISOString(),
            context_flags: flags,
          },
        });
        idsToUpdate.push(msg._id);
      }

      if (tasks.length > 0) {
        for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
          const batch = tasks.slice(i, i + BATCH_SIZE);
          const totalLength = batch.reduce(
            (acc, task) => acc + (task.payload.content?.length || 0),
            0,
          );
          await enqueueMemoryTasks(batch, {
            reason: 'history_sync',
            conversationId,
            userId: user,
            fileId: null,
            textLength: totalLength,
          });
        }
      }

      if (idsToUpdate.length > 0) {
        await Message.updateMany({ _id: { $in: idsToUpdate } }, { $set: { isMemoryStored: true } });
      }

      logger.info('syncHistory.conversation_summary', {
        conversationId,
        found: messages.length,
        sent: idsToUpdate.length,
        skipped: skippedLocal,
      });
      totalSynced += idsToUpdate.length;
      totalSkipped += skippedLocal;
    }
  } catch (error) {
    logger.error('syncHistory.error', { err: error });
  } finally {
    logger.info('syncHistory.finished', { totalSynced, totalSkipped });
    try {
      await mongoose.disconnect();
      logger.info('syncHistory.mongo_disconnected');
    } catch (disconnectErr) {
      logger.warn('syncHistory.mongo_disconnect_failed', { err: disconnectErr });
    }
  }
}

main();
