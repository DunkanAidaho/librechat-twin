const { logger } = require('@librechat/data-schemas');

logger.info('[rag_redis] Redis отключён. getRedisClient() возвращает null.');

function getRedisClient() {
  return null;
}
async function publishToRedis() {
  throw new Error('Redis disabled');
}
async function acquireLock() { return false; }
async function releaseLock() {}

module.exports = { getRedisClient, publishToRedis, acquireLock, releaseLock };
