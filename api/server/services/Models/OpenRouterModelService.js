'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getLogger } = require('~/utils/logger');
const { buildContext } = require('~/utils/logContext');

const DEFAULT_REFRESH_MS = 24 * 60 * 60 * 1000;

class OpenRouterModelService {
  constructor({ configService, httpClient = axios, logger = null } = {}) {
    this.configService = configService;
    this.httpClient = httpClient;
    this.logger = logger || getLogger('models.openrouter');

    const config = this.configService?.getSection?.('openrouterModels') || {};
    this.apiKey = config.apiKey || '';
    this.modelsUrl = config.modelsUrl || 'https://openrouter.ai/api/v1/models';
    this.cachePath = config.cachePath || './api/cache/openrouter_models.json';
    this.refreshIntervalMs = Math.max(Number(config.refreshIntervalMs) || DEFAULT_REFRESH_MS, 1000);

    this.fallbackMap = config.fallbackMap || {};
    this._cachedModelsMap = null;
    this._lastFetchAt = null;

    this.logger.info(
      'models.openrouter.init',
      buildContext({}, {
        cachePath: this.cachePath,
        refreshIntervalMs: this.refreshIntervalMs,
      }),
    );
  }

  async getModelsMap({ requestContext = {} } = {}) {
    if (this._cachedModelsMap && this._lastFetchAt) {
      const ageMs = Date.now() - this._lastFetchAt;
      if (ageMs < this.refreshIntervalMs) {
        this.logger.debug('models.openrouter.cache_hit', buildContext(requestContext));
        return this._cachedModelsMap;
      }
    }

    const headers = { Accept: 'application/json' };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const previousData = this._readCacheRaw();
    const previousIds = new Set(
      Array.isArray(previousData)
        ? previousData.map((item) => item?.id).filter(Boolean)
        : [],
    );

    try {
      const response = await this.httpClient.get(this.modelsUrl, {
        headers,
        timeout: 10_000,
      });
      const payload = response?.data || {};
      const modelsData = Array.isArray(payload.data) ? payload.data : [];
      const modelsMap = this._processModels(modelsData);

      this._logDiff(previousIds, new Set(Object.keys(modelsMap)), requestContext);
      this._saveCache(modelsData, requestContext);

      this._cachedModelsMap = modelsMap;
      this._lastFetchAt = Date.now();

      this.logger.info(
        'models.openrouter.fetch_success',
        buildContext(requestContext, { count: Object.keys(modelsMap).length }),
      );
      return modelsMap;
    } catch (error) {
      this.logger.error(
        'models.openrouter.fetch_failed',
        buildContext(requestContext, {
          err: { message: error?.message, stack: error?.stack },
        }),
      );

      if (this._cachedModelsMap) {
        return this._cachedModelsMap;
      }

      const cached = this._loadFromCache(requestContext);
      if (cached) {
        this._cachedModelsMap = cached;
        return cached;
      }

      this.logger.warn(
        'models.openrouter.fallback_used',
        buildContext(requestContext, { count: Object.keys(this.fallbackMap || {}).length }),
      );
      return { ...this.fallbackMap };
    }
  }

  _processModels(modelsData = []) {
    const normalized = {};
    const sorted = [...modelsData].sort((a, b) => `${a?.id || ''}`.localeCompare(`${b?.id || ''}`));
    sorted.forEach((model) => {
      const modelId = model?.id;
      if (!modelId) return;

      const name = model?.name || modelId;
      const provider = modelId.includes('/') ? modelId.split('/', 1)[0] : 'other';
      const maxContextTokens = Number(model?.context_length || model?.contextLength || model?.max_context_length);
      const pricing = model?.pricing || {};
      const modalities = Array.isArray(model?.modality) ? model?.modality : model?.modalities;

      normalized[modelId] = {
        id: modelId,
        name,
        provider,
        maxContextTokens: Number.isFinite(maxContextTokens) ? maxContextTokens : null,
        pricing: {
          promptUsdPer1k: this._normalizeRate(pricing?.prompt),
          completionUsdPer1k: this._normalizeRate(pricing?.completion),
          inputUsdPer1k: this._normalizeRate(pricing?.input),
          outputUsdPer1k: this._normalizeRate(pricing?.output),
        },
        modalities: Array.isArray(modalities) ? modalities : undefined,
        isDeprecated: Boolean(model?.deprecated),
        label: `[${provider}] ${name}`,
      };
    });

    return normalized;
  }

  _normalizeRate(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  _loadFromCache(requestContext) {
    if (!fs.existsSync(this.cachePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      const modelsMap = this._processModels(parsed);
      this.logger.info(
        'models.openrouter.cache_loaded',
        buildContext(requestContext, { count: Object.keys(modelsMap).length }),
      );
      return modelsMap;
    } catch (error) {
      this.logger.error(
        'models.openrouter.cache_load_failed',
        buildContext(requestContext, { err: { message: error?.message, stack: error?.stack } }),
      );
      return null;
    }
  }

  _saveCache(modelsData, requestContext) {
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.cachePath, JSON.stringify(modelsData, null, 2), 'utf8');
      this.logger.info(
        'models.openrouter.cache_saved',
        buildContext(requestContext, { cachePath: this.cachePath }),
      );
    } catch (error) {
      this.logger.error(
        'models.openrouter.cache_save_failed',
        buildContext(requestContext, { err: { message: error?.message, stack: error?.stack } }),
      );
    }
  }

  _readCacheRaw() {
    if (!fs.existsSync(this.cachePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(this.cachePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  _logDiff(previousIds, currentIds, requestContext) {
    const prev = new Set(previousIds || []);
    const curr = new Set(currentIds || []);
    const added = [...curr].filter((id) => !prev.has(id));
    const removed = [...prev].filter((id) => !curr.has(id));

    if (!added.length && !removed.length) {
      return;
    }

    this.logger.info(
      'models.openrouter.diff',
      buildContext(requestContext, {
        added: added.join(','),
        removed: removed.join(','),
      }),
    );
  }
}

module.exports = OpenRouterModelService;
