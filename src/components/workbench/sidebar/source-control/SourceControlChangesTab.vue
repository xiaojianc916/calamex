<template>
  <div class="source-control-scroll">
    <section v-if="!hasVisibleChanges && searchQuery.trim()"
      class="source-control-empty-card source-control-empty-card-inline">
      <p class="source-control-empty-title"> emptyChangesTitle </p>
      <p class="source-control-empty-text"> emptyChangesText </p>
    </section>

    <section v-for="section in filteredSections" :key="section.key" class="source-control-section"
      :class="{ 'is-collapsed': collapsedSections[section.key] }">
      <button type="button" class="source-control-section-header" @click="toggleSectionCollapse(section.key)">
        <svg class="source-control-section-chevron" viewBox="0 0 24 24" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span> section.title </span>
        <span class="source-control-section-count"> section.entries.length </span>
      </button>

      <div class="source-control-file-list">
        <article v-for="entry in section.entries" :key="section.key + ':' + entry.path"
          class="source-control-file" :class="{
            'is-active': isActivePath(entry.path),
            'is-context-target': isContextTargetPath(entry.path),
          }" @contextmenu.prevent.stop="handleEntryContextMenu($event, section.key, entry)">
          <button type="button" class="source-control-file-main" @click="handleOpenFile(entry.path)">
            <span class="source-control-file-tag" :class="'is-' + resolveEntryTagTone(section.key, entry)">
               resolveEntryTag(section.key, entry) 
            </span>

            <span class="source-control-file-path">
              <span class="source-control-file-name"> resolveEntryDisplayName(entry) </span>
              <span class="source-control-file-dir"> resolveEntryDirectory(entry) </span>
            </span>
          </button>

          <div v-if="resolveEntryActions(section.key, entry).length > 0" class="source-control-file-actions">
            <button v-for="action in resolveEntryActions(section.key, entry)"
              :key="section.key + ':' + entry.path + ':' + action.key" type="button"
              class="source-control-icon-btn" :disabled="isBusy" :aria-label="action.title" :title="action.title"
              @click.stop="handleEntryAction(action.key, section.key, entry)">
              <svg v-if="action.icon === 'plus'" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              <svg v-else-if="action.icon === 'minus'" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12h14" />
              </svg>
              <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-2 14H7L5 6" />
              </svg>
            </button>
          </div>
        </article>
      </div>
    </section>
  </div>

  <footer class="source-control-commit">
    <textarea v-model="commitMessage" class="source-control-commit-input" rows="3" placeholder="Ctrl+Enter 提交"
      :disabled="isBusy" @keydown.ctrl.enter.prevent="handleCommit" @keydown.meta.enter.prevent="handleCommit" />

    <div class="source-control-commit-actions">
      <button type="button" class="source-control-btn source-control-btn-primary" :disabled="!canCommit"
        @click="handleCommit">
         commitButtonLabel 
      </button>

      <button type="button" class="source-control-btn source-control-btn-icon" :disabled="isBusy"
        aria-label="更多 Git 操作" title="更多 Git 操作" @click="handleMoreActions">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
    </div>
  </footer>

  <LinearContextMenu :open="scmMenuState.open" :x="scmMenuState.x" :y="scmMenuState.y" :groups="scmMenuGroups"
    theme="dark" submenu-direction="right" @select="handleContextMenuSelect" />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import LinearContextMenu from '@/components/common/LinearContextMenu.vue';
import type { ILinearContextMenuItem } from '@/components/common/linear-context-menu.types';
import { useDialog } from '@/composables/useDialog';
import { useMessage } from '@/composables/useMessage';
import { type TGitEntryActionKey, useSourceControlActions } from '@/composables/useSourceControlActions';
import {
  type TGitSectionKey,
  type TSourceControlMenuGroup,
  useSourceControlContextMenu,
} from '@/composables/useSourceControlContextMenu';
import { useGitStore } from '@/store/git';
import type {
  IGitDiffPreviewRequest,
  IGitFileStatusPayload,
  TGitChangeKind,
  TGitDiffMode,
} from '@/types/git';
import { writeFileSystemPathToClipboard } from '@/utils/clipboard';
import { areFileSystemPathsEqual, getPathBaseName, getPathDirectory } from '@/utils/path';

const SOURCE_CONTROL_MENU_WIDTH = 240;
const SOURCE_CONTROL_MENU_HEIGHT = 320;
const SOURCE_CONTROL_MENU_VIEWPORT_PADDING = 12;
const SOURCE_CONTROL_MENU_ROOT_SELECTOR = '.linear-context-menu-root';

interface IGitSection {
  key: TGitSectionKey;
  title: string;
  entries: IGitFileStatusPayload[];
}

interface IGitEntryAction {
  key: TGitEntryActionKey;
  title: string;
  icon: 'plus' | 'minus' | 'trash';
}

interface ISourceControlMenuState {
  open: boolean;
  x: number;
  y: number;
}

const props = defineProps<{
  workspaceRootPath: string | null;
  activePath: string | null;
  searchQuery: string;
  pendingAction: string | null;
  runWithPending: (key: string, task: () => Promise<void>) => Promise<boolean>;
  syncRepositoryStatus: (
    workspaceRootPath: string,
    options?: { showSuccessMessage?: boolean; showErrorMessage?: boolean },
  ) => Promise<void>;
  setSourceControlActionError: (value: string | null) => void;
}>();

const emit = defineEmits<{
  'open-file': [path: string];
  'open-diff': [payload: IGitDiffPreviewRequest];
}>();

const gitStore = useGitStore();
const message = useMessage();
const dialog = useDialog();
const commitMessage = ref('');
const scmMenuState = reactive<ISourceControlMenuState>({ open: false, x: 0, y: 0 });
const scmContextTargetPath = ref<string | null>(null);
const scmMenuGroups = ref<TSourceControlMenuGroup[]>([]);
const collapsedSections = reactive<Record<TGitSectionKey, boolean>>({
  conflicts: false,
  staged: false,
  changes: false,
  untracked: false,
});

const status = computed(() => gitStore.status);
const isBusy = computed(() => props.pendingAction !== null);

const resetSectionCollapse = (): void => {
  collapsedSections.conflicts = false;
  collapsedSections.staged = false;
  collapsedSections.changes = false;
  collapsedSections.untracked = false;
};

const clampMenuPosition = (clientX: number, clientY: number): { x: number; y: number } => {
  if (typeof window === 'undefined') {
    return { x: clientX, y: clientY };
  }

  return {
    x: Math.min(
      clientX,
      Math.max(
        SOURCE_CONTROL_MENU_VIEWPORT_PADDING,
        window.innerWidth - SOURCE_CONTROL_MENU_WIDTH - SOURCE_CONTROL_MENU_VIEWPORT_PADDING,
      ),
    ),
    y: Math.min(
      clientY,
      Math.max(
        SOURCE_CONTROL_MENU_VIEWPORT_PADDING,
        window.innerHeight - SOURCE_CONTROL_MENU_HEIGHT - SOURCE_CONTROL_MENU_VIEWPORT_PADDING,
      ),
    ),
  };
};

const closeSourceControlMenu = (): void => {
  scmMenuState.open = false;
  scmContextTargetPath.value = null;
  scmMenuGroups.value = [];
};

const openSourceControlMenu = (
  point: { x: number; y: number },
  groups: TSourceControlMenuGroup[],
  contextTargetPath: string | null = null,
): void => {
  const nextPoint = clampMenuPosition(point.x, point.y);
  scmMenuState.x = nextPoint.x;
  scmMenuState.y = nextPoint.y;
  scmMenuGroups.value = groups;
  scmMenuState.open = groups.some((group) => group.items.length > 0);
  scmContextTargetPath.value = scmMenuState.open ? contextTargetPath : null;
};

const conflictedEntries = computed(() => status.value.files.filter((entry) => entry.isConflicted));
const stagedEntries = computed(() =>
  status.value.files.filter((entry) => entry.indexStatus !== null && !entry.isConflicted),
);
const changedEntries = computed(() =>
  status.value.files.filter(
    (entry) =>
      entry.worktreeStatus !== null && entry.worktreeStatus !== 'untracked' && !entry.isConflicted,
  ),
);
const untrackedEntries = computed(() => status.value.files.filter((entry) => entry.isUntracked));
const stageableEntries = computed(() => [...changedEntries.value, ...untrackedEntries.value]);
const discardableEntries = stageableEntries;
const stagedPaths = computed(() => stagedEntries.value.map((entry) => entry.path));
const canStageAll = computed(() => stageableEntries.value.length > 0 && !isBusy.value);
const canUnstageAll = computed(() => stagedPaths.value.length > 0 && !isBusy.value);
const canDiscardAll = computed(() => discardableEntries.value.length > 0 && !isBusy.value);

const sections = computed<IGitSection[]>(() => {
  const nextSections: IGitSection[] = [];
  if (conflictedEntries.value.length > 0) {
    nextSections.push({ key: 'conflicts', title: '冲突', entries: conflictedEntries.value });
  }
  if (stagedEntries.value.length > 0) {
    nextSections.push({ key: 'staged', title: '已暂存', entries: stagedEntries.value });
  }
  if (changedEntries.value.length > 0) {
    nextSections.push({ key: 'changes', title: '变更', entries: changedEntries.value });
  }
  if (untrackedEntries.value.length > 0) {
    nextSections.push({ key: 'untracked', title: '未跟踪', entries: untrackedEntries.value });
  }
  return nextSections;
});

const filteredSections = computed<IGitSection[]>(() => {
  const keyword = props.searchQuery.trim().toLowerCase();
  if (!keyword) {
    return sections.value;
  }

  return sections.value
    .map((section) => {
      const matchesSection = section.title.toLowerCase().includes(keyword);
      const entries = matchesSection
        ? section.entries
        : section.entries.filter((entry) => {
            const haystack = [
              entry.fileName,
              entry.relativePath,
              entry.previousRelativePath ?? '',
              entry.indexStatus ?? '',
              entry.worktreeStatus ?? '',
            ]
              .join(' ')
              .toLowerCase();

            return haystack.includes(keyword);
          });

      return { ...section, entries };
    })
    .filter((section) => section.entries.length > 0);
});

const hasVisibleChanges = computed(() =>
  filteredSections.value.some((section) => section.entries.length > 0),
);
const canCommit = computed(
  () => status.value.stagedCount > 0 && commitMessage.value.trim().length > 0 && !isBusy.value,
);
const emptyChangesTitle = computed(() => '没有匹配的变更');
const emptyChangesText = computed(() => '试试搜索文件名、目录、状态，或者清空搜索关键字。');
const commitButtonLabel = computed(() =>
  props.pendingAction === 'commit' ? '提交中...' : '提交更改',
);

const resolveEntryKind = (
  sectionKey: TGitSectionKey,
  entry: IGitFileStatusPayload,
): TGitChangeKind => {
  switch (sectionKey) {
    case 'staged':
      return entry.indexStatus ?? 'modified';
    case 'changes':
      return entry.worktreeStatus ?? 'modified';
    case 'untracked':
      return 'untracked';
    default:
      return 'conflicted';
  }
};

const resolveEntryTag = (sectionKey: TGitSectionKey, entry: IGitFileStatusPayload): string => {
  switch (resolveEntryKind(sectionKey, entry)) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'typechange':
      return 'T';
    case 'untracked':
      return 'U';
    case 'conflicted':
      return '!';
    default:
      return 'M';
  }
};

const resolveEntryTagTone = (sectionKey: TGitSectionKey, entry: IGitFileStatusPayload): string => {
  switch (resolveEntryKind(sectionKey, entry)) {
    case 'added':
      return 'added';
    case 'deleted':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    case 'typechange':
      return 'typechange';
    case 'untracked':
      return 'untracked';
    case 'conflicted':
      return 'conflicted';
    default:
      return 'modified';
  }
};

const resolveEntryDisplayName = (entry: IGitFileStatusPayload): string => {
  if (entry.fileName) {
    return entry.fileName;
  }
  return getPathBaseName(entry.relativePath) || entry.relativePath;
};

const resolveEntryDirectory = (entry: IGitFileStatusPayload): string => {
  if (entry.previousRelativePath) {
    return `${entry.previousRelativePath} → ${entry.relativePath}`;
  }
  return getPathDirectory(entry.relativePath);
};

const resolveEntryActionTitle = (
  sectionKey: TGitSectionKey,
  entry: IGitFileStatusPayload,
): string => {
  if (sectionKey === 'staged') {
    return `取消暂存 ${entry.fileName}`;
  }
  return `暂存 ${entry.fileName}`;
};

const resolveEntryActions = (
  sectionKey: TGitSectionKey,
  entry: IGitFileStatusPayload,
): IGitEntryAction[] => {
  if (sectionKey === 'conflicts') {
    return [];
  }
  if (sectionKey === 'staged') {
    return [{ key: 'unstage', title: resolveEntryActionTitle(sectionKey, entry), icon: 'minus' }];
  }
  return [
    { key: 'discard', title: `放弃更改 ${entry.fileName}`, icon: 'trash' },
    { key: 'stage', title: resolveEntryActionTitle(sectionKey, entry), icon: 'plus' },
  ];
};

const isActivePath = (path: string): boolean => areFileSystemPathsEqual(path, props.activePath);

const isContextTargetPath = (path: string): boolean =>
  !isActivePath(path) && areFileSystemPathsEqual(path, scmContextTargetPath.value);

const toggleSectionCollapse = (key: TGitSectionKey): void => {
  collapsedSections[key] = !collapsedSections[key];
};

const handleOpenFile = (path: string): void => {
  emit('open-file', path);
};

const resolveDiffMode = (sectionKey: TGitSectionKey): TGitDiffMode =>
  sectionKey === 'staged' ? 'staged' : 'worktree';

const handleOpenDiff = (sectionKey: TGitSectionKey, entry: IGitFileStatusPayload): void => {
  const repositoryRootPath = status.value.repositoryRootPath;
  if (!repositoryRootPath) {
    message.warning('当前工作区未检测到 Git 仓库。');
    return;
  }
  emit('open-diff', {
    repositoryRootPath,
    path: entry.path,
    mode: resolveDiffMode(sectionKey),
  });
};

const {
  handleRefresh,
  handleStageAll,
  handleUnstageAll,
  handleDiscardAll,
  handleCommit,
  handleDiscardEntry,
  handleSectionAction,
  handleEntryAction,
} = useSourceControlActions({
  gitStore,
  message,
  dialog,
  getWorkspaceRootPath: () => props.workspaceRootPath,
  getStageableEntries: () => stageableEntries.value,
  getStagedPaths: () => stagedPaths.value,
  getDiscardableEntries: () => discardableEntries.value,
  getStagedCount: () => status.value.stagedCount,
  getCommitMessage: () => commitMessage.value,
  setCommitMessage: (value) => {
    commitMessage.value = value;
  },
  runWithPending: props.runWithPending,
  setSourceControlActionError: props.setSourceControlActionError,
  syncRepositoryStatus: props.syncRepositoryStatus,
});

const {
  buildRepositoryMenuGroups,
  buildEntryMenuGroups,
  handleContextMenuSelect: dispatchContextMenuSelect,
} = useSourceControlContextMenu({
  isBusy: () => isBusy.value,
  canStageAll: () => canStageAll.value,
  canUnstageAll: () => canUnstageAll.value,
  canDiscardAll: () => canDiscardAll.value,
  canCommit: () => canCommit.value,
  onRefresh: handleRefresh,
  onStageAll: handleStageAll,
  onUnstageAll: handleUnstageAll,
  onDiscardAll: handleDiscardAll,
  onCommit: handleCommit,
  onOpenDiff: handleOpenDiff,
  onOpenFile: handleOpenFile,
  onCopyPath: async (path) => {
    await writeFileSystemPathToClipboard(path);
    message.success('已复制文件路径');
  },
  onStageEntry: handleSectionAction,
  onUnstageEntry: async (entry) => {
    await handleSectionAction('staged', entry);
  },
  onDiscardEntry: handleDiscardEntry,
});

const handleMoreActions = (event: MouseEvent): void => {
  const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const rect = target?.getBoundingClientRect();
  openSourceControlMenu(
    {
      x: rect ? rect.right - SOURCE_CONTROL_MENU_WIDTH : event.clientX,
      y: rect ? rect.bottom + 6 : event.clientY,
    },
    buildRepositoryMenuGroups(),
    null,
  );
};

const handleEntryContextMenu = (
  event: MouseEvent,
  sectionKey: TGitSectionKey,
  entry: IGitFileStatusPayload,
): void => {
  openSourceControlMenu(
    { x: event.clientX, y: event.clientY },
    buildEntryMenuGroups(sectionKey, entry),
    entry.path,
  );
};

const handleContextMenuSelect = async (item: ILinearContextMenuItem): Promise<void> => {
  closeSourceControlMenu();
  await dispatchContextMenuSelect(item);
};

const isTargetInsideSourceControlMenu = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(SOURCE_CONTROL_MENU_ROOT_SELECTOR) !== null;

const handleWindowPointerDown = (event: PointerEvent): void => {
  if (!scmMenuState.open || isTargetInsideSourceControlMenu(event.target)) {
    return;
  }
  closeSourceControlMenu();
};

const handleWindowKeydown = (event: KeyboardEvent): void => {
  if (scmMenuState.open && event.key === 'Escape') {
    closeSourceControlMenu();
  }
};

const handleWindowResize = (): void => {
  if (scmMenuState.open) {
    closeSourceControlMenu();
  }
};

onMounted(() => {
  if (typeof window === 'undefined') {
    return;
  }
  window.addEventListener('pointerdown', handleWindowPointerDown, true);
  window.addEventListener('keydown', handleWindowKeydown);
  window.addEventListener('resize', handleWindowResize);
  window.addEventListener('blur', handleWindowResize);
});

onBeforeUnmount(() => {
  if (typeof window === 'undefined') {
    return;
  }
  window.removeEventListener('pointerdown', handleWindowPointerDown, true);
  window.removeEventListener('keydown', handleWindowKeydown);
  window.removeEventListener('resize', handleWindowResize);
  window.removeEventListener('blur', handleWindowResize);
});

watch(
  () => props.workspaceRootPath,
  () => {
    commitMessage.value = '';
    resetSectionCollapse();
    closeSourceControlMenu();
  },
);
</script>
