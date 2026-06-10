<script setup lang="ts">
import LegacyRunPanel from '@/components/workbench/RunPanel.vue';
import type { ITerminalSettings, TThemeMode } from '@/types/app';

const props = defineProps<{
  theme: TThemeMode;
  terminalSettings: ITerminalSettings;
  visible: boolean;
  isMaximized: boolean;
}>();

const emit = defineEmits<{
  hide: [];
  'toggle-maximize': [];
  'terminal-run-completed': [];
}>();
</script>

<template>
  <LegacyRunPanel
    :theme="props.theme"
    :terminal-settings="props.terminalSettings"
    :visible="props.visible"
    :is-maximized="props.isMaximized"
    @hide="emit('hide')"
    @toggle-maximize="emit('toggle-maximize')"
    @terminal-run-completed="emit('terminal-run-completed')"
  />
</template>
