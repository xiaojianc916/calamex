<template>
  <div v-if="shouldVirtualize" class="search-panel-virtual-spacer" :style="{ height: `${totalSize}px` }">
    <template v-for="entry in windowedRows" :key="entry.key">
      <header v-if="entry.row.kind === 'group'" class="search-panel-result-group-header search-panel-virtual-row"
        :style="{ transform: `translateY(${entry.start}px)` }">
        <button type="button" class="search-panel-result-group-open"
          :aria-expanded="!collapsedPaths.has(entry.row.group.path)"
          @click="emit('toggle-group', entry.row.group.path)">
          <LucideIcon class="search-panel-result-group-chevron" aria-hidden="true"
            :name="collapsedPaths.has(entry.row.group.path) ? 'chevron-right' : 'chevron-down'" />
          <span class="search-panel-result-group-icon" aria-hidden="true">
            <ExplorerEntryIcon kind="file" :path="entry.row.group.path" />
          </span>
          <span class="search-panel-result-group-name" v-text="entry.row.group.name" />
          <span class="search-panel-result-group-path" v-text="entry.row.group.parentPath" />
        </button>
        <span class="search-panel-result-group-count" v-text="entry.row.group.results.length" />
      </header>

      <button v-else type="button" class="search-panel-result-line search-panel-virtual-row"
        :class="{ 'is-selected': selectedResultKey === entry.row.result?.resultKey }" role="option"
        :aria-selected="selectedResultKey === entry.row.result?.resultKey"
        :style="{ transform: `translateY(${entry.start}px)` }"
        @click="entry.row.result && emit('open-result', entry.row.result)">
        <span class="search-panel-result-line-number" v-text="entry.row.result?.lineNumber" />
        <span class="search-panel-result-line-body">
          <span class="search-panel-result-snippet">
            <template v-for="(segment, index) in entry.row.result?.snippetSegments ?? []"
              :key="`${entry.row.result?.resultKey}-snippet-${index}`">
              <mark v-if="segment.matched" class="search-panel-result-snippet-match"
                :class="`is-${segment.part}`" v-text="segment.text" />
              <span v-else class="search-panel-result-snippet-context"
                :class="`is-${segment.part}`" v-text="segment.text" />
            </template>
          </span>
        </span>
      </button>
    </template>
  </div>

  <template v-else>
    <SearchResultGroup v-for="group in groups" :key="group.path" :group="group"
      :collapsed="collapsedPaths.has(group.path)" :selected-result-key="selectedResultKey"
      @toggle="emit('toggle-group', $event)" @open="emit('open-result', $event)" />
  </template>
</template>

<script setup lang="ts">
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import ExplorerEntryIcon from '@/components/workbench/sidebar/explorer/ExplorerEntryIcon.vue';
import SearchResultGroup from './SearchResultGroup.vue';
import type { ISearchResultGroup, ISearchResultItem } from './search-sidebar.types';
import type { IWindowedSearchRow } from './useSearchResultVirtualizer';

defineProps<{
  shouldVirtualize: boolean;
  windowedRows: IWindowedSearchRow[];
  totalSize: number;
  groups: ISearchResultGroup[];
  collapsedPaths: ReadonlySet<string>;
  selectedResultKey: string | null;
}>();

const emit = defineEmits<{
  'toggle-group': [path: string];
  'open-result': [result: ISearchResultItem];
}>();
</script>
