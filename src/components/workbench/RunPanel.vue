<template>
  <section class="flex h-full min-h-0 flex-col bg-(--panel-bg)">
    <div class="flex items-center justify-between border-b border-(--shell-divider) px-4">
      <div class="flex items-center gap-5">
        <button
v-for="item in tabs" :key="item.value" type="button" class="run-panel-tab h-11"
          :class="{ 'is-active': activeTab === item.value }" @click="activeTab = item.value">
          {{ item.label }}
        </button>
      </div>

      <div class="flex items-center gap-2">
        <span v-if="!isTerminalReady" class="run-panel-status text-[11px]" :class="statusClassName">
          {{ statusText }}
        </span>

        <button
type="button" class="icon-button app-tooltip-target run-panel-hide-button" data-tooltip="隐藏终端"
          data-tooltip-placement="top" aria-label="隐藏终端" @click="$emit('hide')">
          <svg
viewBox="0 0 16 16" aria-hidden="true" class="h-4 w-4" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 5.5h10" />
            <path d="m5.2 8.4 2.8 2.8 2.8-2.8" />
          </svg>
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-hidden">
      <div v-show="activeTab === 'output'" class="h-full overflow-hidden">
        <EmbeddedTerminal
:visible="props.visible && activeTab === 'output'" :theme="props.theme"
          @status-change="handleTerminalStatusChange" @output="$emit('terminal-output', $event)"
          @run-complete="$emit('terminal-run-complete', $event)" />
      </div>

      <div v-if="activeTab === 'logs'" class="workbench-scroll-region h-full overflow-auto px-4 py-3">
        <StructuredRunInsights
:active="activeTab === 'logs'" :terminal-output-version="props.terminalOutputVersion"
          :resolve-terminal-output="props.resolveTerminalOutput" :run-logs="props.runLogs"
          :last-run-result="props.lastRunResult" :is-running="props.isRunning" :executor="props.executor"
          :document-name="props.documentName" :document-path="props.documentPath"
          :workspace-root-path="props.workspaceRootPath" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import EmbeddedTerminal from '@/components/workbench/EmbeddedTerminal.vue';
import StructuredRunInsights from '@/components/workbench/StructuredRunInsights.vue';
import type { TThemeMode } from '@/types/app';
import type { IRunLogEntry, IRunResult, TExecutorKind } from '@/types/editor';
import type { ITerminalRunCompletePayload, ITerminalStatusChangePayload } from '@/types/terminal';
import { computed, ref, watch } from 'vue';

const props = defineProps<{
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
}>();

defineEmits<{
  hide: [];
  'terminal-output': [value: string];
  'terminal-run-complete': [payload: ITerminalRunCompletePayload];
}>();

const activeTab = ref<'output' | 'logs'>('output');

const tabs = [
  { label: '终端', value: 'output' },
  { label: '运行日志', value: 'logs' },
] as const;

const terminalStatus = ref<ITerminalStatusChangePayload>({
  state: 'connecting',
  message: '正在连接 WSL2 终端…',
});

const isTerminalReady = computed(() => terminalStatus.value.state === 'ready');

const statusText = computed(() => {
  return terminalStatus.value.message;
});

const statusClassName = computed(() => (isTerminalReady.value ? 'is-ready' : 'is-muted'));

const handleTerminalStatusChange = (payload: ITerminalStatusChangePayload): void => {
  terminalStatus.value = payload;
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
