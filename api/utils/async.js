'use strict';

const ABORT_ERROR_MESSAGE = 'Операция была прервана';

function createAbortError(signal) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  const error = new Error(ABORT_ERROR_MESSAGE);
  error.name = 'AbortError';
  return error;
}

function sleep(timeoutMs, signal) {
  if (timeoutMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError(signal));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const onAbort = () => {
      cleanup();
      reject(createAbortError(signal));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function withTimeout(
  promise,
  timeoutMs,
  timeoutMessage = 'Операция превысила таймаут',
  signal,
) {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timer;
  let abortHandler;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${timeoutMessage} (${timeoutMs} мс)`));
    }, timeoutMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    if (signal) {
      abortHandler = () => {
        cleanup();
        reject(createAbortError(signal));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler);
      abortHandler = null;
    }
  };

  return Promise.race([promise, timeoutPromise]).finally(cleanup);
}

function computeDelay(attempt, minDelay, factor, maxDelay, jitterRatio) {
  const rawDelay = Math.min(maxDelay, minDelay * Math.pow(factor, attempt));
  if (!jitterRatio || jitterRatio <= 0) {
    return rawDelay;
  }

  const jitter = rawDelay * jitterRatio * Math.random();
  return Math.max(0, rawDelay - jitter);
}

async function retryAsync(fn, options = {}) {
  const {
    retries = 3,
    minDelay = 100,
    maxDelay = 5000,
    factor = 2,
    jitter = 0.2,
    onRetry,
    signal,
  } = options;

  let attempt = 0;
  let lastError;

  while (attempt <= retries) {
    if (signal?.aborted) {
      throw createAbortError(signal);
    }

    try {
      const result = await fn(attempt);
      return result;
    } catch (error) {
      lastError = error;
      
      // Don't retry on abort errors
      if (error?.name === 'AbortError' || error?.message?.includes('абортирован')) {
        throw error;
      }
      
      if (attempt === retries) {
        break;
      }

      attempt += 1;

      if (typeof onRetry === 'function') {
        try {
          await onRetry(error, attempt);
        } catch (hookError) {
          lastError = hookError;
          break;
        }
      }

      const delay = computeDelay(attempt, minDelay, factor, maxDelay, jitter);
      await sleep(delay, signal);
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('retryAsync завершился без результата и без ошибки');
}

module.exports = {
  withTimeout,
  retryAsync,
  sleep,
  createAbortError,
};
