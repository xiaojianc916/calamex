<template>
  <div ref="rootEl" class="explorer-tree-flat" role="presentation" @keydown="onKeydown">
    <template v-if="!shouldVirtualize">
      <WorkspaceTreeRow
        v-for="row in rows"
        :key="row.key"
        :row="row"
        :active-path="activePath"
        :active-dirty="activeDirty"
        :context-menu-path="contextMenuPath"
        :tabbable="row.type === 'entry' && row.entry.path === effectiveFocusPath"
        :inline-create-draft="inlineCreateDraft"
        :inline-rename-draft="inlineRenameDraft"
        @activate="onActivate"
        @contextmenu="(payload) => emit('context-menu', payload)"
        @inline-create-input="(value) => emit('inline-create-input', value)"
        @inline-create-blur="emit('inline-create-blur')"
        @inline-create-confirm="emit('inline-create-confirm')"
        @inline-create-cancel="emit('inline-create-cancel')"
        @inline-rename-input="(value) => emit('inline-rename-input', value)"
        @inline-rename-confirm="emit('inline-rename-confirm')"
        @inline-rename-cancel="emit('inline-rename-cancel')"
      />
    </template>

    <div v-else class="explorer-tree-virtual-sizer" :style="{ height: `${totalSize}px` }">
      <div
        v-for="item in virtualItems"
        :key="item.key"
        :ref="measureRef"
        :data-index="item.index"
        class="explorer-tree-virtual-item"
        :style="{ transform: `translateY(${item.start - scrollMargin}px)` }"
      >
        <WorkspaceTreeRow
          :row="item.row"
          :active-path="activePath"
          :active-dirty="activeDirty"
          :context-menu-path="contextMenuPath"
          :tabbable="item.row.type === 'entry' && item.row.entry.path === effectiveFocusPath"
          :inline-create-draft="inlineCreateDraft"
          :inline-rename-draft="inlineRenameDraft"
          @activate="onActivate"
          @contextmenu="(payload) => emit('context-menu', payload)"
          @inline-create-input="(value) => emit('inline-create-input', value)"
          @inline-create-blur="emit('inline-create-blur')"
          @inline-create-confirm="emit('inline-create-confirm')"
          @inline-create-cancel="emit('inline-create-cancel')"
          @inline-rename-input="(value) => emit('inline-rename-input', value)"
          @inline-rename-confirm="emit('inline-rename-confirm')"
          @inline-rename-cancel="emit('inline-rename-cancel')"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual';
import { useResizeObserver } from '@vueuse/core';
import type { ComponentPublicInstance } from 'vue';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import WorkspaceTreeRow from '@/components/workbench/WorkspaceTreeRow.vue';
import type { TWorkspaceTreeRow } from '@/components/workbench/workspace-tree.types';
import type { IWorkspaceEntry } from '@/types/editor';
import { areFileSystemPathsEqual } from '@/utils/path';
import { filterWorkspaceEntriesByQuery } from '@/utils/workspace';

// 保留原组件名，避免影响 AppSidebar 的引用与测试中的 stub。
defineOptions({ name: 'WorkspaceTreeNode' });

const props = defineProps<{
  entry: IWorkspaceEntry;
  level: number;
  childrenMap: Record<string, IWorkspaceEntry[]>;
  expandedPaths: Set<string>;
  loadingPaths: Record<string, boolean>;
  activePath: string | null;
  activeDirty: boolean;
  contextMenuPath?: string | null;
  searchQuery?: string;
  rootPath: string;
  inlineCreateDraft?: {
    open: boolean;
    parentPath: string | null;
    kind: 'file' | 'directory';
    value: string;
    placeholder: string;
  };
  inlineRenameDraft?: {
    path: string | null;
    value: string;
  };
}>();

const emit = defineEmits<{
  'toggle-directory': [path: string];
  'open-file': [path: string];
  'context-menu': [payload: { event: MouseEvent; entry: IWorkspaceEntry }];
  'inline-create-input': [value: string];
  'inline-create-blur': [];
  'inline-create-confirm': [];
  'inline-create-cancel': [];
  'inline-rename-input': [value: string];
  'inline-rename-confirm': [];
  'inline-rename-cancel': [];
}>();

// 把可见的树结构拍平成一维行列表，以便虚拟化与键盘导航。
const rows = computed<TWorkspaceTreeRow[]>(() => {
  const result: TWorkspaceTreeRow[] = [];
  const normalizedQuery = (props.searchQuery ?? '').trim().toLowerCase();
  const draft = props.inlineCreateDraft;

  const walk = (node: IWorkspaceEntry, level: number): void => {
    const isDirectory = node.kind === 'directory';
    const expanded = isDirectory && props.expandedPaths.has(node.path);

    result.push({
      type: 'entry',
      key: node.path,
      entry: node,
      level,
      expanded,
      showChevron: isDirectory,
    });

    if (!isDirectory || !expanded) {
      return;
    }

    const rawChildren = props.childrenMap[node.path];
    const isLoading = props.loadingPaths[node.path] === true;
    const showInlineCreate =
      draft?.open === true && areFileSystemPathsEqual(draft.parentPath, node.path);

    if (rawChildren === undefined) {
      if (isLoading) {
        result.push({ type: 'loading', key: `${node.path}::loading`, level: level + 1 });
      }
      if (showInlineCreate) {
        result.push({
          type: 'inline-create',
          key: `${node.path}::inline-create`,
          parentPath: node.path,
          level,
        });
      }
      return;
    }

    const visibleChildren = normalizedQuery
      ? filterWorkspaceEntriesByQuery(rawChildren, normalizedQuery, props.childrenMap)
      : rawChildren;

    for (const child of visibleChildren) {
      walk(child, level + 1);
    }

    if (isLoading) {
      result.push({ type: 'loading', key: `${node.path}::loading`, level: level + 1 });
    }

    if (showInlineCreate) {
      result.push({
        type: 'inline-create',
        key: `${node.path}::inline-create`,
        parentPath: node.path,
        level,
      });
    }

    if (visibleChildren.length === 0 && !showInlineCreate && !isLoading) {
      result.push({ type: 'empty', key: `${node.path}::empty`, level: level + 1 });
    }
  };

  walk(props.entry, props.level);
  return result;
});

type TEntryNav = {
  path: string;
  level: number;
  isDirectory: boolean;
  expanded: boolean;
};

const entryNav = computed<TEntryNav[]>(() => {
  const result: TEntryNav[] = [];
  for (const row of rows.value) {
    if (row.type === 'entry') {
      result.push({
        path: row.entry.path,
        level: row.level,
        isDirectory: row.entry.kind === 'directory',
        expanded: row.expanded,
      });
    }
  }
  return result;
});

const focusedPath = ref<string | null>(null);
const effectiveFocusPath = computed<string | null>(
  () => focusedPath.value ?? entryNav.value[0]?.path ?? null,
);

// 虚拟化：仅在行数超过阈值时启用，避免在 happy-dom 零高容器下渲染 0 行。
const VIRTUALIZE_THRESHOLD = 100;
const rootEl = ref<HTMLElement | null>(null);
const scrollMargin = ref(0);
const shouldVirtualize = computed(() => rows.value.length > VIRTUALIZE_THRESHOLD);

const getScrollElement = (): HTMLElement | null => {
  if (!shouldVirtualize.value) {
    return null;
  }
  const root = rootEl.value;
  if (!root) {
    return null;
  }
  return root.closest('.explorer-tree') as HTMLElement | null;
};

const virtualizerOptions = computed(() => ({
  count: rows.value.length,
  getScrollElement,
  estimateSize: () => 28,
  overscan: 12,
  scrollMargin: scrollMargin.value,
  getItemKey: (index: number): string => rows.value[index]?.key ?? String(index),
}));

const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(virtualizerOptions);
const totalSize = computed(() => virtualizer.value.getTotalSize());

const virtualItems = computed(() => {
  const all = rows.value;
  const result: Array<{ key: string; index: number; start: number; row: TWorkspaceTreeRow }> = [];
  for (const item of virtualizer.value.getVirtualItems()) {
    const row = all[item.index];
    if (row) {
      result.push({ key: row.key, index: item.index, start: item.start, row });
    }
  }
  return result;
});

const measureRef = (el: Element | ComponentPublicInstance | null): void => {
  if (el instanceof HTMLElement) {
    virtualizer.value.measureElement(el);
  }
};

const recomputeScrollMargin = (): void => {
  if (!shouldVirtualize.value) {
    scrollMargin.value = 0;
    return;
  }
  const scroller = getScrollElement();
  const sizer = rootEl.value;
  if (!scroller || !sizer) {
    return;
  }
  const scrollerRect = scroller.getBoundingClientRect();
  const sizerRect = sizer.getBoundingClientRect();
  scrollMargin.value = sizerRect.top - scrollerRect.top + scroller.scrollTop;
};

useResizeObserver(rootEl, () => recomputeScrollMargin());
useResizeObserver(
  () => getScrollElement(),
  () => recomputeScrollMargin(),
);
onMounted(() => recomputeScrollMargin());
watch(
  () => rows.value.length,
  () => {
    void nextTick(recomputeScrollMargin);
  },
);

const findRowEl = (path: string): HTMLElement | null => {
  const root = rootEl.value;
  if (!root) {
    return null;
  }
  const candidates = root.querySelectorAll('[data-tree-path]');
  for (const candidate of Array.from(candidates)) {
    if (candidate instanceof HTMLElement && candidate.dataset.treePath === path) {
      return candidate;
    }
  }
  return null;
};

const focusRowByPath = async (path: string): Promise<void> => {
  focusedPath.value = path;
  if (shouldVirtualize.value) {
    const index = rows.value.findIndex((row) => row.type === 'entry' && row.entry.path === path);
    if (index >= 0) {
      virtualizer.value.scrollToIndex(index, { align: 'auto' });
      await nextTick();
    }
  }
  await nextTick();
  findRowEl(path)?.focus();
};

const onActivate = (entry: IWorkspaceEntry): void => {
  focusedPath.value = entry.path;
  if (entry.kind === 'directory') {
    emit('toggle-directory', entry.path);
  } else {
    emit('open-file', entry.path);
  }
};

const onKeydown = (event: KeyboardEvent): void => {
  // 不劫持行内输入框（新建 / 重命名）的按键。
  if (event.target instanceof HTMLInputElement) {
    return;
  }
  const nav = entryNav.value;
  if (nav.length === 0) {
    return;
  }
  const currentPath = focusedPath.value ?? nav[0]?.path ?? null;
  const rawIdx = nav.findIndex((item) => item.path === currentPath);
  const idx = rawIdx < 0 ? 0 : rawIdx;
  const current = nav[idx];
  if (!current) {
    return;
  }

  switch (event.key) {
    case 'ArrowDown': {
      event.preventDefault();
      const next = nav[Math.min(idx + 1, nav.length - 1)];
      if (next) {
        void focusRowByPath(next.path);
      }
      break;
    }
    case 'ArrowUp': {
      event.preventDefault();
      const prev = nav[Math.max(idx - 1, 0)];
      if (prev) {
        void focusRowByPath(prev.path);
      }
      break;
    }
    case 'Home': {
      event.preventDefault();
      const first = nav[0];
      if (first) {
        void focusRowByPath(first.path);
      }
      break;
    }
    case 'End': {
      event.preventDefault();
      const last = nav[nav.length - 1];
      if (last) {
        void focusRowByPath(last.path);
      }
      break;
    }
    case 'ArrowRight': {
      event.preventDefault();
      if (!current.isDirectory) {
        break;
      }
      if (!current.expanded) {
        emit('toggle-directory', current.path);
      } else {
        const next = nav[idx + 1];
        if (next && next.level > current.level) {
          void focusRowByPath(next.path);
        }
      }
      break;
    }
    case 'ArrowLeft': {
      event.preventDefault();
      if (current.isDirectory && current.expanded) {
        emit('toggle-directory', current.path);
        break;
      }
      for (let i = idx - 1; i >= 0; i--) {
        const candidate = nav[i];
        if (candidate && candidate.level < current.level) {
          void focusRowByPath(candidate.path);
          break;
        }
      }
      break;
    }
    case 'Enter': {
      event.preventDefault();
      if (current.isDirectory) {
        emit('toggle-directory', current.path);
      } else {
        emit('open-file', current.path);
      }
      break;
    }
    default:
      break;
  }
};
</script>

<style scoped>
.explorer-tree-flat {
  display: block;
}

.explorer-tree-virtual-sizer {
  position: relative;
  width: 100%;
}

.explorer-tree-virtual-item {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
}
</style>
