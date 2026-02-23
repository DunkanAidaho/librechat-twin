'use strict';
const crypto = require('crypto');
const axios = require('axios');
const config = require('~/server/services/Config/ConfigService');
const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');

const logger = getLogger('rag.condense');

let pLimitInstance;

async function getPLimit() {
  if (!pLimitInstance) {
    const module = await import('p-limit');
    pLimitInstance = module.default;
  }
  return pLimitInstance;
}

const { getRedisClient } = require('../../../utils/rag_redis');

const ragConfig = config.getSection('rag');
const featuresConfig = config.getSection('features');
const coreConfig = config.getSection('core');

const condenseConfig = ragConfig.condense;
const ragContextConfig = ragConfig.context;
const providersConfig = ragConfig.providers || {};
const openrouterConfig = providersConfig.openrouter || {};
const ollamaConfig = providersConfig.ollama || {};

const allowLocalFallbackConfig =
  providersConfig.allowLocalFallback === undefined
    ? true
    : Boolean(providersConfig.allowLocalFallback);

const DEBUG_CONDENSE = Boolean(condenseConfig.debug || featuresConfig.debugCondense);
const GRAPH_CONTEXT_SUMMARY_LINE_LIMIT = ragContextConfig.summaryLineLimit;
const GRAPH_CONTEXT_SUMMARY_HINT_MAX_CHARS = ragContextConfig.summaryHintMaxChars;
const GRAPH_CONTEXT_INCLUDE_IN_SUMMARY = ragContextConfig.includeGraphInSummary;

// ИСПРАВЛЕНО: Читаем таймаут из конфигурации с увеличенным дефолтом
const CONDENSE_TIMEOUT_MS = condenseConfig.timeoutMs || 125000;
const SUMMARY_SYSTEM_PROMPT =
  'Ты — аккуратный компрессор текста для LibreChat. Соблюдай формат инструкции и не добавляй лишних пояснений.';

function resolveFirstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) {
      continue;
    }
    const str = String(value).trim();
    if (str.length > 0) {
      return str;
    }
  }
  return '';
}

function sanitizeProviderName(value) {
  if (!value) {
    return '';
  }
  return String(value).trim().toLowerCase();
}

function localFallback(text, budgetChars) {
  if (!text) {
    return '';
  }
  if (!budgetChars || budgetChars <= 0 || text.length <= budgetChars) {
    return text;
  }
  const half = Math.max(1, Math.floor(budgetChars / 2));
  return `${text.slice(0, half)}\n...\n${text.slice(-half)}`;
}

function describeProviderChain(chain) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return 'none';
  }
  return chain.map((descriptor) => descriptor?.label || descriptor?.provider || 'unknown').join(' -> ');
}

function splitIntoChunks(text, target = 12000, hardMax = 15000) {
  if (!text || typeof text !== 'string') return [];
  const parts = [];
  let buffer = '';
  const flush = () => {
    if (buffer.trim().length) parts.push(buffer);
    buffer = '';
  };
  const para = text.split(/\n{2,}/g);
  for (const p of para) {
    if ((buffer + '\n\n' + p).length <= target) {
      buffer = buffer ? buffer + '\n\n' + p : p;
    } else if (p.length <= hardMax) {
      flush();
      buffer = p;
      flush();
    } else {
      const sents = p.split(/(?<=[.!?])\s+(?=[A-ZА-ЯЁ0-9])/g);
      for (const s of sents) {
        if ((buffer + ' ' + s).length <= target) {
          buffer = buffer ? buffer + ' ' + s : s;
        } else if (s.length <= hardMax) {
          flush();
          buffer = s;
          flush();
        } else {
          let i = 0;
          while (i < s.length) {
            parts.push(s.slice(i, i + target));
            i += target;
          }
          buffer = '';
        }
      }
      flush();
    }
  }
  flush();
  return parts;
}

function mapPrompt(userQuery, graphExtra) {
  const basePrompt = `Ты — аккуратный компрессор текста. Сделай максимально полную, но компактную выжимку без потерь смыслов, цифр, дат, имён.
Формат:
- Краткое содержание (2–4 предложения)
- Ключевые факты (буллеты, с числами/датами)
- Термины/обозначения
- Если релевантно запросу пользователя, отметь релевантные фрагменты.
Запрос пользователя: ${userQuery || '(нет)'}
Не фантазируй. Язык исходного текста.`;
  const extras = [];

  if (graphExtra && graphExtra.hint) {
    extras.push(`Графовые подсказки: ${graphExtra.hint}`);
  }

  if (graphExtra && Array.isArray(graphExtra.lines) && graphExtra.lines.length) {
    extras.push(`Графовые связи:\n${graphExtra.lines.join('\n')}`);
  }

  return [basePrompt, ...extras].join('\n');
}

function reducePrompt(userQuery, budget, graphExtra) {
  const basePrompt = `Объедини частичные выжимки в единую до ~${budget} символов.
Тот же формат как выше. Запрос: ${userQuery || '(нет)'}
Не выдумывай, только из входных выжимок.`;
  const extras = [];

  if (graphExtra && graphExtra.hint) {
    extras.push(`Графовые подсказки: ${graphExtra.hint}`);
  }

  if (graphExtra && Array.isArray(graphExtra.lines) && graphExtra.lines.length) {
    extras.push(`Графовые связи:\n${graphExtra.lines.join('\n')}`);
  }

  return [basePrompt, ...extras].join('\n');
}

function sha1(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function cacheKeyChunk(chainSignature, budget, userQuery, chunk, graphExtra) {
  return `mr:sum:v4:${sha1(`${chainSignature}|${budget}|${mapPrompt(userQuery, graphExtra)}|${chunk}`)}`;
}
function cacheKeyReduce(chainSignature, budget, userQuery, joined, graphExtra) {
  return `mr:red:v4:${sha1(`${chainSignature}|${budget}|${reducePrompt(userQuery, budget, graphExtra)}|${joined}`)}`;
}

function prepareGraphExtras(graphContext) {
  if (!GRAPH_CONTEXT_INCLUDE_IN_SUMMARY || !graphContext) {
    return { lines: [], hint: '' };
  }

  const rawLines = Array.isArray(graphContext.lines) ? graphContext.lines : [];
  const sanitizedLines = rawLines
    .map((line) => (line == null ? '' : String(line).trim()))
    .filter((line) => Boolean(line));

  if (sanitizedLines.length > GRAPH_CONTEXT_SUMMARY_LINE_LIMIT) {
    sanitizedLines.length = GRAPH_CONTEXT_SUMMARY_LINE_LIMIT;
  }

  let hint = typeof graphContext.queryHint === 'string' ? graphContext.queryHint.trim() : '';
  if (hint && hint.length > GRAPH_CONTEXT_SUMMARY_HINT_MAX_CHARS) {
    hint = hint.slice(0, GRAPH_CONTEXT_SUMMARY_HINT_MAX_CHARS) + '…';
  }

  return { lines: sanitizedLines, hint };
}

function resolveSummarizerProviders({ includeLocalFallback = true } = {}) {
  const descriptors = [];
  const warnings = [];
  const errors = [];

  const primaryRaw = resolveFirstNonEmpty(
    providersConfig.condenseProvider,
    providersConfig.summarizerType,
    'openrouter',
  );
  let primaryProvider = sanitizeProviderName(primaryRaw);

  if (['google', 'vertex', 'vertexai'].includes(primaryProvider)) {
    warnings.push('Провайдер Google/Vertex отключён для Map-Reduce RAG. Используем OpenRouter.');
    primaryProvider = 'openrouter';
  }

  if (!primaryProvider) {
    primaryProvider = 'openrouter';
  }

  const fallbackProvider = sanitizeProviderName(providersConfig.fallbackProvider);
  const fallbackModel = resolveFirstNonEmpty(providersConfig.fallbackModel);

  const defaultOpenRouterModel = resolveFirstNonEmpty(
    providersConfig.condenseModel,
    openrouterConfig.summaryModel,
    openrouterConfig.titleModel,
    'openrouter/meta-llama/llama-3.1-8b-instruct',
  );

  const addDescriptor = (providerName, modelValue, options = {}) => {
    const normalized = sanitizeProviderName(providerName);
    if (!normalized) {
      return false;
    }

    if (normalized === 'none' || normalized === 'disabled') {
      descriptors.push({ provider: 'none', model: '', label: 'none', options: {} });
      return true;
    }

    if (normalized === 'openrouter') {
      const apiKey = resolveFirstNonEmpty(options.apiKey, openrouterConfig.apiKey);
      if (!apiKey) {
        errors.push('Отсутствует OPENROUTER_API_KEY для использования OpenRouter в Map-Reduce.');
        return false;
      }

      const model = resolveFirstNonEmpty(
        modelValue,
        providersConfig.condenseModel,
        openrouterConfig.summaryModel,
        defaultOpenRouterModel,
      );

      if (!model) {
        errors.push(
          'Не указана модель для OpenRouter (rag.providers.condenseModel или openrouter.summaryModel).',
        );
        return false;
      }

      const baseURL = resolveFirstNonEmpty(
        options.baseURL,
        openrouterConfig.baseUrl,
        'https://openrouter.ai/api/v1',
      );

      // ИСПРАВЛЕНО: Используем переданный timeoutMs или дефолтный
      const timeout = options.timeoutMs || CONDENSE_TIMEOUT_MS;

      descriptors.push({
        provider: 'openrouter',
        model,
        label: `openrouter:${model}`,
        options: {
          baseURL,
          apiKey,
          timeout,
          referer: resolveFirstNonEmpty(
            options.referer,
            openrouterConfig.referer,
            coreConfig.serverDomain,
            coreConfig.publicServerDomain,
            'https://librechat.local',
          ),
          appName: resolveFirstNonEmpty(
            options.appName,
            openrouterConfig.appName,
            'LibreChat RAG Condenser',
          ),
        },
      });
      return true;
    }

    if (normalized === 'ollama') {
      const url = resolveFirstNonEmpty(options.url, ollamaConfig.url);
      if (!url) {
        errors.push(
          'Для провайдера Ollama требуется указать URL (OLLAMA_URL или OLLAMA_SUMMARIZATION_URL).',
        );
        return false;
      }

      const model = resolveFirstNonEmpty(modelValue, ollamaConfig.model, 'gemma:7b-instruct');
      
      // ИСПРАВЛЕНО: Используем переданный timeoutMs или дефолтный
      const timeout = options.timeoutMs || CONDENSE_TIMEOUT_MS;

      descriptors.push({
        provider: 'ollama',
        model,
        label: `ollama:${model}`,
        options: {
          url,
          timeout,
        },
      });
      return true;
    }

    if (normalized === 'local' || normalized === 'truncate') {
      descriptors.push({
        provider: 'local',
        model: 'truncate',
        label: 'local:truncate',
        options: {},
      });
      return true;
    }

    errors.push(`Неизвестный провайдер "${providerName}" для RAG конденсации.`);
    return false;
  };

  addDescriptor(primaryProvider, providersConfig.condenseModel);

  if (fallbackProvider) {
    addDescriptor(fallbackProvider, fallbackModel);
  }

  const legacyOllama = ollamaConfig.legacyFlag === true;

  if (legacyOllama && !descriptors.some((descriptor) => descriptor.provider === 'ollama')) {
    addDescriptor('ollama', ollamaConfig.model, { url: ollamaConfig.url });
    warnings.push(
      'Используется устаревший флаг USE_OLLAMA_FOR_SUMMARIZATION. Рекомендуется перейти на rag.providers.condenseProvider/rag.providers.fallbackProvider.',
    );
  }

  if (errors.length) {
    throw new Error(errors.join(' '));
  }

  if (!descriptors.length) {
    throw new Error('Не настроен ни один провайдер для RAG Map-Reduce.');
  }

  const hasActiveProvider = descriptors.some(
    (descriptor) => !['local', 'none', 'disabled'].includes(descriptor.provider),
  );

  const allowLocalFallback =
    includeLocalFallback && allowLocalFallbackConfig !== false;

  if (allowLocalFallback && hasActiveProvider && !descriptors.some((descriptor) => descriptor.provider === 'local')) {
    descriptors.push({
      provider: 'local',
      model: 'truncate',
      label: 'local:truncate',
      options: {},
    });
  }

  const signature = descriptors.map((descriptor) => descriptor.label).join('>') || 'none';

  return {
    chain: descriptors,
    warnings,
    signature,
  };
}

async function callOpenRouter(descriptor, prompt) {
  const payload = {
    model: descriptor.model,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    stream: false,
    temperature: 0.2,
  };

  const headers = {
    Authorization: `Bearer ${descriptor.options.apiKey}`,
    'Content-Type': 'application/json',
  };

  if (descriptor.options.referer) {
    headers['HTTP-Referer'] = descriptor.options.referer;
  }
  if (descriptor.options.appName) {
    headers['X-Title'] = descriptor.options.appName;
  }

  const response = await axios.post(
    `${descriptor.options.baseURL}/chat/completions`,
    payload,
    {
      timeout: descriptor.options.timeout || CONDENSE_TIMEOUT_MS,
      headers,
    },
  );

  const content = response?.data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Пустой ответ OpenRouter (choices[0].message.content отсутствует).');
  }

  return String(content).trim();
}

async function callOllama(descriptor, prompt) {
  const payload = {
    model: descriptor.model,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    stream: false,
    options: {
      temperature: 0.2,
    },
  };

  const response = await axios.post(
    `${descriptor.options.url}/api/chat`,
    payload,
    {
      timeout: descriptor.options.timeout || CONDENSE_TIMEOUT_MS,
    },
  );

  const content = response?.data?.message?.content;
  if (!content) {
    throw new Error('Пустой ответ Ollama (message.content отсутствует).');
  }

  return String(content).trim();
}

async function summarizeWithDescriptor(descriptor, { prompt, originalText, budgetChars }) {
  switch (descriptor.provider) {
    case 'openrouter':
      return callOpenRouter(descriptor, prompt);
    case 'ollama':
      return callOllama(descriptor, prompt);
    case 'local':
      return localFallback(originalText, budgetChars);
    case 'none':
      return originalText;
    default:
      throw new Error(`Неизвестный провайдер суммаризации "${descriptor.provider}"`);
  }
}

async function summarizeWithChain({ chain, prompt, originalText, budgetChars, stage }) {
  for (const descriptor of chain) {
    try {
      const result = await summarizeWithDescriptor(descriptor, { prompt, originalText, budgetChars });
      if (typeof result === 'string' && result.trim().length > 0) {
        return { text: result.trim(), providerLabel: descriptor.label };
      }
      logger.warn(`[RAG][condense] ${stage} провайдер ${descriptor.label} вернул пустой результат.`);
    } catch (error) {
      logger.error(
        `[RAG][condense] ${stage} провайдер ${descriptor.label} завершился ошибкой: ${error.message}`,
        {
          provider: descriptor.label,
          stage,
          stack: error?.stack,
        },
      );
    }
  }

  return { text: '', providerLabel: null };
}

async function condenseContext({
  req,
  res,
  endpointOption,
  contextText,
  userQuery,
  budgetChars = 12000,
  chunkChars = 20000,
  graphContext = null,
  timeoutMs = null, // ДОБАВЛЕНО: Принимаем таймаут извне
}) {
  const t0 = Date.now();
  try {
    // ИСПРАВЛЕНО: Передаем timeoutMs в resolveSummarizerProviders
    const effectiveTimeout = timeoutMs || CONDENSE_TIMEOUT_MS;
    
    logger.info('[RAG][condense] Configuration', {
      budgetChars,
      chunkChars,
      timeoutMs: effectiveTimeout,
      contextLength: contextText.length,
    });
    
    const { chain: providerChain, warnings, signature: chainSignature } = resolveSummarizerProviders();
    warnings.forEach((message) => logger.warn(`[RAG][condense] ${message}`));

    // ИСПРАВЛЕНО: Обновляем таймауты в дескрипторах провайдеров
    for (const descriptor of providerChain) {
      if (descriptor.options && typeof descriptor.options === 'object') {
        descriptor.options.timeout = effectiveTimeout;
      }
    }

    if (!providerChain.length) {
      logger.warn('[RAG][condense] Цепочка провайдеров пуста, возвращаем исходный контекст.');
      return contextText;
    }

    if (providerChain.length === 1 && providerChain[0].provider === 'none') {
      logger.info('[RAG][condense] Провайдер "none" активирован. Map-Reduce отключён.');
      return contextText;
    }

    const chunks = splitIntoChunks(contextText, chunkChars, Math.floor(chunkChars * 1.25));
    const providerChainLabel = describeProviderChain(providerChain);
    logger.info(
      `[RAG][condense] MR-Start: chunks=${chunks.length}, budget=${budgetChars}, chunkChars=${chunkChars}, timeout=${effectiveTimeout}ms, providers=${providerChainLabel}`,
    );

    const graphExtra = prepareGraphExtras(graphContext);
    if (DEBUG_CONDENSE && (graphExtra.hint || graphExtra.lines.length)) {
      logger.info(
        `[RAG][condense] Graph extras enabled (lines=${graphExtra.lines.length}, hint=${graphExtra.hint ? graphExtra.hint.length : 0} chars).`,
      );
    }

    const r = getRedisClient();
    const CONCURRENCY = condenseConfig.concurrency;
    const CACHE_TTL = condenseConfig.cacheTtlSeconds;

    const actualPLimit = await getPLimit();
    const limit = actualPLimit(CONCURRENCY);

    if (DEBUG_CONDENSE) {
      logger.info(`[RAG][condense] Concurrency limit: ${CONCURRENCY}, Cache TTL: ${CACHE_TTL}s, Timeout: ${effectiveTimeout}ms`);
    }

    const summaries = await Promise.all(
      chunks.map((chunk, index) =>
        limit(async () => {
          const chunkNumber = index + 1;
          const prompt = `${mapPrompt(userQuery, graphExtra)}\n\n=== Текст чанка ===\n${chunk}`;
          const cacheKey = cacheKeyChunk(chainSignature, budgetChars, userQuery, chunk, graphExtra);

          if (r && CACHE_TTL > 0) {
            try {
              const cached = await r.get(cacheKey);
              if (cached) {
                const cachedValue = JSON.parse(cached);
                const cachedSummary =
                  typeof cachedValue === 'string' ? cachedValue : cachedValue?.summary;
                if (cachedSummary) {
                  if (DEBUG_CONDENSE) {
                    const cachedProvider =
                      typeof cachedValue === 'object' && cachedValue?.provider
                        ? cachedValue.provider
                        : 'cache';
                    logger.info(
                      `[RAG][condense] Cache hit for chunk ${chunkNumber}/${chunks.length} (provider=${cachedProvider}).`,
                    );
                  }
                  return cachedSummary;
                }
              }
            } catch (cacheError) {
              logger.warn('[RAG][condense] Ошибка чтения кеша суммаризации чанка', {
                error: cacheError?.message,
              });
            }
          }

          logger.info(`[RAG][condense] Summarizing chunk ${chunkNumber}/${chunks.length}...`);
          const { text, providerLabel } = await summarizeWithChain({
            chain: providerChain,
            prompt,
            originalText: chunk,
            budgetChars,
            stage: `map:${chunkNumber}/${chunks.length}`,
          });

          let summaryText = typeof text === 'string' ? text.trim() : '';
          let summaryProvider = providerLabel || 'unknown';

          if (!summaryText) {
            summaryText = localFallback(chunk, budgetChars);
            summaryProvider = 'local:truncate';
            logger.warn(
              `[RAG][condense] map:${chunkNumber}/${chunks.length} используется локальный fallback (len=${summaryText.length}).`,
            );
          } else {
            logger.info(
              `[RAG][condense] map:${chunkNumber}/${chunks.length} провайдер=${summaryProvider} -> len=${summaryText.length}`,
            );
          }

          if (
            r &&
            CACHE_TTL > 0 &&
            summaryText &&
            summaryProvider &&
            !summaryProvider.startsWith('local:') &&
            summaryProvider !== 'none'
          ) {
            try {
              await r.setex(
                cacheKey,
                CACHE_TTL,
                JSON.stringify({ summary: summaryText, provider: summaryProvider }),
              );
              if (DEBUG_CONDENSE) {
                logger.info(
                  `[RAG][condense] Cached chunk ${chunkNumber}/${chunks.length} (provider=${summaryProvider}).`,
                );
              }
            } catch (setError) {
              logger.warn('[RAG][condense] Не удалось записать суммаризацию чанка в кеш', {
                error: setError?.message,
              });
            }
          }

          return summaryText;
        }),
      ),
    );

    const joined = summaries.filter(Boolean).join('\n\n---\n\n');
    logger.info(
      `[RAG][condense] Map-Phase finished: ${summaries.length} chunks summarized into ${joined.length} chars. Wall-clock: ${(Date.now() - t0) / 1000}s`,
    );

    if (!joined || joined.length <= budgetChars || summaries.length <= 1) {
      if (DEBUG_CONDENSE) {
        logger.info(
          `[RAG][condense] Skipping Reduce-Phase (joined length ${joined.length} <= budget ${budgetChars} or single chunk).`,
        );
      }
      logger.info(
        `[RAG][condense] MR-Finished. Final context length: ${joined.length}. Total wall-clock: ${(Date.now() - t0) / 1000}s`,
      );
      return joined || contextText;
    }

    if (DEBUG_CONDENSE) {
      logger.info(
        `[RAG][condense] Starting Reduce-Phase (joined length ${joined.length} > budget ${budgetChars}).`,
      );
    }

    const reduceCacheKey = cacheKeyReduce(chainSignature, budgetChars, userQuery, joined, graphExtra);
    if (r && CACHE_TTL > 0) {
      try {
        const cachedReduce = await r.get(reduceCacheKey);
        if (cachedReduce) {
          const cachedValue = JSON.parse(cachedReduce);
          const cachedSummary =
            typeof cachedValue === 'string' ? cachedValue : cachedValue?.summary;
          if (cachedSummary) {
            if (DEBUG_CONDENSE) {
              const cachedProvider =
                typeof cachedValue === 'object' && cachedValue?.provider
                  ? cachedValue.provider
                  : 'cache';
              logger.info(`[RAG][condense] Reduce cache hit (provider=${cachedProvider}).`);
            }
            logger.info(
              `[RAG][condense] MR-Finished. Final context length: ${cachedSummary.length}. Total wall-clock: ${(Date.now() - t0) / 1000}s`,
            );
            return cachedSummary;
          }
        }
      } catch (cacheError) {
        logger.warn('[RAG][condense] Ошибка чтения кеша reduce-фазы', {
          error: cacheError?.message,
        });
      }
    }

    const reducePromptText = `${reducePrompt(userQuery, budgetChars, graphExtra)}\n\n=== Частичные выжимки ===\n${joined}`;
    let { text: finalSummary, providerLabel: reduceProviderLabel } = await summarizeWithChain({
      chain: providerChain,
      prompt: reducePromptText,
      originalText: joined,
      budgetChars,
      stage: 'reduce:initial',
    });

    let summaryText = typeof finalSummary === 'string' ? finalSummary.trim() : '';
    let summaryProvider = reduceProviderLabel || 'unknown';

    if (!summaryText) {
      summaryText = localFallback(joined, budgetChars);
      summaryProvider = 'local:truncate';
      logger.warn(
        `[RAG][condense] reduce:initial использует локальный fallback (len=${summaryText.length}).`,
      );
    } else {
      logger.info(
        `[RAG][condense] reduce:initial провайдер=${summaryProvider} -> len=${summaryText.length}`,
      );
    }

    let guard = 0;
    while (summaryText && summaryText.length > budgetChars && guard < 2) {
      const guardPrompt = `Сожми ещё до ~${budgetChars} символов, сохранив ключевые факты и числа.\n\n=== Текст ===\n${summaryText}`;
      const { text: guardText, providerLabel: guardProvider } = await summarizeWithChain({
        chain: providerChain,
        prompt: guardPrompt,
        originalText: summaryText,
        budgetChars,
        stage: `reduce:guard:${guard + 1}`,
      });

      const candidate = typeof guardText === 'string' ? guardText.trim() : '';
      if (!candidate) {
        summaryText = localFallback(summaryText, budgetChars);
        summaryProvider = 'local:truncate';
        logger.warn(
          `[RAG][condense] reduce:guard:${guard + 1} fallback to local truncate (len=${summaryText.length}).`,
        );
        break;
      }

      summaryText = candidate;
      summaryProvider = guardProvider || summaryProvider;
      guard += 1;
      logger.warn(
        `[RAG][condense] Reduce guard pass ${guard}, provider=${summaryProvider}, len=${summaryText.length}`,
      );
    }

    if (
      r &&
      CACHE_TTL > 0 &&
      summaryText &&
      summaryProvider &&
      !summaryProvider.startsWith('local:') &&
      summaryProvider !== 'none'
    ) {
      try {
        await r.setex(
          reduceCacheKey,
          CACHE_TTL,
          JSON.stringify({ summary: summaryText, provider: summaryProvider }),
        );
        if (DEBUG_CONDENSE) {
          logger.info(`[RAG][condense] Cached Reduce result (provider=${summaryProvider}).`);
        }
      } catch (setError) {
        logger.warn('[RAG][condense] Не удалось записать reduce-фазу в кеш', {
          error: setError?.message,
        });
      }
    }

    logger.info(
      `[RAG][condense] MR-Finished. Final context length: ${summaryText.length}. Provider=${summaryProvider}. Total wall-clock: ${(Date.now() - t0) / 1000}s`,
    );
    return summaryText || joined || contextText;
  } catch (error) {
    logger.error(error, '[RAG][condense] Final error in condenseContext');
    return contextText;
  }
}

function getCondenseProvidersPreview() {
  try {
    const { chain } = resolveSummarizerProviders({ includeLocalFallback: false });
    return describeProviderChain(chain);
  } catch (error) {
    return `error:${error.message}`;
  }
}

module.exports = {
  condenseContext,
  getCondenseProvidersPreview,
};
