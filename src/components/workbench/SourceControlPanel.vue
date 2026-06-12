<template>
  <aside class="source-control-sidebar" aria-label="源代码管理">
    <template v-if="!isDesktopRuntime">
      <div class="source-control-empty-shell">
        <section class="source-control-empty-card">
          <p class="source-control-empty-title">源代码管理仅在桌面端可用</p>
          <p class="source-control-empty-text">
            浏览器预览模式下不会调用本地 Git 仓库，请在 Tauri 桌面端查看真实版本控制状态。
          </p>
        </section>
      </div>
    </template>

    <template v-else-if="!workspaceRootPath">
      <div class="source-control-empty-shell">
        <section class="source-control-empty-card">
          <p class="source-control-empty-title">尚未打开工作区</p>
          <p class="source-control-empty-text">
            先打开一个本地文件夹，再在这里查看分支、变更列表和提交入口。
          </p>
        </section>
      </div>
    </template>

    <template v-else-if="!hasRepository">
      <div class="source-control-empty-shell source-control-setup-shell">
        <section class="source-control-setup-panel" aria-label="源代码管理未初始化引导">
          <header class="source-control-setup-project-header">
            <span class="source-control-setup-project-name">{{ workspaceLabel }}</span>
            <svg class="source-control-setup-chevron" viewBox="0 0 16 16" aria-hidden="true">
              <polyline points="4 6 8 10 12 6" />
            </svg>
          </header>

          <div class="source-control-setup-empty-state">
            <svg class="source-control-setup-empty-icon" viewBox="0 0 48 48" aria-hidden="true">
              <path d="M14 14 L14 34" />
              <path d="M14 22 Q14 28 20 28 L28 28 Q34 28 34 22 L34 17" />
              <circle cx="14" cy="11" r="3.25" class="is-solid" />
              <circle cx="14" cy="37" r="3.25" class="is-solid" />
              <circle cx="34" cy="14" r="3.5" class="is-accent-ring" />
              <circle cx="34" cy="14" r="1.25" class="is-accent-dot" />
            </svg>

            <p class="source-control-setup-empty-title">此项目未启用版本控制</p>
            <p class="source-control-setup-empty-desc">
              初始化 Git 仓库后可追踪脚本变更、查看 diff、回滚历史。
            </p>

            <p v-if="sourceControlActionError" class="source-control-setup-error">
              {{ sourceControlActionError }}
            </p>

            <div class="source-control-setup-actions">
              <button type="button" class="source-control-setup-btn source-control-setup-btn-primary"
                :disabled="isBusy || isLoading" :aria-busy="pendingAction === 'init-repository'"
                @click="handleInitRepository">
                {{ initRepositoryButtonLabel }}
              </button>

              <button type="button" class="source-control-setup-btn source-control-setup-btn-secondary"
                :disabled="isBusy || isLoading" @click="handleOpenCloneGuide">
                从远程克隆...
              </button>
            </div>

            <div class="source-control-setup-divider"></div>

            <button type="button" class="source-control-setup-footnote" @click="handleOpenGitGuide">
              <span>首次使用?查看 Git 入门指南</span>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6 3h7v7" />
                <path d="M13 3L5 11" />
                <path d="M11 10v3H3V5h3" />
              </svg>
            </button>
          </div>
        </section>
      </div>
    </template>

    <template v-else>
      <div class="source-control-branch">
        <svg class="source-control-branch-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6" cy="3" r="2" />
          <circle cx="6" cy="21" r="2" />
          <circle cx="18" cy="12" r="2" />
          <path d="M6 5v14" />
          <path d="M18 10V8a4 4 0 0 0-4-4h-2" />
        </svg>

        <div class="source-control-branch-copy">
          <p class="source-control-branch-name">{{ branchLabel }}</p>
        </div>

        <div class="source-control-branch-sync">
          <span v-if="status.behind > 0">↓ {{ status.behind }}</span>
          <span v-if="status.ahead > 0">↑ {{ status.ahead }}</span>
          <span v-if="status.ahead === 0 && status.behind === 0">{{ workspaceStateLabel }}</span>
        </div>
      </div>

      <nav class="source-control-nav" aria-label="源代码管理导航">
        <button v-for="item in navItems" :key="item.key" type="button" class="source-control-nav-item"
          :class="{ 'is-active': item.active, 'is-inactive': !item.active }" :aria-pressed="item.active"
          @click="selectNavItem(item.key)">
          <svg v-if="item.key === 'changes'" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="m7 10 5-5 5 5" />
            <path d="M12 5v12" />
          </svg>
          <svg v-else-if="item.key === 'history'" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 3v6h6" />
            <path d="M12 7v5l3 3" />
          </svg>
          <svg v-else-if="item.key === 'branches'" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="6" cy="6" r="2" />
            <circle cx="18" cy="4" r="2" />
            <circle cx="18" cy="18" r="2" />
            <path d="M8 6h4a4 4 0 0 1 4 4v6" />
            <path d="M16 6v2" />
          </svg>
          <svg v-else-if="item.key === 'pull-requests'" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 8a6 6 0 0 1-6 6 6 6 0 0 1-6-6" />
            <path d="M6 16a6 6 0 0 0 12 0" />
          </svg>
          <svg v-else-if="item.key === 'stash'" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16" />
            <path d="M7 4h10v6H7z" />
            <path d="M7 13h10v7H7z" />
          </svg>

          <span class="source-control-nav-label">{{ item.label }}</span>
          <span class="source-control-nav-count">{{ item.count }}</span>
        </button>
      </nav>

      <div ref="sourceControlScrollRef" class="source-control-scroll" @scroll.passive="handleSourceControlScroll">
        <template v-if="activeTab === 'changes'">
          <section v-if="!hasVisibleChanges && searchQuery.trim()"
            class="source-control-empty-card source-control-empty-card-inline">
            <p class="source-control-empty-title">{{ emptyChangesTitle }}</p>
            <p class="source-control-empty-text">{{ emptyChangesText }}</p>
          </section>

          <section v-for="section in visibleFilteredSections" :key="section.key" class="source-control-section"
            :class="{ 'is-collapsed': collapsedSections[section.key] }">
            <button type="button" class="source-control-section-header" @click="toggleSectionCollapse(section.key)">
              <svg class="source-control-section-chevron" viewBox="0 0 24 24" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
              <span>{{ section.title }}</span>
              <span class="source-control-section-count">{{ section.entries.length }}</span>
            </button>

            <div class="source-control-file-list">
              <article v-for="entry in section.visibleEntries" :key="section.key + ':' + entry.path"
                class="source-control-file" :class="{
                  'is-active': isActivePath(entry.path),
                  'is-context-target': isContextTargetPath(entry.path),
                }" @contextmenu.prevent.stop="handleEntryContextMenu($event, section.key, entry)">
                <button type="button" class="source-control-file-main" @click="handleOpenFile(entry.path)">
                  <span class="source-control-file-tag" :class="'is-' + resolveEntryTagTone(section.key, entry)">
                    {{ resolveEntryTag(section.key, entry) }}
                  </span>

                  <span class="source-control-file-path">
                    <span class="source-control-file-name">{{ resolveEntryDisplayName(entry) }}</span>
                    <span class="source-control-file-dir">{{ resolveEntryDirectory(entry) }}</span>
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
        </template>

        <SourceControlHistoryTab v-else-if="activeTab === 'history'" :search-query="searchQuery" :is-busy="isBusy" />

        <SourceControlBranchesTab v-else-if="activeTab === 'branches'" :search-query="searchQuery"
          :is-busy="isBusy" :run-with-pending="runWithPending" />

        <SourceControlPullRequestsTab v-else-if="activeTab === 'pull-requests'" :is-busy="isBusy"
          :run-with-pending="runWithPending" />

        <SourceControlStashTab v-else :search-query="searchQuery" :is-busy="isBusy"
          :run-with-pending="runWithPending" />
      </div>

      <footer v-if="activeTab === 'changes'" class="source-control-commit">
        <textarea v-model="commitMessage" class="source-control-commit-input" rows="3" placeholder="Ctrl+Enter 提交"
          :disabled="isBusy" @keydown.ctrl.enter.prevent="handleCommit" @keydown.meta.enter.prevent="handleCommit" />

        <div class="source-control-commit-actions">
          <button type="button" class="source-control-btn source-control-btn-primary" :disabled="!canCommit"
            @click="handleCommit">
            {{ commitButtonLabel }}
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
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import LinearContextMenu from '@/components/common/LinearContextMenu.vue';
import type { ILinearContextMenuItem } from '@/components/common/linear-context-menu.types';
import SourceControlBranchesTab from '@/components/workbench/source-control/SourceControlBranchesTab.vue';
import SourceControlHistoryTab from '@/components/workbench/source-control/SourceControlHistoryTab.vue';
import SourceControlPullRequestsTab from '@/components/workbench/source-control/SourceControlPullRequestsTab.vue';
import SourceControlStashTab from '@/components/workbench/source-control/SourceControlStashTab.vue';
import { useDialog } from '@/composables/useDialog';
import { useMessage } from '@/composables/useMessage';
import {
  type TGitEntryActionKey,
  useSourceControlActions,
} from '@/composables/useSourceControlActions';
import {
  type TGitSectionKey,
  type TSourceControlMenuGroup,
  useSourceControlContextMenu,
} from '@/composables/useSourceControlContextMenu';
import { useGitStore } from '@/store/git';
import type {
  IGitBranchPayload,
  IGitCommitSummaryPayload,
  IGitDiffPreviewRequest,
  IGitFileStatusPayload,
  IGitPullRequestSummaryPayload,
  IGitPullRequestSupportPayload,
  IGitStashEntryPayload,
  TGitChangeKind,
  TGitDiffMode,
} from '@/types/git';
import { openExternalUrl } from '@/utils/browser';
import { writeFileSystemPathToClipboard } from '@/utils/clipboard';
import { toErrorMessage } from '@/utils/error';
import { areFileSystemPathsEqual, getPathBaseName, getPathDirectory } from '@/utils/path';

const GIT_GETTING_STARTED_URL = 'https://git-scm.com/book/zh/v2';
const GIT_CLONE_GUIDE_URL =
  'https://git-scm.com/book/zh/v2/Git-%E5%9F%BA%E7%A1%80-%E8%8E%B7%E5%8F%96-Git-%E4%BB%93%E5%BA%93';
const SOURCE_CONTROL_MENU_WIDTH = 240;
const SOURCE_CONTROL_MENU_HEIGHT = 320;
const SOURCE_CONTROL_MENU_VIEWPORT_PADDING = 12;
const SOURCE_CONTROL_MENU_ROOT_SELECTOR = '.linear-context-menu-root';
const SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE = 120;
const SOURCE_CONTROL_LOAD_MORE_THRESHOLD_PX = 96;

type TGitNavKey = 'changes' | 'history' | 'branches' | 'pull-requests' | 'stash';
interface IGitSection {
  key: TGitSectionKey;
  title: string;
  entries: IGitFileStatusPayload[];
}

interface IVisibleGitSection extends IGitSection {
  visibleEntries: IGitFileStatusPayload[];
  hasMore: boolean;
}

interface IGitEntryAction {
  key: TGitEntryActionKey;
  title: string;
  icon: 'plus' | 'minus' | 'trash';
}

interface IGitNavItem {
  key: TGitNavKey;
  label: string;
  count: number;
  active: boolean;
}

interface ISourceControlMenuState {
  open: boolean;
  x: number;
  y: number;
}

const props = defineProps<{
  isDesktopRuntime: boolean;
  workspaceRootPath: string | null;
  activePath: string | null;
}>();

const emit = defineEmits<{
  'open-file': [path: string];
  'open-diff': [payload: IGitDiffPreviewRequest];
}>();

const gitStore = useGitStore();
const message = useMessage();
const dialog = useDialog();
const commitMessage = ref('');
const searchQuery = ref('');
const activeTab = ref<TGitNavKey>('changes');
const sourceControlScrollRef = ref<HTMLElement | null>(null);
const pendingAction = ref<string | null>(null);
const sourceControlActionError = ref<string | null>(null);
const scmMenuState = reactive<ISourceControlMenuState>({
  open: false,
  x: 0,
  y: 0,
});
const scmContextTargetPath = ref<string | null>(null);
const scmMenuGroups = ref<TSourceControlMenuGroup[]>([]);
const collapsedSections = reactive<Record<TGitSectionKey, boolean>>({
  conflicts: false,
  staged: false,
  changes: false,
  untracked: false,
});
const visibleEntryLimits = reactive<Record<TGitSectionKey, number>>({
  conflicts: SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE,
  staged: SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE,
  changes: SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE,
  untracked: SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE,
});

const resetVisibleEntryLimits = (): void => {
  visibleEntryLimits.conflicts = SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE;
  visibleEntryLimits.staged = SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE;
  visibleEntryLimits.changes = SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE;
  visibleEntryLimits.untracked = SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE;
};

const status = computed(() => gitStore.status);
const isLoading = computed(() => gitStore.isLoading);
const hasRepository = computed(
  () => status.value.available && Boolean(status.value.repositoryRootPath),
);
const isBusy = computed(() => pendingAction.value !== null);
const totalChangeCount = computed(
  () =>
    status.value.stagedCount +
    status.value.unstagedCount +
    status.value.untrackedCount +
    status.value.conflictedCount,
);
const workspaceLabel = computed(() => {
  const workspaceRootPath = props.workspaceRootPath;
  if (!workspaceRootPath) {
    return '当前项目';
  }

  return getPathBaseName(workspaceRootPath) || workspaceRootPath;
});
const initRepositoryButtonLabel = '初始化 Git 仓库';

const resetSectionCollapse = (): void => {
  collapsedSections.conflicts = false;
  collapsedSections.staged = false;
  collapsedSections.changes = false;
  collapsedSections.untracked = false;
};

const runWithPending = async (key: string, task: () => Promise<void>): Promise<boolean> => {
  if (pendingAction.value) {
    return false;
  }

  pendingAction.value = key;

  try {
    await task();
    return true;
  } finally {
    pendingAction.value = null;
  }
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

const syncRepositoryStatus = async (
  workspaceRootPath: string,
  options?: {
    showSuccessMessage?: boolean;
    showErrorMessage?: boolean;
  },
): Promise<void> => {
  try {
    const didRun = await runWithPending('refresh', async () => {
      await gitStore.refreshRepositoryStatus(workspaceRootPath);
    });

    if (!didRun) {
      return;
    }

    if (hasRepository.value && activeTab.value !== 'changes') {
      await ensureActiveTabData(activeTab.value);
    }

    if (options?.showSuccessMessage) {
      message.success('Git 状态已刷新');
    }
  } catch (error) {
    if (options?.showErrorMessage) {
      message.error(toErrorMessage(error, '刷新 Git 状态失败'));
    }
  }
};

async function ensureActiveTabData(tabKey: TGitNavKey): Promise<void> {
  if (!hasRepository.value || tabKey === 'changes') {
    return;
  }

  try {
    if (tabKey === 'history') {
      await gitStore.loadCommitHistory();
      return;
    }

    if (tabKey === 'branches') {
      await gitStore.loadBranches();
      return;
    }

    if (tabKey === 'stash') {
      await gitStore.loadStashes();
      return;
    }

    await gitStore.ensurePullRequestsLoaded(pullRequestStateFilter.value);
  } catch (error) {
    const fallbackMessage =
      tabKey === 'history'
        ? '读取 Git 提交历史失败'
        : tabKey === 'branches'
          ? '读取 Git 分支失败'
          : tabKey === 'stash'
            ? '读取 Git 贮藏失败'
            : '读取 Pull Request 支持信息失败';
    message.error(toErrorMessage(error, fallbackMessage));
  }
}

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
// 放弃全部的目标集合与可暂存集合完全一致(已跟踪改动 + 未跟踪文件),复用同一个 computed。
const discardableEntries = stageableEntries;
const stagedPaths = computed(() => stagedEntries.value.map((entry) => entry.path));
const canStageAll = computed(() => stageableEntries.value.length > 0 && !isBusy.value);
const canUnstageAll = computed(() => stagedPaths.value.length > 0 && !isBusy.value);
const canDiscardAll = computed(() => discardableEntries.value.length > 0 && !isBusy.value);
const commitHistoryEntries = computed<IGitCommitSummaryPayload[]>(() => gitStore.commitHistory);
const branchEntries = computed<IGitBranchPayload[]>(() => gitStore.branches);
const stashEntries = computed<IGitStashEntryPayload[]>(() => gitStore.stashes);
const pullRequestSupport = computed<IGitPullRequestSupportPayload>(
  () => gitStore.pullRequestSupport,
);
const pullRequests = computed<IGitPullRequestSummaryPayload[]>(() => gitStore.pullRequests);
const pullRequestStateFilter = computed(() => gitStore.pullRequestStateFilter);
const sections = computed<IGitSection[]>(() => {
  const nextSections: IGitSection[] = [];

  if (conflictedEntries.value.length > 0) {
    nextSections.push({
      key: 'conflicts',
      title: '冲突',
      entries: conflictedEntries.value,
    });
  }

  if (stagedEntries.value.length > 0) {
    nextSections.push({
      key: 'staged',
      title: '已暂存',
      entries: stagedEntries.value,
    });
  }

  if (changedEntries.value.length > 0) {
    nextSections.push({
      key: 'changes',
      title: '变更',
      entries: changedEntries.value,
    });
  }

  if (untrackedEntries.value.length > 0) {
    nextSections.push({
      key: 'untracked',
      title: '未跟踪',
      entries: untrackedEntries.value,
    });
  }

  return nextSections;
});

const filteredSections = computed<IGitSection[]>(() => {
  const keyword = searchQuery.value.trim().toLowerCase();
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

      return {
        ...section,
        entries,
      };
    })
    .filter((section) => section.entries.length > 0);
});

const visibleFilteredSections = computed<IVisibleGitSection[]>(() =>
  filteredSections.value.map((section) => {
    const limit = visibleEntryLimits[section.key] ?? SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE;
    const visibleEntries = section.entries.slice(0, limit);
    return {
      ...section,
      visibleEntries,
      hasMore: visibleEntries.length < section.entries.length,
    };
  }),
);

const hasHiddenSourceControlEntries = computed(() =>
  visibleFilteredSections.value.some((section) => section.hasMore),
);

const loadMoreVisibleSourceControlEntries = (): void => {
  if (!hasHiddenSourceControlEntries.value) {
    return;
  }

  for (const section of filteredSections.value) {
    const currentLimit = visibleEntryLimits[section.key] ?? SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE;
    if (currentLimit >= section.entries.length) {
      continue;
    }

    visibleEntryLimits[section.key] = Math.min(
      currentLimit + SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE,
      section.entries.length,
    );
  }
};

const handleSourceControlScroll = (event: Event): void => {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
  if (distanceFromBottom <= SOURCE_CONTROL_LOAD_MORE_THRESHOLD_PX) {
    loadMoreVisibleSourceControlEntries();
  }
};

const hasVisibleChanges = computed(() =>
  filteredSections.value.some((section) => section.entries.length > 0),
);
const canCommit = computed(
  () => status.value.stagedCount > 0 && commitMessage.value.trim().length > 0 && !isBusy.value,
);

const branchLabel = computed(() => {
  if (status.value.isDetached) {
    return `detached @ ${status.value.headShortOid ?? 'HEAD'}`;
  }

  return status.value.headShortName ?? status.value.headBranchName ?? '未知分支';
});

const workspaceStateLabel = computed(() => {
  if (status.value.conflictedCount > 0) {
    return '存在冲突';
  }

  if (status.value.isClean) {
    return '工作区干净';
  }

  return `${totalChangeCount.value} 项变更`;
});

const navItems = computed<IGitNavItem[]>(() => [
  {
    key: 'changes',
    label: '变更',
    count: totalChangeCount.value,
    active: activeTab.value === 'changes',
  },
  {
    key: 'history',
    label: '历史',
    count: commitHistoryEntries.value.length || (status.value.lastCommit ? 1 : 0),
    active: activeTab.value === 'history',
  },
  {
    key: 'branches',
    label: '分支',
    count: branchEntries.value.length || (status.value.headBranchName ? 1 : 0),
    active: activeTab.value === 'branches',
  },
  {
    key: 'pull-requests',
    label: '拉取请求',
    count: pullRequestSupport.value.available ? pullRequests.value.length : 0,
    active: activeTab.value === 'pull-requests',
  },
  {
    key: 'stash',
    label: '贮藏',
    count: stashEntries.value.length,
    active: activeTab.value === 'stash',
  },
]);

const emptyChangesTitle = computed(() => '没有匹配的变更');

const emptyChangesText = computed(() => '试试搜索文件名、目录、状态，或者清空搜索关键字。');

const commitButtonLabel = computed(() =>
  pendingAction.value === 'commit' ? '提交中...' : '提交更改',
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
    return [
      {
        key: 'unstage',
        title: resolveEntryActionTitle(sectionKey, entry),
        icon: 'minus',
      },
    ];
  }

  return [
    {
      key: 'discard',
      title: `放弃更改 ${entry.fileName}`,
      icon: 'trash',
    },
    {
      key: 'stage',
      title: resolveEntryActionTitle(sectionKey, entry),
      icon: 'plus',
    },
  ];
};

const isActivePath = (path: string): boolean => areFileSystemPathsEqual(path, props.activePath);

const isContextTargetPath = (path: string): boolean =>
  !isActivePath(path) && areFileSystemPathsEqual(path, scmContextTargetPath.value);

const toggleSectionCollapse = (key: TGitSectionKey): void => {
  collapsedSections[key] = !collapsedSections[key];
};

const selectNavItem = (key: TGitNavKey): void => {
  activeTab.value = key;
  closeSourceControlMenu();
};

const handleOpenCloneGuide = (): void => {
  openExternalUrl(GIT_CLONE_GUIDE_URL);
};

const handleOpenGitGuide = (): void => {
  openExternalUrl(GIT_GETTING_STARTED_URL);
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
  handleInitRepository,
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
  runWithPending,
  setSourceControlActionError: (value) => {
    sourceControlActionError.value = value;
  },
  syncRepositoryStatus,
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
    {
      x: event.clientX,
      y: event.clientY,
    },
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
    searchQuery.value = '';
    activeTab.value = 'changes';
    sourceControlActionError.value = null;
    closeSourceControlMenu();
    resetSectionCollapse();
    resetVisibleEntryLimits();
  },
);

watch([() => searchQuery.value, () => status.value.files.length], () => {
  resetVisibleEntryLimits();
});

watch(
  () => activeTab.value,
  (nextTab) => {
    if (!hasRepository.value || nextTab === 'changes') {
      return;
    }

    void ensureActiveTabData(nextTab);
  },
);

watch(
  [() => props.isDesktopRuntime, () => props.workspaceRootPath],
  ([ready, workspaceRootPath]) => {
    if (!ready || !workspaceRootPath) {
      gitStore.reset();
      sourceControlActionError.value = null;
      return;
    }
    void syncRepositoryStatus(workspaceRootPath);
  },
  { immediate: true },
);
</script>
