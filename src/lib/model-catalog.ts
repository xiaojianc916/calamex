/**
 * Model catalog adapter — anti-corruption layer over `tokenlens` (models.dev).
 *
 * Why this exists:
 * - Model facts (context window, max output, pricing) change constantly as
 *   providers ship new models. Hand-maintaining them drifts and goes stale
 *   (the project previously kept two separate hardcoded tables that already
 *   disagreed with each other).
 * - We delegate those facts to the maintained models.dev dataset via the
 *   `tokenlens` library. Callers depend ONLY on the stable {@link IModelFacts}
 *   shape declared here, never on tokenlens internals.
 *
 * Robustness contract (important):
 * - `tokenlens` is imported as a namespace and every helper is resolved
 *   defensively. If an upstream export is renamed/removed, or a returned field
 *   shape changes, these functions return `undefined` instead of throwing or
 *   breaking the build. Callers (e.g. `findModelContextWindow`) then fall back
 *   to their hand-written seed values — i.e. today's behaviour. This makes the
 *   integration a zero-regression enrichment rather than a hard dependency.
 * - Lookups are synchronous and offline by default (tokenlens ships a static
 *   registry). {@link refreshModelCatalogFromRemote} optionally pulls fresh
 *   data from models.dev and is safe to call fire-and-forget at startup.
 *
 * Pricing units: USD per 1,000,000 tokens. Catalog pricing is an ESTIMATE; for
 * authoritative billing use the usage/cost the provider reports at runtime.
 */
import * as tokenlens from 'tokenlens';

/** Stable, app-owned view of model facts. Decoupled from tokenlens internals. */
export interface IModelFacts {
  /** Maximum context window in tokens, if known. */
  contextWindow?: number;
  /** Maximum output tokens, if known. */
  maxOutputTokens?: number;
  /** Estimated price in USD per 1M input tokens, if known. */
  inputUsdPerMillion?: number;
  /** Estimated price in USD per 1M output tokens, if known. */
  outputUsdPerMillion?: number;
  /** `catalog` when at least one fact was resolved, otherwise `unknown`. */
  source: 'catalog' | 'unknown';
}

type ProvidersRegistry = unknown;

/**
 * Minimal structural view of the subset of `tokenlens` we rely on. We keep it
 * loose on purpose: every member is optional so a version mismatch is handled
 * at runtime via `typeof` guards rather than at the import boundary.
 */
interface TokenlensLike {
  getModels?: () => ProvidersRegistry;
  fetchModels?: (arg?: unknown) => Promise<ProvidersRegistry>;
  getContext?: (modelId: string, providers?: ProvidersRegistry) => unknown;
  getTokenCosts?: (
    modelId: string,
    usage: unknown,
    providers?: ProvidersRegistry,
  ) => unknown;
}

const tl = tokenlens as unknown as TokenlensLike;

let staticProviders: ProvidersRegistry | undefined;
let staticProvidersResolved = false;
let remoteProviders: ProvidersRegistry | undefined;

function getStaticProviders(): ProvidersRegistry | undefined {
  if (!staticProvidersResolved) {
    staticProvidersResolved = true;
    try {
      staticProviders = tl.getModels?.();
    } catch {
      staticProviders = undefined;
    }
  }
  return staticProviders;
}

/** Remote (freshly fetched) catalog takes precedence over the bundled one. */
function activeProviders(): ProvidersRegistry | undefined {
  return remoteProviders ?? getStaticProviders();
}

function firstPositiveNumber(...candidates: unknown[]): number | undefined {
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function getContextCaps(modelId: string): Record<string, unknown> | undefined {
  if (!modelId || typeof tl.getContext !== 'function') {
    return undefined;
  }
  try {
    const caps = tl.getContext(modelId, activeProviders());
    return caps && typeof caps === 'object'
      ? (caps as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a model's context window (tokens) from the catalog, or `undefined`
 * when unknown/unavailable. Prefers a total/combined cap, then input cap.
 * Field-name candidates cover known tokenlens variants defensively.
 */
export function getModelContextWindow(modelId: string): number | undefined {
  const caps = getContextCaps(modelId.trim());
  if (!caps) {
    return undefined;
  }
  return firstPositiveNumber(
    caps.totalMax,
    caps.maxTotal,
    caps.combinedMax,
    caps.inputMax,
    caps.maxInput,
  );
}

/** Resolve a model's max output tokens from the catalog, or `undefined`. */
export function getModelMaxOutputTokens(modelId: string): number | undefined {
  const caps = getContextCaps(modelId.trim());
  if (!caps) {
    return undefined;
  }
  return firstPositiveNumber(caps.outputMax, caps.maxOutput);
}

/**
 * Estimate unit price (USD per 1M tokens) by asking tokenlens for the cost of a
 * 1M-token usage. This avoids depending on tokenlens' raw pricing field names.
 */
function estimateUsdPerMillion(
  modelId: string,
  kind: 'input' | 'output',
): number | undefined {
  if (!modelId || typeof tl.getTokenCosts !== 'function') {
    return undefined;
  }
  const usage =
    kind === 'input'
      ? { prompt_tokens: 1_000_000, completion_tokens: 0 }
      : { prompt_tokens: 0, completion_tokens: 1_000_000 };
  try {
    const costs = tl.getTokenCosts(modelId, usage, activeProviders());
    if (!costs || typeof costs !== 'object') {
      return undefined;
    }
    const record = costs as Record<string, unknown>;
    return firstPositiveNumber(
      kind === 'input' ? record.inputUSD : record.outputUSD,
    );
  } catch {
    return undefined;
  }
}

/** Resolve the full set of known facts for a model id. */
export function getModelFacts(modelId: string): IModelFacts {
  const id = modelId.trim();
  const caps = getContextCaps(id);
  const contextWindow = caps
    ? firstPositiveNumber(
        caps.totalMax,
        caps.maxTotal,
        caps.combinedMax,
        caps.inputMax,
        caps.maxInput,
      )
    : undefined;
  const maxOutputTokens = caps
    ? firstPositiveNumber(caps.outputMax, caps.maxOutput)
    : undefined;
  const inputUsdPerMillion = estimateUsdPerMillion(id, 'input');
  const outputUsdPerMillion = estimateUsdPerMillion(id, 'output');
  const known =
    contextWindow !== undefined ||
    maxOutputTokens !== undefined ||
    inputUsdPerMillion !== undefined ||
    outputUsdPerMillion !== undefined;
  return {
    contextWindow,
    maxOutputTokens,
    inputUsdPerMillion,
    outputUsdPerMillion,
    source: known ? 'catalog' : 'unknown',
  };
}

/**
 * Optionally refresh the catalog from models.dev (network). Safe to call
 * fire-and-forget at startup: on any failure (offline/parse) it silently keeps
 * using the bundled static registry. Returns whether a refresh succeeded.
 */
export async function refreshModelCatalogFromRemote(): Promise<boolean> {
  if (typeof tl.fetchModels !== 'function') {
    return false;
  }
  try {
    const fetched = await tl.fetchModels();
    if (fetched) {
      remoteProviders = fetched;
      return true;
    }
  } catch {
    // offline / network / parse error — keep using the bundled static registry.
  }
  return false;
}
