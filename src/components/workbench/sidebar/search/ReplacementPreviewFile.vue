<template>
  <article class="search-replace-inline-file">
    <header class="search-replace-inline-file-header">
      <button type="button" class="search-replace-inline-file-open"
        :aria-expanded="!collapsed" @click="emit('toggle', file.path)">
        <LucideIcon class="search-replace-inline-chevron" aria-hidden="true"
          :name="collapsed ? 'chevron-right' : 'chevron-down'" />
        <span class="search-replace-inline-file-icon" aria-hidden="true">
          <ExplorerEntryIcon kind="file" :path="file.path" />
        </span>
        <span class="search-replace-inline-file-name" v-text="file.name" />
        <span class="search-replace-inline-file-path" v-text="file.parentPath" />
      </button>
      <span class="search-replace-inline-count" v-text="file.visibleReplacementCount" />
    </header>

    <template v-if="!collapsed">
      <ReplacementPreviewLine v-for="line in file.visibleLinePreviews" :key="line.id" :line="line"
        :applying="applying" :applying-line-id="applyingLineId"
        @open="emit('open', { path: file.path, lineNumber: $event })"
        @replace="emit('replace', { file, line: $event })"
        @skip="emit('skip', $event)" />
    </template>
  </article>
</template>

<script setup lang="ts">
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import ExplorerEntryIcon from '@/components/workbench/sidebar/explorer/ExplorerEntryIcon.vue';
import ReplacementPreviewLine from './ReplacementPreviewLine.vue';
import type { IReplacementFileView, IReplacementLineView } from './search-sidebar.types';

defineProps<{
  file: IReplacementFileView;
  collapsed: boolean;
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
