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

      <span v-if="!isTerminalReady" class="run-panel-status" :class="statusClassName">
        {{ statusText }}
      </span>

      <div class="run-panel-actions">
        <button
          type="button"
          class="icon-button app-tooltip-target run-panel-action-button"
          data-tooltip="重连终端"
          data-tooltip-placement="top"
          aria-label="重连终端"
          @click="void handleRestartTerminal()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
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
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
            <line x1="18" y1="9" x2="12" y2="15" />
            <line x1="12" y1="9" x2="18" y2="15" />
          </svg>
        </button>

        <button
          type="button"
          class="icon-button app-tooltip-target run-panel-action-button"
          data-tooltip="终止"
          data-tooltip-placement="top"
          aria-label="终止"
          :disabled="!isTerminalReady"
          @click="void handleInterruptTerminal()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          </svg>
        </button>

        <span class="run-panel-action-divider" aria-hidden="true" />

        <button
          type="button"
          class="icon-button app-tooltip-target run-panel-action-button"
          :data-tooltip="props.isMaximized ? '还原终端高度' : '最大化终端'"
          data-tooltip-placement="top"
          :aria-label="props.isMaximized ? '还原终端高度' : '最大化终端'"
          :aria-pressed="props.isMaximized"
          @click="$emit('toggle-maximize')"
        >
          <svg v-if="!props.isMaximized" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="18 15 12 9 6 15" />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        <button
          type="button"
          class="icon-button app-tooltip-target run-panel-action-button"
          data-tooltip="关闭终端面板"
          data-tooltip-placement="top"
          aria-label="关闭终端面板"
          @click="$emit('hide')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </header>

    <div class="run-panel-body">
      <div v-show="activeTab === 'terminal'" class="run-panel-view is-terminal">
        <EmbeddedTerminal
          :visible="props.visible && activeTab === 'terminal'"
          :theme="props.theme"
          @status-change="handleTerminalStatusChange"
          @output="$emit('terminal-output', $event)"
          @run-complete="$emit('terminal-run-complete', $event)"
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
    </div>
  </section>
</template>

<script setup lang="ts">
import EmbeddedTerminal from '@/components/workbench/EmbeddedTerminal.vue';
import StructuredRunInsights from '@/components/workbench/StructuredRunInsights.vue';
import { useIntegratedTerminalControls } from '@/composables/useIntegratedTerminal';
import { useMessage } from '@/composables/useMessage';
import type { TThemeMode } from '@/types/app';
import type { IRunLogEntry, IRunResult, TExecutorKind } from '@/types/editor';
import type {
  ITerminalRunCompletePayload,
  ITerminalRunOutputEvent,
  ITerminalStatusChangePayload,
} from '@/types/terminal';
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  terminalOutputLength: number;
  terminalOutputVersion: number;
  resolveTerminalOutput: () => string;
  runLogs: IRunLogEntry[];
  lastRunResult: IRunResult | null;
  isRunning: boolean;
  executor: TExecutorKind;
  documentName: string;
  documentPath: string | null;
  workspaceRootPath: string | null;
  theme: TThemeMode;
  visible: boolean;
  isMaximized: boolean;
}>();

const emit = defineEmits<{
  hide: [];
  'terminal-output': [payload: ITerminalRunOutputEvent];
  'terminal-run-complete': [payload: ITerminalRunCompletePayload];
  'toggle-maximize': [];
  'clear-logs': [];
}>();

const message = useMessage();
const activeTab = ref<'terminal' | 'logs'>('terminal');
const tabs = [
  { label: '终端', value: 'terminal' },
  { label: '运行日志', value: 'logs' },
] as const;

const terminalStatus = ref<ITerminalStatusChangePayload>({
  state: 'connecting',
  message: '正在连接 WSL2 终端…',
});

const { retry, clearScreen, interrupt, sendCommand } = useIntegratedTerminalControls();

const isTerminalReady = computed(() => terminalStatus.value.state === 'ready');
const statusText = computed(() => terminalStatus.value.message);
const statusClassName = computed(() => (isTerminalReady.value ? 'is-ready' : 'is-muted'));

const handleTerminalStatusChange = (payload: ITerminalStatusChangePayload): void => {
  terminalStatus.value = payload;
};

const handleRestartTerminal = async (): Promise<void> => {
  try {
    await retry();
  } catch (error) {
    const nextMessage = error instanceof Error ? error.message : '重连终端失败';
    message.error(nextMessage);
  }
};

const handleClearTerminal = async (): Promise<void> => {
  try {
    await clearScreen();
  } catch (error) {
    const nextMessage = error instanceof Error ? error.message : '清屏失败';
    message.error(nextMessage);
  }
};

const handleInterruptTerminal = async (): Promise<void> => {
  try {
    await interrupt();
  } catch (error) {
    const nextMessage = error instanceof Error ? error.message : '终止终端执行失败';
    message.error(nextMessage);
  }
};

const handleSubmitCommand = async (command: string): Promise<void> => {
  try {
    await sendCommand(command);
    activeTab.value = 'terminal';
  } catch (error) {
    const nextMessage = error instanceof Error ? error.message : '发送命令失败';
    message.error(nextMessage);
  }
};

const handleClearLogs = async (): Promise<void> => {
  emit('clear-logs');
  try {
    await clearScreen();
  } catch {
    // 忽略终端清屏失败，日志清空已单独完成。
  }
};

watch(
  () => props.isRunning,
  (nextIsRunning, previousIsRunning) => {
    if (nextIsRunning && !previousIsRunning) {
      activeTab.value = 'logs';
    }
  },
);
</script>
