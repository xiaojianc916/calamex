<template>
  <div class="search-replace-inline">
    <div v-if="loading" class="search-replace-inline-empty">
      <LoaderCircle class="search-panel-spin" aria-hidden="true" />
      <span>正在生成替换预览…</span>
    </div>

    <div v-else-if="files.length === 0" class="search-panel-empty-state">
      <p class="search-panel-empty-title">没有待替换项</p>
      <p class="search-panel-empty-text">当前预览中的命中项已全部跳过。</p>
    </div>

    <template v-else>
      <ReplacementPreviewFile v-for="file in files" :key="file.path" :file="file"
        :collapsed="collapsedPaths.has(file.path)" :applying="applying" :applying-line-id="applyingLineId"
        @toggle="emit('toggle', $event)"
        @open="emit('open', $event)"
        @replace="emit('replace', $event)"
        @skip="emit('skip', $event)" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';
import ReplacementPreviewFile from './ReplacementPreviewFile.vue';
import type { IReplacementFileView, IReplacementLineView } from './search-sidebar.types';

defineProps<{
  loading: boolean;
  files: IReplacementFileView[];
  collapsedPaths: ReadonlySet<string>;
  applying: boolean;
  applyingLineId: string | null;
}>();

const emit = defineEmits<{
  toggle: [path: string];
  open: [payload: { path: string; lineNumber: number }];
  replace: [payload: { file: IReplacementFileView; line: IReplacementLineView }];
  skip: [lineId: string];
}>();
</script>
