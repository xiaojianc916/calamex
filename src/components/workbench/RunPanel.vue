<template>
  <section class="flex h-full min-h-0 flex-col bg-[var(--panel-bg)]">
    <div class="flex items-center justify-between border-b border-[var(--shell-divider)] px-4">
      <div class="flex items-center gap-5">
        <button v-for="item in tabs" :key="item.value" type="button" class="run-panel-tab h-11"
          :class="{ 'is-active': activeTab === item.value }" @click="activeTab = item.value">
          {{ item.label }}
        </button>

        <button type="button" class="icon-button app-tooltip-target run-panel-hide-button" data-tooltip="隐藏终端"
          data-tooltip-placement="top" aria-label="隐藏终端" @click="$emit('hide')">
          <svg viewBox="0 0 16 16" aria-hidden="true" class="h-4 w-4" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 5.5h10" />
            <path d="m5.2 8.4 2.8 2.8 2.8-2.8" />
          </svg>
        </button>
      </div>

      <div class="flex items-center gap-2 text-[11px] text-[var(--text-quaternary)]">
        <span>{{ statusText }}</span>
        <span v-if="props.lastRunResult">耗时 {{ formatDuration(props.lastRunResult.durationMs) }}</span>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-hidden">
      <div v-show="activeTab === 'output'" class="h-full overflow-hidden">
        <EmbeddedTerminal :visible="props.visible && activeTab === 'output'" :theme="props.theme"
          @status-change="handleTerminalStatusChange" @output="$emit('terminal-output', $event)"
          @run-complete="$emit('terminal-run-complete', $event)" />
      </div>

      <div v-if="activeTab === 'logs'" class="h-full overflow-auto px-4 py-3">
        <StructuredRunInsights :terminal-output="props.terminalOutput" :run-logs="props.runLogs"
          :last-run-result="props.lastRunResult" :is-running="props.isRunning" :executor="props.executor" />
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
import { getExecutorLabel } from '@/utils/templates';
import { computed, ref } from 'vue';

const props = defineProps<{
  terminalOutput: string;
  runLogs: IRunLogEntry[];
  lastRunResult: IRunResult | null;
  isRunning: boolean;
  executor: TExecutorKind;
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
  { label: '日志输出', value: 'logs' },
] as const;

const executorLabel = computed(() => getExecutorLabel(props.executor));
const terminalStatus = ref<ITerminalStatusChangePayload>({
  state: 'connecting',
  message: '正在连接 WSL2 终端…',
});

const statusText = computed(() => {
  if (props.isRunning) {
    return '脚本正在执行…';
  }

  return terminalStatus.value.message || executorLabel.value;
});

const formatDuration = (durationMs: number): string => {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${Math.max(1, Math.round(durationMs / 100)) / 10}s`;
};

const handleTerminalStatusChange = (payload: ITerminalStatusChangePayload): void => {
  terminalStatus.value = payload;
};
</script>
