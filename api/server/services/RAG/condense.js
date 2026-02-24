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

async function summarizeWithChain({ chain, prompt, originalText, budgetChars, stage, requestContext }) {
  for (const descriptor of chain) {
    try {
      const result = await summarizeWithDescriptor(descriptor, { prompt, originalText, budgetChars });
      if (typeof result === 'string' && result.trim().length > 0) {
        return { text: result.trim(), providerLabel: descriptor.label };
      }
      logger.warn(
        'rag.condense.provider_empty',
        buildContext(requestContext || {}, {
          stage,
          provider: descriptor.label,
        }),
      );
    } catch (error) {
      logger.error(
        'rag.condense.provider_error',
        buildContext(requestContext || {}, {
          stage,
          provider: descriptor.label,
          message: error?.message,
          stack: error?.stack,
        }),
      );
    }
  }

  logger.warn(
    'rag.condense.provider_chain_exhausted',
    buildContext(requestContext || {}, { stage }),
  );
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
  const requestContext = buildContext(req || {}, {
    endpoint: endpointOption?.endpoint,
    model: endpointOption?.model,
  });
  try {
    // ИСПРАВЛЕНО: Передаем timeoutMs в resolveSummarizerProviders
    const effectiveTimeout = timeoutMs || CONDENSE_TIMEOUT_MS;
    
    logger.info('rag.condense.config', buildContext(requestContext, {
      budgetChars,
      chunkChars,
      timeoutMs: effectiveTimeout,
      contextLength: contextText.length,
    }));
    
    const { chain: providerChain, warnings, signature: chainSignature } = resolveSummarizerProviders();
    warnings.forEach((message) =>
      logger.warn('rag.condense.config_warning', buildContext(requestContext, { warning: message })),
    );

    // ИСПРАВЛЕНО: Обновляем таймауты в дескрипторах провайдеров
    for (const descriptor of providerChain) {
      if (descriptor.options && typeof descriptor.options === 'object') {
        descriptor.options.timeout = effectiveTimeout;
      }
    }

    if (!providerChain.length) {
      logger.warn('rag.condense.config_error', buildContext(requestContext, {
        reason: 'empty_chain',
      }));
      return contextText;
    }

    if (providerChain.length === 1 && providerChain[0].provider === 'none') {
      logger.info('rag.condense.config', buildContext(requestContext, {
        mode: 'provider_none_passthrough',
      }));
      return contextText;
    }

    const chunks = splitIntoChunks(contextText, chunkChars, Math.floor(chunkChars * 1.25));
    const providerChainLabel = describeProviderChain(providerChain);
    logger.info(
      'rag.condense.map_start',
      buildContext(requestContext, {
        chunkTotal: chunks.length,
        budgetChars,
        chunkChars,
        timeoutMs: effectiveTimeout,
        providers: providerChainLabel,
      }),
    );

    const graphExtra = prepareGraphExtras(graphContext);
    if (DEBUG_CONDENSE && (graphExtra.hint || graphExtra.lines.length)) {
      logger.info(
        'rag.condense.graph_extras',
        buildContext(requestContext, {
          hintLength: graphExtra.hint ? graphExtra.hint.length : 0,
          lineCount: graphExtra.lines.length,
        }),
      );
    }

    const r = getRedisClient();
    const CONCURRENCY = condenseConfig.concurrency;
    const CACHE_TTL = condenseConfig.cacheTtlSeconds;

    const actualPLimit = await getPLimit();
    const limit = actualPLimit(CONCURRENCY);

    const summaries = await Promise.all(
      chunks.map((chunk, index) =>
        limit(async () => {
          const chunkNumber = index + 1;
          const chunkContext = buildContext(requestContext, {
            chunkIndex: chunkNumber,
            chunkTotal: chunks.length,
            chunkLength: chunk.length,
          });
          const prompt = `${mapPrompt(userQuery, graphExtra)}\n\n=== Текст чанка ===\n${chunk}`;
          const cacheKey = cacheKeyChunk(chainSignature, budgetChars, userQuery, chunk, graphExtra);

          logger.info('rag.condense.chunk_start', chunkContext);

          if (r && CACHE_TTL > 0) {
            try {
              const cached = await r.get(cacheKey);
              if (cached) {
                const cachedValue = JSON.parse(cached);
                const cachedSummary =
                  typeof cachedValue === 'string' ? cachedValue : cachedValue?.summary;
                if (cachedSummary) {
                  const cachedProvider =
                    typeof cachedValue === 'object' && cachedValue?.provider
                      ? cachedValue.provider
                      : 'cache';
                  logger.info(
                    'rag.condense.chunk_cache_hit',
                    buildContext(chunkContext, { provider: cachedProvider }),
                  );
                  return cachedSummary;
                }
              }
            } catch (cacheError) {
              logger.warn(
                'rag.condense.chunk_cache_error',
                buildContext(chunkContext, { error: cacheError?.message }),
              );
            }
          }

          const chunkStartTime = Date.now();
          const { text, providerLabel } = await summarizeWithChain({
            chain: providerChain,
            prompt,
            originalText: chunk,
            budgetChars,
            stage: `map:${chunkNumber}/${chunks.length}`,
            requestContext: chunkContext,
          });

          let summaryText = typeof text === 'string' ? text.trim() : '';
          let summaryProvider = providerLabel || 'unknown';

          if (!summaryText) {
            summaryText = localFallback(chunk, budgetChars);
            summaryProvider = 'local:truncate';
            logger.warn(
              'rag.condense.chunk_local_fallback',
              buildContext(chunkContext, {
                reason: 'empty_provider',
                fallbackLength: summaryText.length,
              }),
            );
          } else {
            logger.info(
              'rag.condense.chunk_done',
              buildContext(chunkContext, {
                provider: summaryProvider,
                length: summaryText.length,
                durationMs: Date.now() - chunkStartTime,
              }),
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
              logger.info(
                'rag.condense.chunk_cached',
                buildContext(chunkContext, { provider: summaryProvider }),
              );
            } catch (setError) {
              logger.warn(
                'rag.condense.chunk_cache_store_error',
                buildContext(chunkContext, { error: setError?.message }),
              );
            }
          }

          return summaryText;
        }),
      ),
    );

    const joined = summaries.filter(Boolean).join('\n\n---\n\n');
    logger.info(
      'rag.condense.map_done',
      buildContext(requestContext, {
        chunkTotal: summaries.length,
        joinedLength: joined.length,
        durationMs: Date.now() - t0,
      }),
    );

    if (!joined || joined.length <= budgetChars || summaries.length <= 1) {
      logger.info(
        'rag.condense.reduce_skipped',
        buildContext(requestContext, {
          joinedLength: joined.length,
          budgetChars,
          reason: !joined
            ? 'empty_joined'
            : joined.length <= budgetChars
              ? 'within_budget'
              : 'single_chunk',
        }),
      );
      logger.info(
        'rag.condense.mr_finished',
        buildContext(requestContext, {
          finalLength: joined.length,
          provider: 'map_only',
          durationMs: Date.now() - t0,
        }),
      );
      return joined || contextText;
    }

    logger.info(
      'rag.condense.reduce_start',
      buildContext(requestContext, {
        chunkTotal: summaries.length,
        joinedLength: joined.length,
        budgetChars,
      }),
    );

    const reduceCacheKey = cacheKeyReduce(chainSignature, budgetChars, userQuery, joined, graphExtra);
    if (r && CACHE_TTL > 0) {
      try {
        const cachedReduce = await r.get(reduceCacheKey);
        if (cachedReduce) {
          const cachedValue = JSON.parse(cachedReduce);
          const cachedSummary =
            typeof cachedValue === 'string' ? cachedValue : cachedValue?.summary;
          if (cachedSummary) {
            const cachedProvider =
              typeof cachedValue === 'object' && cachedValue?.provider
                ? cachedValue.provider
                : 'cache';
            logger.info(
              'rag.condense.reduce_cache_hit',
              buildContext(requestContext, { provider: cachedProvider }),
            );
            logger.info(
              'rag.condense.mr_finished',
              buildContext(requestContext, {
                finalLength: cachedSummary.length,
                provider: cachedProvider,
                durationMs: Date.now() - t0,
              }),
            );
            return cachedSummary;
          }
        }
      } catch (cacheError) {
        logger.warn(
          'rag.condense.reduce_cache_error',
          buildContext(requestContext, { error: cacheError?.message }),
        );
      }
    }

    const reducePromptText = `${reducePrompt(userQuery, budgetChars, graphExtra)}\n\n=== Частичные выжимки ===\n${joined}`;
    let { text: finalSummary, providerLabel: reduceProviderLabel } = await summarizeWithChain({
      chain: providerChain,
      prompt: reducePromptText,
      originalText: joined,
      budgetChars,
      stage: 'reduce:initial',
      requestContext,
    });

    let summaryText = typeof finalSummary === 'string' ? finalSummary.trim() : '';
    let summaryProvider = reduceProviderLabel || 'unknown';

    if (!summaryText) {
      summaryText = localFallback(joined, budgetChars);
      summaryProvider = 'local:truncate';
      logger.warn(
        'rag.condense.reduce_local_fallback',
        buildContext(requestContext, {
          stage: 'initial',
          reason: 'empty_provider',
          fallbackLength: summaryText.length,
        }),
      );
    } else {
      logger.info(
        'rag.condense.reduce_done',
        buildContext(requestContext, {
          stage: 'initial',
          provider: summaryProvider,
          length: summaryText.length,
        }),
      );
    }

    let guard = 0;
    while (summaryText && summaryText.length > budgetChars && guard < 2) {
      const guardPrompt = `Сожми ещё до ~${budgetChars} символов, сохранив ключевые факты и числа.\n\n=== Текст ===\n${summaryText}`;
      logger.warn(
        'rag.condense.reduce_guard_start',
        buildContext(requestContext, {
          attempt: guard + 1,
          length: summaryText.length,
        }),
      );
      const { text: guardText, providerLabel: guardProvider } = await summarizeWithChain({
        chain: providerChain,
        prompt: guardPrompt,
        originalText: summaryText,
        budgetChars,
        stage: `reduce:guard:${guard + 1}`,
        requestContext,
      });

      const candidate = typeof guardText === 'string' ? guardText.trim() : '';
      if (!candidate) {
        summaryText = localFallback(summaryText, budgetChars);
        summaryProvider = 'local:truncate';
        logger.warn(
          'rag.condense.reduce_guard_fallback',
          buildContext(requestContext, {
            attempt: guard + 1,
            fallbackLength: summaryText.length,
          }),
        );
        break;
      }

      summaryText = candidate;
      summaryProvider = guardProvider || summaryProvider;
      guard += 1;
      logger.info(
        'rag.condense.reduce_guard_done',
        buildContext(requestContext, {
          attempt: guard,
          provider: summaryProvider,
          length: summaryText.length,
        }),
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
        logger.info(
          'rag.condense.reduce_cached',
          buildContext(requestContext, { provider: summaryProvider }),
        );
      } catch (setError) {
        logger.warn(
          'rag.condense.reduce_cache_store_error',
          buildContext(requestContext, { error: setError?.message }),
        );
      }
    }

    logger.info(
      'rag.condense.mr_finished',
      buildContext(requestContext, {
        finalLength: summaryText.length,
        provider: summaryProvider,
        durationMs: Date.now() - t0,
      }),
    );
    return summaryText || joined || contextText;
  } catch (error) {
    logger.error(
      'rag.condense.error',
      buildContext(requestContext, {
        message: error?.message,
        stack: error?.stack,
      }),
    );
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
