const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');

const logger = getLogger('utils.response');

/**
 * Checks if response is writable
 * @param {Object} res
 * @returns {boolean}
 */
function canWrite(res) {
  return Boolean(res) && res.writable !== false && !res.writableEnded;
}

/**
 * Checks if response is finalized
 * @param {Object} resLike
 * @returns {boolean}
 */
function isResponseFinalized(resLike) {
  if (!resLike) return false;
  return Boolean(resLike.finished || resLike.headersSent);
}

/**
 * Creates a detachable response wrapper
 * @param {Object} res
 * @returns {Object}
 */
function makeDetachableRes(res) {
  let detached = false;
  return {
    setDetached(v = true) {
      detached = v;
    },
    write(...args) {
      if (!detached && canWrite(res)) {
        try {
          return res.write(...args);
        } catch (_) {
          return true;
        }
      }
      return true;
    },
    end(...args) {
      if (!detached && canWrite(res)) {
        try {
          return res.end(...args);
        } catch (_) {}
      }
    },
    flushHeaders() {
      if (!detached && typeof res.flushHeaders === 'function') {
        try {
          res.flushHeaders();
        } catch (_) {}
      }
    },
    get headersSent() {
      return detached ? true : res.headersSent;
    },
    get finished() {
      return detached ? true : res.finished;
    },
    on: (...args) => res.on(...args),
    removeListener: (...args) => res.removeListener(...args),
  };
}

/**
 * Safely ends response if not already ended
 * @param {Object} res
 */
function safeEndResponse(res, context = {}) {
  if (canWrite(res)) {
    try {
      res.end();
    } catch (error) {
      logger.error('utils.response.end_error', buildContext(context, { err: error }));
    }
    return;
  }
  logger.warn('utils.response.write_skip', buildContext(context, { reason: 'end_not_writable' }));
}

/**
 * Safely writes to response if writable
 * @param {Object} res
 * @param {string} data
 * @returns {boolean}
 */
function safeWrite(res, data, context = {}) {
  if (canWrite(res)) {
    try {
      return res.write(data);
    } catch (error) {
      logger.error('utils.response.write_error', buildContext(context, { err: error }));
      return false;
    }
  }
  logger.warn('utils.response.write_skip', buildContext(context, { reason: 'not_writable' }));
  return false;
}

module.exports = {
  canWrite,
  isResponseFinalized,
  makeDetachableRes,
  safeEndResponse,
  safeWrite,
};
