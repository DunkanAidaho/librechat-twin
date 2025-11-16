// /opt/open-webui/manage_summaries.js – Temporal/NATS версия (без Redis)

require('dotenv').config({ path: '/app/.env' });
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { enqueueSummaryTask } = require('./api/utils/temporalClient');

const {
  MONGO_URI,
  SUMMARY_OVERLAP, // перекрытие окна
} = process.env;

const SUMMARIZATION_THRESHOLD = parseInt(process.env.SUMMARIZATION_THRESHOLD || '10', 10);
const MAX_MESSAGES_PER_SUMMARY = parseInt(process.env.MAX_MESSAGES_PER_SUMMARY || '40', 10);
const OVERLAP = Math.max(0, parseInt(SUMMARY_OVERLAP || '5', 10));

const messageSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true, index: true },
    messageId: { type: String, required: true, unique: true },
    isCreatedByUser: { type: Boolean, default: false },
    text: { type: String },
    content: { type: Array },
    user: { type: String },
  },
  { timestamps: true, collection: 'messages', strict: false },
);

const conversationSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true, unique: true },
    lastSummarizedIndex: { type: Number, default: 0 },
    user: { type: String },
  },
  { collection: 'conversations', strict: false },
);

const Message = mongoose.model('Message', messageSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);

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
      ? msg.content
          .filter((p) => p.type === 'text' && p.text)
          .map((p) => p.text)
          .join('\n')
      : '');
  return msg.isCreatedByUser ? rawText : cleanAssistantText(rawText);
};

async function handleReset(filter) {
  const targetDescription = filter.conversationId ? `conversation ${filter.conversationId}` : 'all conversations';
  console.log(`[RESET_SUMMARIES] Preparing to reset summarization index for ${targetDescription}...`);
  const res = await Conversation.updateMany(filter, { $set: { lastSummarizedIndex: 0 } });
  console.log('[RESET_SUMMARIES] --- Reset Summary ---');
  console.log(`- Matched conversations: ${res.matchedCount}`);
  console.log(`- Modified conversations: ${res.modifiedCount}`);
}

async function publishSummary(payload) {
  try {
    await enqueueSummaryTask(payload);
    return 1;
  } catch (err) {
    logger.error('[MANAGE_SUMMARIES] Ошибка отправки задачи в Temporal:', err);
    return 0;
  }
}

async function handleResummarize(filter) {
  const targetDescription = filter.conversationId ? `conversation ${filter.conversationId}` : 'all conversations';
  console.log(`[RESUMMARIZE] Starting process for ${targetDescription}...`);

  const conversations = await Conversation.find(filter).lean();
  console.log(`[RESUMMARIZE] Found ${conversations.length} conversations to process.`);

  let totalTasksCreated = 0;

  for (const convo of conversations) {
    const { conversationId, user, lastSummarizedIndex = 0 } = convo;

    const allMessages = await Message.find({ conversationId }).sort({ createdAt: 1 }).lean();
    const messageCount = allMessages.length;

    let currentIndex = lastSummarizedIndex;

    console.log(`\n--- Processing convo ${conversationId} ---`);
    console.log(`Total messages: ${messageCount}, Last summarized index: ${currentIndex}, OVERLAP=${OVERLAP}, WINDOW=${MAX_MESSAGES_PER_SUMMARY}`);

    if (messageCount - currentIndex < SUMMARIZATION_THRESHOLD) {
      console.log('Not enough new messages to meet threshold. Skipping.');
      continue;
    }

    while (currentIndex < messageCount) {
      const windowSize = Math.min(MAX_MESSAGES_PER_SUMMARY, messageCount - currentIndex);
      if (windowSize < 2) {
        console.log('Not enough messages left for a meaningful summary. Breaking loop.');
        break;
      }

      const messagesToSummarize = allMessages.slice(currentIndex, currentIndex + windowSize);

      const formattedMessages = messagesToSummarize
        .map((msg) => ({
          role: msg.isCreatedByUser ? 'user' : 'assistant',
          content: extractText(msg),
        }))
        .filter((m) => !!m.content);

      if (formattedMessages.length < 2) {
        console.log('After cleaning, not enough content to summarize. Advancing index by 1 to avoid stall.');
        currentIndex += 1;
        continue;
      }

      const startId = messagesToSummarize[0].messageId;
      const endId = messagesToSummarize[messagesToSummarize.length - 1].messageId;

      const payload = {
        conversation_id: conversationId,
        user_id: user,
        messages: formattedMessages,
        start_message_id: startId,
        end_message_id: endId,
      };

      const publishedCount = await publishSummary(payload);
      totalTasksCreated += publishedCount;

      const step = Math.max(1, windowSize - OVERLAP);
      const newIndex = currentIndex + step;

      await Conversation.updateOne(
        { conversationId },
        { $set: { lastSummarizedIndex: newIndex } }
      );

      console.log(`- Created task for messages [${currentIndex} - ${currentIndex + windowSize - 1}] (start=${startId}, end=${endId}), step=${step} → lastSummarizedIndex=${newIndex}`);

      currentIndex = newIndex;

      if (step <= 0) {
        console.log('Step computed as <= 0; forcing break to avoid stall.');
        break;
      }

      if (messageCount - currentIndex < SUMMARIZATION_THRESHOLD) {
        console.log('Remaining messages below threshold; stopping for this conversation.');
        break;
      }
    }
  }

  console.log('---');
  console.log(`[RESUMMARIZE] Finished. Total tasks created: ${totalTasksCreated}`);
}

(async () => {
  console.log('[MANAGE_SUMMARIES] Starting…');
  try {
    await mongoose.connect(MONGO_URI);
    console.log('[MANAGE_SUMMARIES] Connected to MongoDB.');
  } catch (err) {
    console.error('[MANAGE_SUMMARIES] MongoDB connect failed:', err);
    process.exit(1);
  }

  try {
    const args = process.argv.slice(2);
    if (args[0] === 'reset') {
      const filter = args[1] ? { conversationId: args[1] } : {};
      await handleReset(filter);
    } else {
      const filter = args[0] ? { conversationId: args[0] } : {};
      await handleResummarize(filter);
    }
  } catch (err) {
    console.error('[MANAGE_SUMMARIES] Error:', err);
  } finally {
    try { await mongoose.disconnect(); } catch {}
    console.log('[MANAGE_SUMMARIES] Done.');
  }
})();
