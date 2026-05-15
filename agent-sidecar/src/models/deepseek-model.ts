import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { PROVIDER_REGISTRY, type MastraModelConfig } from '@mastra/core/llm';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const DEEPSEEK_PROVIDER_NAME = 'deepseek' as const;

/** Fallback base URL when neither env nor PROVIDER_REGISTRY supplies one. */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

/**
 * Default model id when DEEPSEEK_MODEL is not set.
 *
 * DeepSeek V4 (released 2026-04-24) ships two model ids:
 * - `deepseek-v4-flash` — 284B / 13B active, 1M context, cost-efficient default.
 * - `deepseek-v4-pro`   — 1.6T / 49B active, top reasoning / agent workloads.
 *
 * The legacy `deepseek-chat` / `deepseek-reasoner` aliases are deprecated on
 * 2026-07-24 and are NOT supported here. They map to v4-flash non-thinking /
 * thinking mode respectively; use `deepseek-v4-flash` with the appropriate
 * `reasoning_effort` provider option instead.
 */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';

/** Public DeepSeek V4 model ids. */
export type TDeepSeekModelId =
  | 'deepseek-v4-flash'
  | 'deepseek-v4-pro'
  | (string & {}); // allow custom / future ids without losing autocomplete

export type TDeepSeekModelConfig = MastraModelConfig & {
  readonly modelId: TDeepSeekModelId;
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const readEnv = (
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  const value = env[key]?.trim();
  return value ? value : null;
};

const normalizeBaseUrl = (value: string): string =>
  value.trim().replace(/\/+$/u, '');

const assertValidUrl = (value: string, source: string): string => {
  try {
    new URL(value);
  } catch {
    throw new Error(`[deepseek-model] ${source} 不是合法的 URL: "${value}"`);
  }
  return value;
};

const readRegistryBaseUrl = (): string | null => {
  const entry = PROVIDER_REGISTRY[DEEPSEEK_PROVIDER_NAME] as
    | { url?: string }
    | undefined;
  const url = entry?.url?.trim();
  return url ? url : null;
};

// -----------------------------------------------------------------------------
// Pure constructor (test-friendly)
// -----------------------------------------------------------------------------

export interface ICreateDeepSeekModelOptions {
  apiKey: string;
  modelId?: TDeepSeekModelId | undefined;
  baseUrl?: string | undefined;
  /**
   * Override the fetch implementation. Defaults to the global `fetch`. Mainly
   * for tests / custom proxy.
   *
   * V4 is hybrid thinking/non-thinking and no longer needs a reasoning-aware
   * fetch wrapper — thinking is controlled by `reasoning_effort` at call
   * time, not by swapping the endpoint.
   */
  fetch?: typeof fetch | undefined;
}

/**
 * Build a Mastra-compatible DeepSeek model config from explicit options.
 *
 * Use this when you already have the API key in hand (e.g. tests, multi-tenant
 * paths). Prefer {@link createDeepSeekModelConfigFromEnv} for the standard
 * env-driven flow.
 */
export const createDeepSeekModelConfig = (
  options: ICreateDeepSeekModelOptions,
): TDeepSeekModelConfig => {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error('[deepseek-model] apiKey 不能为空。');
  }

  const modelId: TDeepSeekModelId = options.modelId ?? DEEPSEEK_DEFAULT_MODEL;
  const rawBaseUrl =
    options.baseUrl ?? readRegistryBaseUrl() ?? DEEPSEEK_DEFAULT_BASE_URL;
  const baseURL = assertValidUrl(
    normalizeBaseUrl(rawBaseUrl),
    'DEEPSEEK_BASE_URL',
  );

  const deepseek = createOpenAICompatible<TDeepSeekModelId, never, never, never>({
    name: DEEPSEEK_PROVIDER_NAME,
    baseURL,
    apiKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const chatModel = deepseek.chatModel(modelId);

  // Attach modelId so downstream consumers can inspect it without having to
  // parse it out of the SDK-specific object.
  return Object.assign(chatModel, { modelId }) as TDeepSeekModelConfig;
};

// -----------------------------------------------------------------------------
// Env adapter
// -----------------------------------------------------------------------------

/**
 * Build a DeepSeek model config from environment variables.
 *
 * Reads:
 * - `DEEPSEEK_API_KEY` (required; returns `null` when missing)
 * - `DEEPSEEK_BASE_URL` (optional; falls back to PROVIDER_REGISTRY then to
 *   {@link DEEPSEEK_DEFAULT_BASE_URL})
 * - `DEEPSEEK_MODEL` (optional; defaults to {@link DEEPSEEK_DEFAULT_MODEL})
 *
 * @returns config, or `null` when `DEEPSEEK_API_KEY` is not set.
 */
export const createDeepSeekModelConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): TDeepSeekModelConfig | null => {
  const apiKey = readEnv('DEEPSEEK_API_KEY', env);
  if (!apiKey) return null;

  return createDeepSeekModelConfig({
    apiKey,
    modelId: readEnv('DEEPSEEK_MODEL', env) ?? undefined,
    baseUrl: readEnv('DEEPSEEK_BASE_URL', env) ?? undefined,
  });
};