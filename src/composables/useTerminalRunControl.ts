import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { tauriService } from '@/services/tauri';
import { getTerminalRunOrchestrator } from '@/services/terminal/runOrchestrator';
import { useEditorStore } from '@/store/editor';
import { useTerminalRunRoutingStore } from '@/store/terminalRunRouting';

/**
 * 运行控制：提供「停止 / 重置运行」能力。
 *
 * 背景：`editorStore.isRunning` 是运行管线的串行闸门，`runScript` 会在它为
 * true 时直接以「已有脚本正在运行，请等待完成或先停止当前运行。」拦截新的运行。
 * 正常情况下它会在运行结束（run-completed / interactive-exited）时复位；但当
 * 完成事件丢失时——例如终端会话被回收 / 重连、运行被外部杀死、应用在运行中被
 * 重载——`isRunning` 会一直停留在 true。此时两个终端其实都处于空闲状态，用户
 * 却无法再次运行，也没有任何手段自行恢复。
 *
 * `stopRun` 负责打破这种卡死：
 *  1. 若存在当前 runId，则尽力请求后端优雅取消（后端找不到该运行属于预期内的
 *     情况，忽略其错误）。
 *  2. 无论后端取消是否成功，都强制复位前端运行态（包括运行归属会话），重新打开运行闸门。
 *  3. 同步通知应用级运行编排器忘记当前 run，避免迟到的 completed 事件又把已停止
 *     的运行写回历史。
 */
export const useTerminalRunControl = () => {
  const editorStore = useEditorStore();
  const runRoutingStore = useTerminalRunRoutingStore();
  const { isRunning } = storeToRefs(editorStore);

  const canStopRun = computed(() => isRunning.value);

  /** 仅复位运行相关状态，不触碰文档、日志、终端输出与工作区。 */
  const forceResetRunState = (): void => {
    getTerminalRunOrchestrator().resetActiveRunLifecycle();
    editorStore.isRunning = false;
    editorStore.setPendingTerminalRunId(null);
    editorStore.setActiveRunSummary(null);
    runRoutingStore.setActiveRunSessionId(null);
  };

  const stopRun = async (): Promise<void> => {
    const runId = editorStore.currentRunId;
    if (runId) {
      try {
        await tauriService.cancelTerminalRun({ runId, mode: 'graceful' });
      } catch {
        // 运行可能已结束或完成事件已丢失，后端会找不到该运行；这属于预期内的
        // 情况，记录一条信息日志后继续强制复位，保证运行闸门能够被重新打开。
        editorStore.appendLog(
          'info',
          '停止运行',
          '后端未找到对应运行（可能已结束或完成事件丢失），已直接复位运行状态。',
          { scope: 'run', runId },
        );
      }
    }
    forceResetRunState();
  };

  return {
    isRunning,
    canStopRun,
    stopRun,
    forceResetRunState,
  };
};