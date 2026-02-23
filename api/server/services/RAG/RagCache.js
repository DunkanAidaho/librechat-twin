const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');
const logger = getLogger('rag.cache');

/**
 * LRU Cache for RAG context with TTL support
 */
class RagCache {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 1000;
    this.ttlMs = options.ttlMs || 300000;
    this.cache = new Map();
    this.accessOrder = new Map();
    this.metrics = {
      hits: 0,
      misses: 0,
      evictions: 0,
      expirations: 0,
    };
  }

  /**
   * Gets cache entry
   * @param {string} key
   * @returns {any|null}
   */
  get(key) {
    const entry = this.cache.get(key);

    if (!entry) {
      this.metrics.misses++;
      return null;
    }

    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      this.accessOrder.delete(key);
      this.metrics.expirations++;
      this.metrics.misses++;
      return null;
    }

    this.accessOrder.delete(key);
    this.accessOrder.set(key, Date.now());

    this.metrics.hits++;
    return entry;
  }

  /**
   * Sets cache entry
   * @param {string} key
   * @param {any} value
   * @param {number} ttlMs
   */
  set(key, value, ttlMs = this.ttlMs) {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : null;

    this.cache.set(key, {
      ...value,
      expiresAt,
    });

    this.accessOrder.set(key, Date.now());
  }

  /**
   * Evicts least recently used entry
   */
  evictLRU() {
    if (this.accessOrder.size === 0) return;

    const oldestKey = this.accessOrder.keys().next().value;

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.accessOrder.delete(oldestKey);
      this.metrics.evictions++;

      logger.debug('rag.cache.evict_lru', buildContext({}, { key: oldestKey }));
    }
  }

  /**
   * Prunes expired entries
   * @param {number} now
   * @returns {number}
   */
  pruneExpired(now = Date.now()) {
    let pruned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.cache.delete(key);
        this.accessOrder.delete(key);
        this.metrics.expirations++;
        pruned++;
      }
    }

    if (pruned > 0) {
      logger.debug('rag.cache.prune_expired', buildContext({}, { count: pruned }));
    }

    return pruned;
  }

  /**
   * Clears all cache entries
   */
  clear() {
    this.cache.clear();
    this.accessOrder.clear();
    logger.info('rag.cache.cleared', buildContext({}, {}));
  }

  /**
   * Gets cache size
   * @returns {number}
   */
  size() {
    return this.cache.size;
  }

  /**
   * Gets cache metrics
   * @returns {Object}
   */
  getMetrics() {
    const total = this.metrics.hits + this.metrics.misses;
    const hitRate = total > 0 ? this.metrics.hits / total : 0;

    return {
      ...this.metrics,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: Math.round(hitRate * 10000) / 100,
    };
  }

  /**
   * Resets metrics
   */
  resetMetrics() {
    this.metrics = {
      hits: 0,
      misses: 0,
      evictions: 0,
      expirations: 0,
    };
  }

  /**
   * Logs cache metrics
   */
  logMetrics() {
    const metrics = this.getMetrics();
    logger.info('rag.cache.metrics', buildContext({}, metrics));
  }
}

module.exports = RagCache;
