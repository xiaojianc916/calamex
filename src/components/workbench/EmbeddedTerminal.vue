<template>
  <div class="embedded-terminal-shell" data-shell-resize-responder @mousedown="handleShellMouseDown">
    <div ref="hostRef" class="embedded-terminal-host" :class="{ 'is-hidden-by-overlay': showOverlay }" />

    <div v-if="showOverlay" class="embedded-terminal-overlay" :class="{ 'is-error': isUnavailable }">
      <div class="embedded-terminal-overlay-body">
        <section v-if="!isUnavailable" class="embedded-terminal-loading" aria-live="polite">
          <p class="embedded-terminal-loading-title">终端加载中</p>
          <span class="embedded-terminal-loading-dots" aria-hidden="true">
            <span class="embedded-terminal-loading-dot" />
            <span class="embedded-terminal-loading-dot" />
            <span class="embedded-terminal-loading-dot" />
          </span>
        </section>

        <div v-if="isUnavailable" class="embedded-terminal-overlay-caption">
          <div class="embedded-terminal-overlay-caption-copy">
            <p class="embedded-terminal-overlay-caption-title">
              <template v-if="status === 'closed'">WSL2 终端已关闭</template>
              <template v-else>WSL2 终端暂不可用</template>
            </p>
            <p class="embedded-terminal-overlay-caption-text">
              <span v-if="statusMessage" v-text="statusMessage" />
              <span v-else>WSL2 终端连接中断，请点击重新连接。</span>
            </p>
          </div>

          <button type="button" class="linear-button embedded-terminal-retry" @click.stop="retry">
            重新连接
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useIntegratedTerminal } from '@/composables/useIntegratedTerminal';
import type { TThemeMode } from '@/types/app';
import type { ITerminalSettings } from '@/types/settings';
import type {
  ITerminalRunChunkPayload,
  ITerminalRunCompletedPayload,
  ITerminalStatusChangePayload,
} from '@/types/terminal';
import { DEFAULT_TERMINAL_SESSION_ID } from '@/types/terminal';
import '@xterm/xterm/css/xterm.css';
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    theme: TThemeMode;
    terminalSettings: ITerminalSettings;
    sessionId?: string;
  }>(),
  {
    sessionId: DEFAULT_TERMINAL_SESSION_ID,
  },
);

const emit = defineEmits<{
  'status-change': [payload: ITerminalStatusChangePayload];
  'run-chunk': [payload: ITerminalRunChunkPayload];
  'run-completed': [payload: ITerminalRunCompletedPayload];
}>();

const visible = computed(() => props.visible);
const theme = computed(() => props.theme);
const terminalSettings = computed(() => props.terminalSettings);
const { hostRef, status, statusMessage, retry, focusTerminal } = useIntegratedTerminal({
  sessionId: props.sessionId,
  visible,
  theme,
  settings: terminalSettings,
  onStatusChange: (payload) => emit('status-change', payload),
  onOutput: (payload) => emit('run-chunk', payload),
  onRunCompleted: (payload) => emit('run-completed', payload),
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
