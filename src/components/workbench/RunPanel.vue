<template>
  <section class="flex h-full min-h-0 flex-col bg-[var(--panel-bg)]">
    <div class="flex items-center justify-between border-b border-[var(--shell-divider)] px-4">
      <div class="flex items-center gap-5">
        <button
          v-for="item in tabs"
          :key="item.value"
          type="button"
          class="run-panel-tab h-11"
          :class="{ 'is-active': activeTab === item.value }"
          @click="activeTab = item.value"
        >
          {{ item.label }}
        </button>
      </div>
      <div class="flex items-center gap-2 text-[11px] text-[var(--text-quaternary)]">
        <span>{{ statusText }}</span>
        <span v-if="props.lastRunResult">耗时 {{ formatDuration(props.lastRunResult.durationMs) }}</span>
        <button
          type="button"
          class="icon-button app-tooltip-target run-panel-hide-button"
          data-tooltip="隐藏终端"
          data-tooltip-placement="top"
          aria-label="隐藏终端"
          @click="$emit('hide')"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            class="h-4 w-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3 5.5h10" />
            <path d="m5.2 8.4 2.8 2.8 2.8-2.8" />
          </svg>
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-hidden">
      <div v-show="activeTab === 'output'" class="h-full overflow-hidden">
        <EmbeddedTerminal
          :visible="props.visible && activeTab === 'output'"
          :theme="props.theme"
          @status-change="handleTerminalStatusChange"
        />
      </div>

      <div v-show="activeTab === 'logs'" class="h-full overflow-auto px-4 py-3">
        <div v-if="hasLogContent" class="space-y-2">
          <div
            v-if="props.terminalOutput.trim()"
            class="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-3"
          >
            <div class="flex items-center justify-between gap-3">
              <p class="text-sm font-medium text-[var(--text-primary)]">最近运行输出</p>
              <span class="text-[11px] text-[var(--text-quaternary)]">
                {{ props.lastRunResult?.executorLabel ?? executorLabel }}
              </span>
            </div>
            <pre class="mono-text mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-6 text-[var(--text-secondary)]">{{ props.terminalOutput }}</pre>
          </div>
          <div
            v-for="item in props.runLogs"
            :key="item.id"
            class="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-3"
          >
            <div class="flex items-center justify-between gap-3">
              <p class="text-sm font-medium text-[var(--text-primary)]">{{ item.title }}</p>
              <span class="text-[11px] text-[var(--text-quaternary)]">{{ formatTime(item.createdAt) }}</span>
            </div>
            <p class="mt-2 text-[12px] leading-6" :class="logToneClass(item.level)">{{ item.detail }}</p>
          </div>
        </div>
        <div v-else class="flex h-full items-center justify-center text-[12px] text-[var(--text-quaternary)]">
          运行日志会在这里显示打开、保存与执行等关键操作。
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import EmbeddedTerminal from '@/components/workbench/EmbeddedTerminal.vue';
import { formatTime } from '@/utils/date';
import { getExecutorLabel } from '@/utils/templates';
import type { TThemeMode } from '@/types/app';
import type { IRunLogEntry, IRunResult, TExecutorKind, TLogLevel } from '@/types/editor';
import type { ITerminalStatusChangePayload } from '@/types/terminal';

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
}>();

const activeTab = ref<'output' | 'logs'>('output');

const tabs = [
  { label: '终端', value: 'output' },
  { label: '运行日志', value: 'logs' },
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

  return terminalStatus.value.message;
});

const formatDuration = (durationMs: number): string => {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${Math.max(1, Math.round(durationMs / 100)) / 10}s`;
};

const logToneClass = (level: TLogLevel): string => {
  switch (level) {
    case 'success':
      return 'text-emerald-300';
    case 'error':
      return 'text-rose-300';
    default:
      return 'text-[var(--text-secondary)]';
  }
};

const hasLogContent = computed(
  () => props.runLogs.length > 0 || props.terminalOutput.trim().length > 0,
);

const handleTerminalStatusChange = (payload: ITerminalStatusChangePayload): void => {
  terminalStatus.value = payload;
};
</script>
