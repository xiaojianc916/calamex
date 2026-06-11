<script setup lang="ts">
import type { IRunHistoryEntry } from '@/types/editor';

// TODO(sidebar/run): migrate run-history rendering out of the legacy RunPanel.
// This skeleton fixes the public shape so the coordinator can wire it before
// the full row UI (status, duration, rerun) is ported.
defineProps<{
  runHistory: IRunHistoryEntry[];
}>();

defineEmits<{
  'clear-run-history': [];
  'open-entry': [entry: IRunHistoryEntry];
}>();
</script>

<template>
  <section class="run-history-list" aria-label="运行历史">
    <header class="run-history-header">
      <span class="run-history-title">运行历史</span>
      <button v-if="runHistory.length > 0" type="button" class="run-history-clear"
        @click="$emit('clear-run-history')">
        清空
      </button>
    </header>

    <p v-if="runHistory.length === 0" class="run-history-empty">暂无运行历史</p>
    <ul v-else class="run-history-items">
      <li v-for="(entry, index) in runHistory" :key="index" class="run-history-item"
        @click="$emit('open-entry', entry)" />
    </ul>
  </section>
</template>
