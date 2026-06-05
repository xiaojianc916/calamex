import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * 运行路由 store。
 *
 * 记录「当前运行归属于哪个终端会话」，使用每个终端自动生成的唯一会话编号
 * （如 'main-terminal' 或 'terminal-xxx-x'），而非终端的显示序号（终端 1 / 终端 2，
 * 序号会随开关变化）。运行管线据此把脚本派发、run-chunk 渲染、trackRun 都路由到
 * 「发起运行时选中的那个终端」。
 *
 * 注意：运行的生命周期信号仍是 editorStore.pendingTerminalRunId；本字段只回答
 * 「归属哪个会话」。即便此字段残留旧值，只要 pendingTerminalRunId 为空，跟踪即停止，
 * 因此不会造成行为泄漏。运行结束 / 复位时仍会主动清空。
 */
export const useTerminalRunRoutingStore = defineStore('terminal-run-routing', () => {
  const activeRunSessionId = ref<string | null>(null);

  const setActiveRunSessionId = (sessionId: string | null): void => {
    activeRunSessionId.value = sessionId;
  };

  return {
    activeRunSessionId,
    setActiveRunSessionId,
  };
});
