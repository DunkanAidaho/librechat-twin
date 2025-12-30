// /opt/open-webui/CustomConnect.js

const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');

const connect = async () => {
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/LibreChat';

  try {
    if (mongoose.connection.readyState === 0) {
      mongoose.set('strictQuery', false);
      await mongoose.connect(mongoUri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
    }
    logger.info('MongoDB connected');

    // --- НАШ ПАТЧ ДЛЯ СХЕМЫ ---
    try {
      const { Message } = require('./models'); // Получаем скомпилированную модель
      if (!Message.schema.path('isMemoryStored')) { // Проверяем, нет ли уже поля
        Message.schema.add({ isMemoryStored: { type: Boolean, default: false, index: true } }); // Добавляем поле в схему
        await Message.syncIndexes(); // Обновляем индексы в БД
        logger.info('[SchemaPatch] Successfully patched Message schema with "isMemoryStored" field.');
      } else {
        logger.info('[SchemaPatch] "isMemoryStored" field already exists in Message schema.');
      }
    } catch (error) {
      logger.error('[SchemaPatch] Failed to patch Message schema:', error);
      throw error; // Останавливаем приложение, если не удалось пропатчить схему
    }
    // --- КОНЕЦ ПАТЧА ---

  } catch (err) {
    logger.error('Failed to connect to MongoDB', err);
    throw err;
  }
};

module.exports = connect;
