/* ============================================================================
 * 渲染权威选择（ADR-0013 / ADR-0014 Step 8 砖3①）
 *
 * 纯函数、无副作用：在 entries 权威线程（authoritative）与既有 legacy 投影
 * （liveThread ?? 投影 ?? 持久化）之间选择渲染真源。
 *
 * 切换语义（strangler）：authoritative 持有 entries 时以其为准，否则回退 legacy。
 * 写路径接管（砖3②起）前 authoritative 恒为空线程 → 始终回退 legacy → 逐线程
 * 零行为变化；写路径接管后 authoritative 自然胜出，无需二次改读侧。
 * ========================================================================== */
import type { IAiThread } from '@/types/ai/thread';

/**
 * 渲染线程真源选择：authoritative 含 entries 时优先，否则回退 fallback。
 * @param authoritative entries 权威活动线程（砖2b store）
 * @param fallback 既有渲染链路（liveThread ?? 投影 ?? 持久化）
 */
export function selectRenderThread(
  authoritative: IAiThread | null,
  fallback: IAiThread | null,
): IAiThread | null {
  return authoritative && authoritative.entries.length > 0 ? authoritative : fallback;
}
