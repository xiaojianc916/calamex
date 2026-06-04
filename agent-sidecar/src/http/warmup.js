import { performance } from 'node:perf_hooks';
import { getProviderConfig } from '@mastra/core/llm';
import { z } from 'zod';
const WARMUP_TIMEOUT_MS = 5_000;
const RECENT_WARMUP_TTL_MS = 60_000;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
const PROVIDER_BASE_URLS = {
    openai: DEFAULT_OPENAI_BASE_URL,
    anthropic: DEFAULT_ANTHROPIC_BASE_URL,
    deepseek: DEFAULT_DEEPSEEK_BASE_URL,
};
const PROVIDER_MODEL_LIST_PATHS = {
    openai: '/models',
    anthropic: '/models',
    deepseek: '/models',
};
const requestScopedModelConfigSchema = z.object({
    modelId: z.string().trim().min(1),
    apiKey: z.string().trim().min(1),
    baseUrl: z.string().trim().min(1).optional(),
});
const warmupRequestSchema = z.object({
    modelConfig: requestScopedModelConfigSchema.optional(),
});
const lastWarmupByKey = new Map();
const trimTrailingSlash = (value) => value.trim().replace(/\/+$/u, '');
const parseProviderId = (modelId) => {
    const providerId = modelId.split('/', 1)[0]?.trim();
    return providerId ? providerId : null;
};
const resolveProviderBaseUrl = (providerId, explicitBaseUrl) => {
    const baseUrl = explicitBaseUrl?.trim() ||
        getProviderConfig(providerId)?.url?.trim() ||
        PROVIDER_BASE_URLS[providerId];
    if (!baseUrl) {
        return null;
    }
    try {
        return trimTrailingSlash(new URL(baseUrl).toString());
    }
    catch {
        return null;
    }
};
const buildWarmupUrl = (providerId, baseUrl) => `${baseUrl}${PROVIDER_MODEL_LIST_PATHS[providerId] ?? '/models'}`;
const buildWarmupHeaders = (providerId, apiKey) => {
    if (providerId === 'anthropic') {
        return {
            'anthropic-version': '2023-06-01',
            'x-api-key': apiKey,
        };
    }
    return {
        Authorization: `Bearer ${apiKey}`,
    };
};
const markRecentWarmup = (key) => {
    lastWarmupByKey.set(key, Date.now());
};
const isRecentlyWarmed = (key) => {
    const warmedAt = lastWarmupByKey.get(key);
    return warmedAt !== undefined && Date.now() - warmedAt < RECENT_WARMUP_TTL_MS;
};
export const warmupLlmConnection = async (input) => {
    const startedAt = performance.now();
    const payload = warmupRequestSchema.parse(input);
    const modelConfig = payload.modelConfig;
    if (!modelConfig) {
        return {
            ok: true,
            providerId: null,
            origin: null,
            statusCode: null,
            durationMs: Math.round(performance.now() - startedAt),
            skipped: true,
            reason: 'missing_model_config',
        };
    }
    const providerId = parseProviderId(modelConfig.modelId);
    if (!providerId) {
        return {
            ok: false,
            providerId: null,
            origin: null,
            statusCode: null,
            durationMs: Math.round(performance.now() - startedAt),
            skipped: true,
            reason: 'invalid_model_id',
        };
    }
    const baseUrl = resolveProviderBaseUrl(providerId, modelConfig.baseUrl);
    if (!baseUrl) {
        return {
            ok: false,
            providerId,
            origin: null,
            statusCode: null,
            durationMs: Math.round(performance.now() - startedAt),
            skipped: true,
            reason: 'missing_provider_base_url',
        };
    }
    const origin = new URL(baseUrl).origin;
    const warmupKey = `${providerId}:${origin}`;
    if (isRecentlyWarmed(warmupKey)) {
        return {
            ok: true,
            providerId,
            origin,
            statusCode: null,
            durationMs: Math.round(performance.now() - startedAt),
            skipped: true,
            reason: 'recently_warmed',
        };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);
    try {
        const response = await fetch(buildWarmupUrl(providerId, baseUrl), {
            method: 'GET',
            headers: buildWarmupHeaders(providerId, modelConfig.apiKey),
            signal: controller.signal,
        });
        await response.arrayBuffer();
        markRecentWarmup(warmupKey);
        return {
            ok: response.ok,
            providerId,
            origin,
            statusCode: response.status,
            durationMs: Math.round(performance.now() - startedAt),
            skipped: false,
        };
    }
    catch (error) {
        return {
            ok: false,
            providerId,
            origin,
            statusCode: null,
            durationMs: Math.round(performance.now() - startedAt),
            skipped: false,
            reason: error instanceof Error ? error.name : 'warmup_failed',
        };
    }
    finally {
        clearTimeout(timeout);
    }
};
export const logWarmupResult = (trigger, result) => {
    const payload = {
        level: result.ok ? 'info' : 'warn',
        scope: 'agent-sidecar',
        event: 'llm.connection.warmup',
        trigger,
        providerId: result.providerId,
        origin: result.origin,
        statusCode: result.statusCode,
        durationMs: result.durationMs,
        skipped: result.skipped,
        reason: result.reason,
    };
    const serialized = JSON.stringify(payload);
    if (result.ok) {
        console.info(serialized);
        return;
    }
    console.warn(serialized);
};
export const scheduleBackgroundWarmup = (input, trigger) => {
    setTimeout(() => {
        void warmupLlmConnection(input)
            .then((result) => logWarmupResult(trigger, result))
            .catch((error) => {
            console.warn(JSON.stringify({
                level: 'warn',
                scope: 'agent-sidecar',
                event: 'llm.connection.warmup',
                trigger,
                providerId: null,
                origin: null,
                statusCode: null,
                durationMs: 0,
                skipped: true,
                reason: error instanceof Error ? error.message : String(error),
            }));
        });
    }, 0);
};
