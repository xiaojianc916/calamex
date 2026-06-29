import { type ComputedRef, computed, ref } from 'vue';

import { parseAcpTerminalSnapshot } from '@/components/business/ai/thread/projection/from-acp-terminal';
import type { IAiThreadTerminalSnapshot } from '@/components/business/ai/thread/projection/tool-view';
import type { TJsonValue } from '@/types/ai/sidecar';

/* ============================================================================
 * ACP 终端注册表的前端闭环（ADR-20260617 · D7-⑥）。
 *
 * 职责：按 terminalId 维护 client 侧终端的最新快照（IAiThreadTerminalSnapshot），
 * 供 tool-view 的 toAiThreadToolView 经 resolveTerminal 依赖渲染终端内容块。
 *
 * 设计取舍（与 useAcpAvailableCommands / useAcpSessionConfigOptions 一致，不自创）：
 * - 纯状态化、可在 effectScope 内单测，与 .vue 解耦；
 * - 不在此自订阅 sidecar 流 / 不直接调 IPC：宿主（useAiAssistant）持有唯一事件源，
 *   在收到终端输出更新时调 applyTerminalSnapshot；terminal/release 时 removeTerminal；
 * - 不可变替换：每次更新换新 Map 触发响应；解析失败时 no-op（保留既有快照）。
 *
 * 注：ACP 终端由 client（宿主）自有并执行，输出非经 session/update 下发，故无对应
 * ui_event.rs 投影；宿主终端子系统（producer）留待后续 slice 接入。
 * ========================================================================== */

export interface IUseAcpTerminalsReturn {
  /** 全部终端快照（只读，按 terminalId 索引）。 */
  terminals: ComputedRef<ReadonlyMap<string, IAiThreadTerminalSnapshot>>;
  hasTerminals: ComputedRef<boolean>;
  /** 直接用作 toAiThreadToolView 的 resolveTerminal 依赖。 */
  resolveTerminal: (terminalId: string) => IAiThreadTerminalSnapshot | undefined;
  /** 消费终端输出更新：归一并按 id upsert；空 id / 解析失败则 no-op。 */
  applyTerminalSnapshot: (terminalId: string, rawOutput: TJsonValue) => void;
  /** 移除单个终端（如 terminal/release）。 */
  removeTerminal: (terminalId: string) => void;
  /** 清空全部（如切换 thread / 关闭会话）。 */
  reset: () => void;
}

export const useAcpTerminals = (): IUseAcpTerminalsReturn => {
  const registry = ref<ReadonlyMap<string, IAiThreadTerminalSnapshot>>(
    new Map<string, IAiThreadTerminalSnapshot>(),
  );

  const resolveTerminal = (terminalId: string): IAiThreadTerminalSnapshot | undefined =>
    registry.value.get(terminalId);

  const applyTerminalSnapshot = (terminalId: string, rawOutput: TJsonValue): void => {
    if (terminalId.length === 0) {
      return;
    }
    const snapshot = parseAcpTerminalSnapshot(rawOutput);
    if (snapshot === null) {
      return;
    }
    const next = new Map(registry.value);
    next.set(terminalId, snapshot);
    registry.value = next;
  };

  const removeTerminal = (terminalId: string): void => {
    if (!registry.value.has(terminalId)) {
      return;
    }
    const next = new Map(registry.value);
    next.delete(terminalId);
    registry.value = next;
  };

  const reset = (): void => {
    if (registry.value.size === 0) {
      return;
    }
    registry.value = new Map<string, IAiThreadTerminalSnapshot>();
  };

  return {
    terminals: computed(() => registry.value),
    hasTerminals: computed(() => registry.value.size > 0),
    resolveTerminal,
    applyTerminalSnapshot,
    removeTerminal,
    reset,
  };
};
