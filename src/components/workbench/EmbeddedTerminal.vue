<template>
  <div class="embedded-terminal-shell" @mousedown="handleShellMouseDown">
    <div
      ref="hostRef"
      class="embedded-terminal-host"
      :class="{ 'is-hidden-by-overlay': showOverlay }"
    />

    <div
      v-if="showOverlay"
      class="embedded-terminal-overlay"
      :class="{ 'is-error': isUnavailable }"
    >
      <div class="embedded-terminal-overlay-body">
        <section class="embedded-terminal-skeleton-layout" aria-hidden="true">
          <div class="embedded-terminal-skeleton-divider" />

          <div class="embedded-terminal-skeleton-lines">
            <Skeleton
              v-for="row in loadingRows"
              :key="row"
              class="embedded-terminal-skeleton-row"
              :class="row"
            />
          </div>
        </section>

        <div v-if="isUnavailable" class="embedded-terminal-overlay-caption">
          <div class="embedded-terminal-overlay-caption-copy">
            <p class="embedded-terminal-overlay-caption-title">
              {{ status === 'closed' ? 'WSL2 终端已关闭' : 'WSL2 终端暂不可用' }}
            </p>
            <p class="embedded-terminal-overlay-caption-text">
              {{ statusMessage }}
            </p>
          </div>

          <button
            type="button"
            class="linear-button embedded-terminal-retry"
            @click.stop="retry"
          >
            重新连接
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Skeleton } from '@/components/ui/skeleton';
import { useIntegratedTerminal } from '@/composables/useIntegratedTerminal';
import type { TThemeMode } from '@/types/app';
import type { ITerminalSettings } from '@/types/settings';
import type {
    ITerminalRunCompletePayload,
    ITerminalRunOutputEvent,
    ITerminalStatusChangePayload,
} from '@/types/terminal';
import '@xterm/xterm/css/xterm.css';
import { computed } from 'vue';

const props = defineProps<{
  visible: boolean;
  theme: TThemeMode;
  terminalSettings: ITerminalSettings;
}>();

const emit = defineEmits<{
  'status-change': [payload: ITerminalStatusChangePayload];
  output: [payload: ITerminalRunOutputEvent];
  'run-complete': [payload: ITerminalRunCompletePayload];
}>();

const visible = computed(() => props.visible);
const theme = computed(() => props.theme);
const terminalSettings = computed(() => props.terminalSettings);
const loadingRows = ['is-w100', 'is-w85', 'is-w70', 'is-w92', 'is-w60'] as const;

const { hostRef, status, statusMessage, retry, focusTerminal } = useIntegratedTerminal({
  visible,
  theme,
  settings: terminalSettings,
  onStatusChange: (payload) => emit('status-change', payload),
  onOutput: (value) => emit('output', value),
  onRunComplete: (payload) => emit('run-complete', payload),
});

const showOverlay = computed(() => status.value !== 'ready');
const isUnavailable = computed(() => status.value === 'error' || status.value === 'closed');

const handleShellMouseDown = (): void => {
  if (showOverlay.value) {
    return;
  }

  focusTerminal();
};
</script>
