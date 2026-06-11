<script setup lang="ts">
import type { IActiveRunSummary } from '@/types/editor';

// TODO(sidebar/run): migrate the active-run summary presentation out of the
// legacy RunPanel. This skeleton fixes the public shape (props/emits) so the
// coordinator can wire it before the full UI is ported.
defineProps<{
  activeRun: IActiveRunSummary | null;
  isRunning: boolean;
}>();

defineEmits<{
  'open-terminal': [];
}>();
</script>

<template>
  <section class="run-active-summary" aria-label="当前运行">
    <p v-if="!activeRun" class="run-active-summary-empty">暂无运行</p>
    <div v-else class="run-active-summary-body">
      <span class="run-active-summary-status"> isRunning ? '运行中' : '已结束' </span>
      <button type="button" class="run-active-summary-terminal" @click="$emit('open-terminal')">
        查看终端
      </button>
    </div>
  </section>
</template>
