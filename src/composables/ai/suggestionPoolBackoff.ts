/**
 * 首页建议池后台生成的有界重试参数与退避算法。
 *
 * narrator 小模型生成依赖 agent-sidecar 子进程：应用刚启动时它可能仍在拉起，
 * 首次请求可能遇到冷启动超时或瞬时 provider 抖动。建议池加载若只跑一次且
 * 静默吞错，任何一次失败都会让首页永久回退到静态兜底池。这里集中定义带
 * 指数退避的有界重试参数，并以纯函数实现退避延迟，便于单测与复用。
 */

/** 后台生成的最大尝试次数（含首次）。 */
export const SUGGESTION_POOL_MAX_ATTEMPTS = 5;
/** 首个重试延迟（毫秒）。 */
export const SUGGESTION_POOL_RETRY_BASE_MS = 1_000;
/** 退避延迟上限（毫秒），避免无限增长。 */
export const SUGGESTION_POOL_RETRY_MAX_MS = 30_000;

/**
 * 指数退避延迟（毫秒）。`attempt` 从 0 开始：`baseMs * 2^attempt`，封顶 `maxMs`。
 * 纯函数、无副作用；对非法 `attempt`（负数 / 非有限值）退化为首个延迟。
 */
export const computeBackoffDelayMs = (
  attempt: number,
  baseMs: number = SUGGESTION_POOL_RETRY_BASE_MS,
  maxMs: number = SUGGESTION_POOL_RETRY_MAX_MS,
): number => {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(baseMs * 2 ** safeAttempt, maxMs);
};
