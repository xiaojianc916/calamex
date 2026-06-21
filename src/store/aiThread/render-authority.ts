/* ============================================================================
 * 渲染权威选择（ADR-0013 / ADR-0014 Step 8 砖3①）
 *
 * 纯函数、无副作用：在 entries 权威线程（authoritative）与既有 legacy 投影
 * （liveThread ?? 投影 ?? 持久化）之间选择渲染真源。
 *
 * 双轨拆除（Step 5）：写路径已全面接管 authoritative，故渲染权威恒等于
 * authoritative；legacy 投影回退链路在生产中恒为空、不再被消费，回退分支退役。
 * ========================================================================== */
import type { IAiThread } from '@/types/ai/thread';

/**
 * 渲染线程真源选择：恒以 entries 权威活动线程为准（含空 entries 的空线程）。
 * @param authoritative entries 权威活动线程（砖2b store）
 */
export function selectRenderThread(authoritative: IAiThread | null): IAiThread | null {
  return authoritative;
}
