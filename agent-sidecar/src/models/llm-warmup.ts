/**
 * LLM 连接预热（warmup）——中立模块，与传输层无关。
 *
 * 事实上预热只是向 provider 的 `/models` 发一次轻量 GET，预建 DNS/TLS/HTTP 连接以
 * 缩短首个 prompt 的首字延迟；与 HTTP 服务器本身无关，以往仅因历史原因置于 http/。
 * 现迁入 models/（与模型配置、能力解析同位），使其：
 * - 在 http/ 整体删除后仍然成立；
 * - 可被 ACP stdio 启动入口复用（启动即后台预热）。
 *
 * 日志：一律写 stderr。原实现成功时用 console.info（→stdout），这在 ACP 下会污染
 * stdout 的 JSON-RPC 协议线路；改写 stderr 对旧 HTTP 服务器无害、对 ACP 是必须。
 */
import { performance } from 'node:perf_hooks';
import { getProviderConfig } from '@mastra/core/llm';
import { z } from 'zod/v3';

const WARMUP_TIMEOUT_MS = 5_000;
const RECENT_WARMUP_TTL_MS = 60_000;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

const PROVIDER_BASE_URLS: Readonly<Record<string, string>> = {
  openai: DEFAULT_OPENAI_BASE_URL,
  anthropic: DEFAULT_ANTHROPIC_BASE_URL,
  deepseek: DEFAULT_DEEPSEEK_BASE_URL,
};

const PROVIDER_MODEL_LIST_PATHS: Readonly<Record<string, string>> = {
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

export interface IWarmupResult {
  ok: boolean;
  providerId: string | null;
  origin: string | null;
  statusCode: number | null;
  durationMs: number;
  skipped: boolean;
  reason?: string;
}

type TWarmupOptions = {
  signal?: AbortSignal;
};

const lastWarmupByKey = new Map<string, number>();
const backgroundWarmupTimers = new Map<number, ReturnType<typeof setTimeout>>();
const backgroundWarmupControllers = new Set<AbortController>();
let nextBackgroundWarmupId = 0;

const trimTrailingSlash = (value: string): string => value.trim().replace(/\/+$/u, '');

const parseProviderId = (modelId: string): string | null => {
  const providerId = modelId.split('/', 1)[0]?.trim();
  return providerId ? providerId : null;
};

const resolveProviderBaseUrl = (
  providerId: string,
  explicitBaseUrl: string | undefined,
): string | null => {
  const baseUrl =
    explicitBaseUrl?.trim() ||
    getProviderConfig(providerId)?.url?.trim() ||
    PROVIDER_BASE_URLS[providerId];

  if (!baseUrl) {
    return null;
  }

  try {
    return trimTrailingSlash(new URL(baseUrl).toString());
  } catch {
    return null;
  }
};

const buildWarmupUrl = (providerId: string, baseUrl: string): string =>
  `${baseUrl}${PROVIDER_MODEL_LIST_PATHS[providerId] ?? '/models'}`;

const buildWarmupHeaders = (
  providerId: string,
  apiKey: string,
): Record<string, string> => {
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

const markRecentWarmup = (key: string): void => {
  lastWarmupByKey.set(key, Date.now());
};

const isRecentlyWarmed = (key: string): boolean => {
  const warmedAt = lastWarmupByKey.get(key);
  return warmedAt !== undefined && Date.now() - warmedAt < RECENT_WARMUP_TTL_MS;
};

/** 结构化预热日志 → stderr（绝不写 stdout，ACP 下那是协议线路）。 */
const writeWarmupLog = (payload: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
};

export const warmupLlmConnection = async (
  input: unknown,
  options: TWarmupOptions = {},
): Promise<IWarmupResult> => {
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
  const abortWarmup = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    abortWarmup();
  } else {
    options.signal?.addEventListener('abort', abortWarmup, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);
  timeout.unref?.();

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
  } catch (error) {
    return {
      ok: false,
      providerId,
      origin,
      statusCode: null,
      durationMs: Math.round(performance.now() - startedAt),
      skipped: false,
      reason: error instanceof Error ? error.name : 'warmup_failed',
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortWarmup);
  }
};

export const logWarmupResult = (trigger: string, result: IWarmupResult): void => {
  writeWarmupLog({
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
  });
};

export const disposeWarmupScheduler = (): void => {
  for (const timer of backgroundWarmupTimers.values()) {
    clearTimeout(timer);
  }
  backgroundWarmupTimers.clear();

  for (const controller of backgroundWarmupControllers) {
    controller.abort();
  }
  backgroundWarmupControllers.clear();
};

export const scheduleBackgroundWarmup = (input: unknown, trigger: string): void => {
  const warmupId = nextBackgroundWarmupId;
  nextBackgroundWarmupId += 1;

  const timer = setTimeout(() => {
    backgroundWarmupTimers.delete(warmupId);

    const controller = new AbortController();
    backgroundWarmupControllers.add(controller);

    void warmupLlmConnection(input, { signal: controller.signal })
      .then((result) => logWarmupResult(trigger, result))
      .catch((error) => {
        writeWarmupLog({
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
        });
      })
      .finally(() => {
        backgroundWarmupControllers.delete(controller);
      });
  }, 0);
  timer.unref?.();
  backgroundWarmupTimers.set(warmupId, timer);
};
