/* ============================================================================
 * Patch 摘要 → reduce 规范化事件映射器（ADR-0014，纯函数）
 *
 * 与 from-sidecar-events 互补：边车流式遥测帧（文本 / 思维链 / 工具）缺乏持久 diff
 * 引用，无法无损构造改动汇总；改动汇总的单一真源是 aiAgent patch 流水线产出的
 * IAiAgentPatchSummary（自带 diffRef / patchRef / runId / stepId，可应用 / 撤销）。
 * 本映射器把该摘要直通为一条 changed_files reduce 事件，按 summary.id upsert：首次
 * 出现追加，撤销 / 重新应用重放同 id 时更新（reduce 保留首次 createdAt 稳定位置）。
 *
 * 纯函数：不订阅、不持状态、不接线，可独立单测；订阅 patch 摘要并喂入 reduce 的接线
 * 另起一刀。每工具内联 diff（tool_call 的 diff 内容）是独立关注点，不在此处构造。
 * ========================================================================== */
import type { TAiThreadReduceEvent } from '@/store/aiThread/events';
import type { IAiAgentPatchSummary } from '@/types/ai/patch';

export interface IPatchSummaryToReduceOptions {
  /** 摘要无 appliedAt（尚未记录应用时刻）时回退使用的 createdAt（ISO）。 */
  now: string;
}

/**
 * Patch 摘要 → 一条 changed_files reduce 规范化事件。摘要直通至 changed_files.summary
 * （同型，无损）；createdAt 优先取 summary.appliedAt（首次应用时刻），否则用 options.now。
 * 纯函数，不修改入参、无副作用。
 */
export const patchSummaryToReduceEvents = (
  summary: IAiAgentPatchSummary,
  options: IPatchSummaryToReduceOptions,
): TAiThreadReduceEvent[] => [
  {
    kind: 'changed_files',
    id: summary.id,
    createdAt: summary.appliedAt ?? options.now,
    summary,
  },
];
