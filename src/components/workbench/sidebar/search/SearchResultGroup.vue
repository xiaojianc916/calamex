<template>
  <article class="search-panel-result-group">
    <header class="search-panel-result-group-header">
      <button type="button" class="search-panel-result-group-open"
        :aria-expanded="!collapsed" @click="emit('toggle', group.path)">
        <LucideIcon class="search-panel-result-group-chevron" aria-hidden="true"
          :name="collapsed ? 'chevron-right' : 'chevron-down'" />
        <span class="search-panel-result-group-icon" aria-hidden="true">
          <ExplorerEntryIcon kind="file" :path="group.path" />
        </span>
        <span class="search-panel-result-group-name" v-text="group.name" />
        <span class="search-panel-result-group-path" v-text="group.parentPath" />
      </button>
      <span class="search-panel-result-group-count" v-text="group.results.length" />
    </header>

    <template v-if="!collapsed">
      <button v-for="result in group.results" :key="result.resultKey" type="button"
        class="search-panel-result-line" :class="{ 'is-selected': selectedResultKey === result.resultKey }"
        role="option" :aria-selected="selectedResultKey === result.resultKey"
        @click="emit('open', result)">
        <span class="search-panel-result-line-number" v-text="result.lineNumber" />

        <span class="search-panel-result-line-body">
          <span class="search-panel-result-snippet">
            <template v-for="(segment, index) in result.snippetSegments"
              :key="`${result.resultKey}-snippet-${index}`">
              <mark v-if="segment.matched" class="search-panel-result-snippet-match"
                :class="`is-${segment.part}`" v-text="segment.text" />
              <span v-else class="search-panel-result-snippet-context"
                :class="`is-${segment.part}`" v-text="segment.text" />
            </template>
          </span>
        </span>
      </button>
    </template>
  </article>
</template>

<script setup lang="ts">
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import ExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';
import type { ISearchResultGroup, ISearchResultItem } from './search-sidebar.types';

defineProps<{
  group: ISearchResultGroup;
  collapsed: boolean;
  selectedResultKey: string | null;
}>();

const emit = defineEmits<{
  toggle: [path: string];
  open: [result: ISearchResultItem];
}>();
</script>
