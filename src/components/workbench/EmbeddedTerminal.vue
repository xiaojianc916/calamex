<template>
  <div class="embedded-terminal-shell" @mousedown="focusTerminal">
    <div ref="hostRef" class="embedded-terminal-host" />

    <div
      v-if="status !== 'ready'"
      class="embedded-terminal-overlay"
      :class="{ 'is-error': status === 'error' || status === 'closed' }"
    >
      <p class="embedded-terminal-overlay-title">
        {{ status === 'connecting' ? 'WSL2 终端启动中' : 'WSL2 终端暂不可用' }}
      </p>
      <p class="embedded-terminal-overlay-text">
        {{ statusMessage }}
      </p>
      <button
        v-if="status === 'error' || status === 'closed'"
        type="button"
        class="linear-button embedded-terminal-retry"
        @click.stop="retry"
      >
        重新连接
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import '@xterm/xterm/css/xterm.css';
import { useIntegratedTerminal } from '@/composables/useIntegratedTerminal';
import type { TThemeMode } from '@/types/app';
import type { ITerminalStatusChangePayload } from '@/types/terminal';

const props = defineProps<{
  visible: boolean;
  theme: TThemeMode;
}>();

const emit = defineEmits<{
  'status-change': [payload: ITerminalStatusChangePayload];
}>();

const visible = computed(() => props.visible);
const theme = computed(() => props.theme);

const { hostRef, status, statusMessage, retry, focusTerminal } = useIntegratedTerminal({
  visible,
  theme,
  onStatusChange: (payload) => emit('status-change', payload),
});
</script>
