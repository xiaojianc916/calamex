<template>
  <aside class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="border-b border-[var(--shell-divider)] px-3 py-3">
      <p class="sidebar-section-title">资源管理器</p>
    </div>

    <div class="min-h-0 flex-1 overflow-auto py-2">
      <div v-if="!isDesktopRuntime" class="explorer-helper-text px-3 py-2">
        浏览器预览模式下不显示本地目录树，请在 Tauri 桌面端查看资源文件。
      </div>

      <template v-else-if="root">
        <button
          type="button"
          class="explorer-root-row w-full text-left"
          :class="{ 'is-expanded': rootExpanded }"
          @click="toggleRoot"
        >
          <span class="explorer-chevron">
            <svg viewBox="0 0 12 12" class="h-3 w-3 transition-transform" :class="rootExpanded ? 'rotate-90' : ''" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 2.5 8 6 4 9.5" />
            </svg>
          </span>
          <svg viewBox="0 0 24 24" class="h-4 w-4 text-[var(--warning)]" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3.5 7.5h6l1.8 2H20v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
            <path d="M3.5 9.5V7a2 2 0 0 1 2-2h4" />
          </svg>
          <span class="truncate">{{ rootLabel }}</span>
        </button>

        <div v-if="rootExpanded" class="pb-2">
          <div v-if="rootLoading" class="explorer-helper-text px-3 py-2">正在读取资源目录...</div>
          <div v-else-if="rootEntries.length === 0" class="explorer-helper-text px-3 py-2">当前目录暂无文件。</div>
          <WorkspaceTreeNode
            v-for="entry in rootEntries"
            :key="entry.path"
            :entry="entry"
            :level="0"
            :children-map="childrenMap"
            :expanded-paths="expandedPaths"
            :loading-paths="loadingPaths"
            :active-path="document.path"
            :active-dirty="document.isDirty"
            @toggle-directory="toggleDirectory"
            @open-file="handleOpenFile"
          />
        </div>
      </template>

      <div v-else-if="rootLoading" class="explorer-helper-text px-3 py-2">正在读取资源目录...</div>
      <div v-else class="explorer-helper-text px-3 py-2">
        {{ loadError || '暂未加载到工作区目录。' }}
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useMessage } from '@/composables/useMessage';
import WorkspaceTreeNode from '@/components/workbench/WorkspaceTreeNode.vue';
import { tauriService } from '@/services/tauri';
import type { IEditorDocument, IWorkspaceDirectoryPayload, IWorkspaceEntry } from '@/types/editor';

const props = defineProps<{
  document: IEditorDocument;
  isDesktopRuntime: boolean;
  workspaceRootPath: string | null;
}>();

const emit = defineEmits<{
  'open-file': [path: string];
}>();

const root = ref<IWorkspaceDirectoryPayload | null>(null);
const rootExpanded = ref(true);
const rootLoading = ref(false);
const loadError = ref('');
const childrenMap = reactive<Record<string, IWorkspaceEntry[]>>({});
const expandedPaths = reactive<Record<string, boolean>>({});
const loadingPaths = reactive<Record<string, boolean>>({});
let rootRequestId = 0;

const rootEntries = computed(() => {
  if (!root.value) {
    return [];
  }

  return childrenMap[root.value.rootPath] ?? [];
});

const rootLabel = computed(() => root.value?.rootName ?? 'workspace');

const getErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const clearTreeState = (): void => {
  Object.keys(childrenMap).forEach((path) => {
    delete childrenMap[path];
  });
  Object.keys(expandedPaths).forEach((path) => {
    delete expandedPaths[path];
  });
  Object.keys(loadingPaths).forEach((path) => {
    delete loadingPaths[path];
  });
};

const loadWorkspaceRoot = async (): Promise<void> => {
  if (!props.isDesktopRuntime) {
    return;
  }

  const requestId = rootRequestId + 1;
  rootRequestId = requestId;
  rootLoading.value = true;
  loadError.value = '';
  root.value = null;
  clearTreeState();

  try {
    const payload = await tauriService.listWorkspaceEntries(
      undefined,
      props.workspaceRootPath ?? undefined,
    );
    if (requestId !== rootRequestId) {
      return;
    }

    root.value = payload;
    childrenMap[payload.rootPath] = payload.entries;
    rootExpanded.value = true;
  } catch (error) {
    if (requestId !== rootRequestId) {
      return;
    }

    root.value = null;
    loadError.value = getErrorMessage(error, '读取工作区目录失败');
  } finally {
    if (requestId === rootRequestId) {
      rootLoading.value = false;
    }
  }
};

const loadDirectoryEntries = async (path: string): Promise<void> => {
  if (loadingPaths[path]) {
    return;
  }

  loadingPaths[path] = true;

  try {
    const payload = await tauriService.listWorkspaceEntries(path, root.value?.rootPath);
    childrenMap[path] = payload.entries;
  } catch (error) {
    const message = getErrorMessage(error, '读取目录失败');
    useMessage().error(message);
    childrenMap[path] = [];
  } finally {
    loadingPaths[path] = false;
  }
};

const toggleRoot = (): void => {
  rootExpanded.value = !rootExpanded.value;
};

const toggleDirectory = async (path: string): Promise<void> => {
  const nextExpanded = !expandedPaths[path];
  expandedPaths[path] = nextExpanded;

  if (!nextExpanded || childrenMap[path] !== undefined) {
    return;
  }

  await loadDirectoryEntries(path);
};

const handleOpenFile = (path: string): void => {
  emit('open-file', path);
};

watch(
  [() => props.isDesktopRuntime, () => props.workspaceRootPath],
  ([ready]) => {
    if (ready) {
      void loadWorkspaceRoot();
    }
  },
  { immediate: true },
);
</script>
