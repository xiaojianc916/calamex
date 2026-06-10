import { computed, type ComputedRef, type Ref } from 'vue';
import type { TWorkbenchSidebarView } from '@/types/app';

export interface ISidebarPanelVisibility {
  isExplorerView: ComputedRef<boolean>;
  isSearchView: ComputedRef<boolean>;
  isSourceControlView: ComputedRef<boolean>;
  isRunView: ComputedRef<boolean>;
  isSshView: ComputedRef<boolean>;
}

export const useSidebarPanelVisibility = (
  activeView: Ref<TWorkbenchSidebarView> | ComputedRef<TWorkbenchSidebarView>,
): ISidebarPanelVisibility => ({
  isExplorerView: computed(() => activeView.value === 'explorer'),
  isSearchView: computed(() => activeView.value === 'search'),
  isSourceControlView: computed(() => activeView.value === 'source-control'),
  isRunView: computed(() => activeView.value === 'run'),
  isSshView: computed(() => activeView.value === 'extensions'),
});
