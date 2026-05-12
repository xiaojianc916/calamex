<template>
  <section class="run-panel-shell">
    <header class="run-panel-toolbar">
      <div class="run-panel-tab-list" role="tablist" aria-label="终端面板视图">
        <button
          v-for="item in tabs"
          :key="item.value"
          type="button"
          class="run-panel-tab"
          :class="{ 'is-active': activeTab === item.value }"
          :aria-selected="activeTab === item.value"
          @click="activeTab = item.value"
        >
          <span class="run-panel-tab-label">{{ item.label }}</span>
        </button>
      </div>

      <div class="run-panel-toolbar-spacer" />

      <div class="run-panel-actions">
        <button
          type="button"
          class="icon-button app-tooltip-target run-panel-action-button"
          data-tooltip="重连终端"
          data-tooltip-placement="top"
          aria-label="重连终端"
          @click="void handleRestartTerminal()"
        >
          <RefreshCcw aria-hidden="true" />
        </button>

        <button
          type="button"
          class="icon-button app-tooltip-target run-panel-action-button"
          data-tooltip="清屏"
          data-tooltip-placement="top"
          aria-label="清屏"
          :disabled="!isTerminalReady"
          @click="void handleClearTerminal()"
        >
          <Eraser aria-hidden="true" />
        </button>

        <button
          type="button"
          class="icon-button app-tooltip-target run-panel-action-button"
          :data-tooltip="props.isMaximized ? '还原终端高度' : '最大化终端'"
          data-tooltip-placement="top"
          :aria-label="props.isMaximized ? '还原终端高度' : '最大化终端'"
          :aria-pressed="props.isMaximized"
          @click="$emit('toggle-maximize')"
        >
          <Maximize2 v-if="!props.isMaximized" aria-hidden="true" />
          <Minimize2 v-else aria-hidden="true" />
        </button>

        <button
          type="button"
          class="icon-button app-tooltip-target run-panel-action-button"
          data-tooltip="关闭终端面板"
          data-tooltip-placement="top"
          aria-label="关闭终端面板"
          @click="$emit('hide')"
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </header>

    <div class="run-panel-body">
      <div v-show="activeTab === 'terminal'" class="run-panel-view is-terminal">
        <EmbeddedTerminal
          :visible="props.visible && activeTab === 'terminal'"
          :theme="props.theme"
          :terminal-settings="props.terminalSettings"
          @status-change="handleTerminalStatusChange"
          @run-chunk="$emit('terminal-run-chunk', $event)"
          @run-completed="$emit('terminal-run-completed', $event)"
        />
      </div>

      <div v-show="activeTab === 'logs'" class="run-panel-view is-logs">
        <StructuredRunInsights
          :active="activeTab === 'logs'"
          :terminal-output-length="props.terminalOutputLength"
          :terminal-output-version="props.terminalOutputVersion"
          :resolve-terminal-output="props.resolveTerminalOutput"
          :run-logs="props.runLogs"
          :last-run-result="props.lastRunResult"
          :is-running="props.isRunning"
          :executor="props.executor"
          :document-name="props.documentName"
          :document-path="props.documentPath"
          :workspace-root-path="props.workspaceRootPath"
          :is-terminal-ready="isTerminalReady"
          @clear="void handleClearLogs()"
          @submit-command="void handleSubmitCommand($event)"
        />
      </div>

      <div v-if="activeTab === 'flow'" class="run-panel-view is-flow">
        <TerminalFlowPanel
          :terminal-status="terminalStatus"
          :is-running="props.isRunning"
          :terminal-output-length="props.terminalOutputLength"
          :terminal-output-version="props.terminalOutputVersion"
        />
      </div>

      <div v-show="activeTab === 'shellcheck'" class="run-panel-view is-shellcheck">
        <DiagnosticsPanel
          :analysis="props.scriptAnalysis"
          :content="props.documentContent"
          :document-name="props.documentName"
          @select-diagnostic="handleSelectDiagnostic"
          @rerun-analysis="emit('rerun-analysis')"
          @ai-fix-diagnostic="emit('ai-fix-diagnostic', $event)"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import DiagnosticsPanel from '@/components/workbench/DiagnosticsPanel.vue';
import EmbeddedTerminal from '@/components/workbench/EmbeddedTerminal.vue';
import StructuredRunInsights from '@/components/workbench/StructuredRunInsights.vue';
import TerminalFlowPanel from '@/components/workbench/TerminalFlowPanel.vue';
import { useIntegratedTerminalControls } from '@/composables/useIntegratedTerminal';
import { useMessage } from '@/composables/useMessage';
import type { TThemeMode } from '@/types/app';
import type {
  IAnalyzeScriptPayload,
  IRunLogEntry,
  IRunResult,
  IScriptDiagnostic,
  TExecutorKind,
} from '@/types/editor';
import type { ITerminalSettings } from '@/types/settings';
import type {
    ITerminalRunCompletedPayload,
    ITerminalRunChunkPayload,
    ITerminalStatusChangePayload,
} from '@/types/terminal';
import { toErrorMessage } from '@/utils/error';
import { Eraser, Maximize2, Minimize2, RefreshCcw, X } from 'lucide-vue-next';
import { computed, ref } from 'vue';

const props = defineProps<{
  terminalOutputLength: number;
  terminalOutputVersion: number;
  resolveTerminalOutput: () => string;
  runLogs: IRunLogEntry[];
  lastRunResult: IRunResult | null;
  isRunning: boolean;
  executor: TExecutorKind;
  documentName: string;
  documentContent: string;
  documentPath: string | null;
  scriptAnalysis: IAnalyzeScriptPayload;
  workspaceRootPath: string | null;
  theme: TThemeMode;
  terminalSettings: ITerminalSettings;
  visible: boolean;
  isMaximized: boolean;
}>();

const emit = defineEmits<{
  hide: [];
  'terminal-run-chunk': [payload: ITerminalRunChunkPayload];
  'terminal-run-completed': [payload: ITerminalRunCompletedPayload];
  'toggle-maximize': [];
  'clear-logs': [];
  'select-diagnostic': [line: number, column: number];
  'rerun-analysis': [];
  'ai-fix-diagnostic': [diagnostic: IScriptDiagnostic];
}>();

const message = useMessage();
type TRunPanelTab = 'terminal' | 'logs' | 'flow' | 'shellcheck';

const activeTab = ref<TRunPanelTab>('terminal');
const tabs = [
  { label: '终端', value: 'terminal' },
  { label: '运行日志', value: 'logs' },
  { label: '事件流', value: 'flow' },
  { label: 'ShellCheck', value: 'shellcheck' },
] as const;

const terminalStatus = ref<ITerminalStatusChangePayload>({
  state: 'connecting',
  message: '正在连接 WSL2 终端…',
});

const { retry, clearScreen, sendCommand } = useIntegratedTerminalControls();

const isTerminalReady = computed(() => terminalStatus.value.state === 'ready');

const handleTerminalStatusChange = (payload: ITerminalStatusChangePayload): void => {
  terminalStatus.value = payload;
};

const runTerminalAction = async (
  task: () => Promise<void>,
  fallbackMessage: string,
  onSuccess?: () => void,
): Promise<void> => {
  try {
    await task();
    onSuccess?.();
  } catch (error) {
    message.error(toErrorMessage(error, fallbackMessage));
  }
};

const handleRestartTerminal = (): Promise<void> => runTerminalAction(retry, '重连终端失败');

const handleClearTerminal = (): Promise<void> => runTerminalAction(clearScreen, '清屏失败');

const handleSubmitCommand = (command: string): Promise<void> =>
  runTerminalAction(
    () => sendCommand(command),
    '发送命令失败',
    () => {
      activeTab.value = 'terminal';
    },
  );

const handleClearLogs = async (): Promise<void> => {
  emit('clear-logs');
  try {
    await clearScreen();
  } catch {
    // 忽略终端清屏失败，日志清空已单独完成。
  }
};

const handleSelectDiagnostic = (line: number, column: number): void => {
  emit('select-diagnostic', line, column);
};

const openShellCheck = (): void => {
  activeTab.value = 'shellcheck';
};

defineExpose({
  openShellCheck,
});
</script>
