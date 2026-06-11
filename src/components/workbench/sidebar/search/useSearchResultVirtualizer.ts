import { useVirtualizer } from '@tanstack/vue-virtual';
import { type ComputedRef, type Ref, computed, watch } from 'vue';
import type { IFlatSearchRow } from './search-sidebar.types';

const SEARCH_VIRTUALIZE_THRESHOLD = 100;
const SEARCH_GROUP_ROW_HEIGHT = 28;
const SEARCH_LINE_ROW_HEIGHT = 24;

export interface IWindowedSearchRow {
  key: string;
  start: number;
  row: IFlatSearchRow;
}

export const useSearchResultVirtualizer = (options: {
  flatSearchRows: ComputedRef<IFlatSearchRow[]>;
  scrollRef: Ref<HTMLElement | null>;
}) => {
  const { flatSearchRows, scrollRef } = options;

  const shouldVirtualizeSearch = computed(
    () => flatSearchRows.value.length > SEARCH_VIRTUALIZE_THRESHOLD,
  );

  const searchVirtualizer = useVirtualizer<HTMLElement, HTMLElement>(
    computed(() => ({
      count: shouldVirtualizeSearch.value ? flatSearchRows.value.length : 0,
      getScrollElement: () => scrollRef.value,
      estimateSize: (index: number) =>
        flatSearchRows.value[index]?.kind === 'group'
          ? SEARCH_GROUP_ROW_HEIGHT
          : SEARCH_LINE_ROW_HEIGHT,
      overscan: 16,
      getItemKey: (index: number) => flatSearchRows.value[index]?.key ?? index,
    })),
  );

  const searchTotalSize = computed(() =>
    shouldVirtualizeSearch.value ? searchVirtualizer.value.getTotalSize() : 0,
  );

  const windowedSearchRows = computed<IWindowedSearchRow[]>(() =>
    (shouldVirtualizeSearch.value ? searchVirtualizer.value.getVirtualItems() : [])
      .map((item) => ({
        key: String(item.key),
        start: item.start,
        row: flatSearchRows.value[item.index],
      }))
      .filter((entry): entry is IWindowedSearchRow => Boolean(entry.row)),
  );

  watch(flatSearchRows, () => {
    searchVirtualizer.value.measure();
  });

  return { shouldVirtualizeSearch, searchTotalSize, windowedSearchRows };
};
