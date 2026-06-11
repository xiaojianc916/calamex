<template>
  <div
    class="search-replace-inline-line"
    role="option"
    tabindex="0"
    @click="emit('open', line.lineNumber)"
    @keydown.enter="emit('open', line.lineNumber)"
    @keydown.space.prevent="emit('open', line.lineNumber)"
  >
    <span class="search-replace-inline-line-number" v-text="line.lineNumber" />
    <span class="search-replace-inline-code">
      <template v-for="(segment, segmentIndex) in line.segments" :key="`${line.id}-${segmentIndex}`">
        <span v-if="segment.kind !== 'empty'" class="search-replace-inline-segment"
          :class="[`is-${segment.kind}`, `is-${segment.part}`]" v-text="segment.text" />
      </template>
    </span>

    <span class="search-replace-inline-line-actions">
      <button type="button" class="search-replace-inline-icon-btn" :disabled="applying"
        aria-label="替换此处" title="替换此处" @click.stop="emit('replace', line)">
        <LoaderCircle class="search-panel-spin" v-if="applyingLineId === line.id" aria-hidden="true" />
        <Replace v-else aria-hidden="true" />
      </button>
      <button type="button" class="search-replace-inline-icon-btn" :disabled="applying"
        aria-label="跳过此处" title="跳过此处" @click.stop="emit('skip', line.id)">
        <X aria-hidden="true" />
      </button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { LoaderCircle, Replace, X } from '@lucide/vue';
import type { IReplacementLineView } from './search-sidebar.types';

defineProps<{
  line: IReplacementLineView;
  applying: boolean;
  applyingLineId: string | null;
}>();

const emit = defineEmits<{
  open: [lineNumber: number];
  replace: [line: IReplacementLineView];
  skip: [lineId: string];
}>();
</script>
