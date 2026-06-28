import type { IAiLanguageModelUsage } from '@/types/ai';

const TOKENS_PER_MILLION = 1_000_000;

type TDeepSeekPricingTier = 'flash' | 'pro';

interface IDeepSeekPricingRates {
  readonly inputCacheHitPerMillionCny: number;
  readonly inputCacheMissPerMillionCny: number;
  readonly outputPerMillionCny: number;
}

export interface IDeepSeekUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
}

export interface IDeepSeekCostBreakdown {
  tier: TDeepSeekPricingTier;
  usage: IDeepSeekUsageBreakdown;
  cacheHitInputCostCny: number;
  cacheMissInputCostCny: number;
  inputCostCny: number;
  outputCostCny: number;
  totalCostCny: number;
}

/**
 * DeepSeek 计费表。单位：CNY / 百万 token。
 *
 * - 命中缓存（cache hit）走低价；未命中（cache miss）走高价。
 * - `output` 含 `deepseek-reasoner` 的 reasoning tokens，与 DeepSeek 实际计费方式一致。
 */
const DEEPSEEK_PRICING: Readonly<Record<TDeepSeekPricingTier, IDeepSeekPricingRates>> = {
  flash: {
    inputCacheHitPerMillionCny: 0.02,
    inputCacheMissPerMillionCny: 1,
    outputPerMillionCny: 2,
  },
  pro: {
    inputCacheHitPerMillionCny: 0.1,
    inputCacheMissPerMillionCny: 12,
    outputPerMillionCny: 24,
  },
} as const;

const cnyFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const sanitizeTokenValue = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
};

/**
 * Tier 匹配规则（按数组顺序匹配，先匹中先生效）。
 *
 * 把 pro 放在 flash 之前是有意为之：未来若出现 `deepseek-chat-pro` 这种
 * 同时含两个关键字的命名，pro 的更具体语义会胜出。
 *
 * 仍使用 includes 子串匹配，是为了兼容厂商常见的 snapshot/版本后缀
 * （如 `deepseek-chat-2025-09-30`、`deepseek-chat:cache` 等）。
 */
const TIER_MATCH_RULES: ReadonlyArray<{
  tier: TDeepSeekPricingTier;
  keywords: ReadonlyArray<string>;
}> = [
  { tier: 'pro', keywords: ['deepseek-v4-pro', 'deepseek-reasoner'] },
  { tier: 'flash', keywords: ['deepseek-v4-flash', 'deepseek-chat'] },
];

const resolveDeepSeekPricingTier = (
  modelId: string | undefined,
): TDeepSeekPricingTier | undefined => {
  if (!modelId) {
    return undefined;
  }
  const normalizedModelId = modelId.trim().toLowerCase();
  if (!normalizedModelId) {
    return undefined;
  }
  for (const rule of TIER_MATCH_RULES) {
    if (rule.keywords.some((keyword) => normalizedModelId.includes(keyword))) {
      return rule.tier;
    }
  }
  return undefined;
};

const getUsageBreakdown = (usage: IAiLanguageModelUsage | undefined): IDeepSeekUsageBreakdown => {
  const inputTokens = sanitizeTokenValue(usage?.inputTokens);
  const outputTokens = sanitizeTokenValue(usage?.outputTokens);

  const rawCacheHitInputTokens = sanitizeTokenValue(
    usage?.inputTokenDetails?.cacheReadTokens ?? usage.inputTokenDetails.cacheReadTokens,
  );
  // 防御性约束：cache hit 不能超过 input 总量。
  // 出现 hit > input 通常意味着 usage 上游不一致（mock / SDK 版本差异），
  // clamp 后才能保证 hit + miss === input 这条不变式。
  const cacheHitInputTokens = Math.min(rawCacheHitInputTokens, inputTokens);

  const noCacheInputTokens = sanitizeTokenValue(usage?.inputTokenDetails?.noCacheTokens);
  const cacheMissInputTokens =
    noCacheInputTokens > 0
      ? Math.min(noCacheInputTokens, Math.max(0, inputTokens - cacheHitInputTokens))
      : Math.max(0, inputTokens - cacheHitInputTokens);

  return {
    inputTokens,
    outputTokens,
    cacheHitInputTokens,
    cacheMissInputTokens,
  };
};

const getCostByTokens = (tokens: number, pricePerMillionCny: number): number =>
  (tokens / TOKENS_PER_MILLION) * pricePerMillionCny;

/**
 * 根据模型 ID 与 usage 计算 DeepSeek 调用成本（CNY）。
 *
 * - 若模型 ID 无法识别为 DeepSeek tier，返回 `undefined`；
 * - 否则返回完整 breakdown，含 cache hit / miss / output 分项与总价。
 *
 * 兼容 AI SDK 两种 cache 字段命名：
 *   - `usage.inputTokenDetails.cacheReadTokens` / `noCacheTokens`
 *   - `usage.cachedInputTokens`
 */
export const computeDeepSeekCostBreakdown = (
  modelId: string | undefined,
  usage: IAiLanguageModelUsage | undefined,
): IDeepSeekCostBreakdown | undefined => {
  const tier = resolveDeepSeekPricingTier(modelId);
  if (!tier) {
    return undefined;
  }

  const rates = DEEPSEEK_PRICING[tier];
  const usageBreakdown = getUsageBreakdown(usage);

  const cacheHitInputCostCny = getCostByTokens(
    usageBreakdown.cacheHitInputTokens,
    rates.inputCacheHitPerMillionCny,
  );
  const cacheMissInputCostCny = getCostByTokens(
    usageBreakdown.cacheMissInputTokens,
    rates.inputCacheMissPerMillionCny,
  );
  const inputCostCny = cacheHitInputCostCny + cacheMissInputCostCny;
  const outputCostCny = getCostByTokens(usageBreakdown.outputTokens, rates.outputPerMillionCny);

  return {
    tier,
    usage: usageBreakdown,
    cacheHitInputCostCny,
    cacheMissInputCostCny,
    inputCostCny,
    outputCostCny,
    totalCostCny: inputCostCny + outputCostCny,
  };
};

/**
 * 格式化为「X.XX 元」展示文本。
 * 非有限数 / 负数兜底为 `0.00 元`，避免 UI 上出现 `NaN 元` / `-X.XX 元`。
 */
export const formatCnyCost = (amountCny: number): string => {
  if (!Number.isFinite(amountCny) || amountCny < 0) {
    return `${cnyFormatter.format(0)} 元`;
  }
  return `${cnyFormatter.format(amountCny)} 元`;
};
