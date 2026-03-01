'use strict';

const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { configService } = require('../server/services/Config/ConfigService');

let cached = global.mongoose;
if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

function buildMongoOptions(mongoConfig) {
  const options = { bufferCommands: false };

  if (typeof mongoConfig.maxPoolSize === 'number') {
    options.maxPoolSize = mongoConfig.maxPoolSize;
  }
  if (typeof mongoConfig.minPoolSize === 'number') {
    options.minPoolSize = mongoConfig.minPoolSize;
  }
  if (typeof mongoConfig.maxConnecting === 'number') {
    options.maxConnecting = mongoConfig.maxConnecting;
  }
  if (typeof mongoConfig.maxIdleTimeMS === 'number') {
    options.maxIdleTimeMS = mongoConfig.maxIdleTimeMS;
  }
  if (typeof mongoConfig.waitQueueTimeoutMS === 'number') {
    options.waitQueueTimeoutMS = mongoConfig.waitQueueTimeoutMS;
  }
  if (typeof mongoConfig.autoIndex === 'boolean') {
    options.autoIndex = mongoConfig.autoIndex;
  }
  if (typeof mongoConfig.autoCreate === 'boolean') {
    options.autoCreate = mongoConfig.autoCreate;
  }

  return options;
}

async function connectDb() {
  const mongoConfig = config.getSection('mongo');
  if (!mongoConfig.uri) {
    throw new Error('MONGO_URI is required but not configured.');
  }

  if (cached.conn && cached.conn?._readyState === 1) {
    return cached.conn;
  }

  if (!cached.promise || (cached.conn && cached.conn?._readyState !== 1)) {
    const options = buildMongoOptions(mongoConfig);
    logger.info('[Mongo] Connection options', options);
    mongoose.set('strictQuery', true);
    cached.promise = mongoose.connect(mongoConfig.uri, options).then((mongooseInstance) => mongooseInstance);
  }

  cached.conn = await cached.promise;

  try {
    const { Message } = require('./models');
    if (!Message.schema.path('isMemoryStored')) {
      Message.schema.add({ isMemoryStored: { type: Boolean, default: false, index: true } });
      await Message.syncIndexes();
      logger.info('[SchemaPatch] Successfully patched Message schema with "isMemoryStored".');
    } else {
      logger.info('[SchemaPatch] "isMemoryStored" already exists.');
    }
  } catch (error) {
    logger.error('[SchemaPatch] Failed to patch Message schema:', error);
  }

  return cached.conn;
}

module.exports = {
  connectDb,
};
