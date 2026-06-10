<script setup lang="ts">
import LegacyRunPanel from '@/components/workbench/RunPanel.vue';
import type { TThemeMode } from '@/types/app';
import type { ITerminalSettings } from '@/types/settings';
import type { ITerminalRunChunkPayload, ITerminalRunCompletedPayload } from '@/types/terminal';

const props = defineProps<{
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
}>();
</script>

<template>
  <LegacyRunPanel
    :theme="props.theme"
    :terminal-settings="props.terminalSettings"
    :visible="props.visible"
    :is-maximized="props.isMaximized"
    @hide="emit('hide')"
    @terminal-run-chunk="emit('terminal-run-chunk', $event)"
    @terminal-run-completed="emit('terminal-run-completed', $event)"
    @toggle-maximize="emit('toggle-maximize')"
  />
</template>
