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
      <div class="source-control-empty-shell">
        <section class="source-control-empty-card">
          <div class="source-control-empty-head">
            <div>
              <p class="source-control-empty-title">当前工作区未检测到 Git 仓库</p>
              <p class="source-control-empty-text">
                {{ status.message ?? '请确认当前目录已经执行 git init，或工作区位于已有仓库内部。' }}
              </p>
              <p class="source-control-empty-text">当前工作区：{{ workspaceRootPath }}</p>
              <p class="source-control-empty-text">
                Git 只会检测软件里当前打开的文件夹。请先通过“文件 / 打开文件夹”打开仓库根目录，再回到左侧“源代码管理”。
              </p>
            </div>

            <button
              type="button"
              class="source-control-btn source-control-btn-ghost"
              :disabled="isBusy"
              @click="handleRefresh(true)"
            >
              刷新
            </button>
          </div>
        </section>
      </div>
    </template>

    <template v-else>
      <header class="source-control-repo">
        <div class="source-control-repo-copy">
          <p class="source-control-repo-name">{{ status.repositoryName ?? 'Git 仓库' }}</p>
        </div>

        <span class="source-control-repo-chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </header>

      <div class="source-control-search">
        <label class="source-control-search-box">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input v-model="searchQuery" type="text" placeholder="搜索变更、分支……" />
          <span class="source-control-kbd">⌘K</span>
        </label>
      </div>

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
        <div
          v-for="item in navItems"
          :key="item.key"
          class="source-control-nav-item"
          :class="{ 'is-active': item.active, 'is-inactive': !item.active }"
        >
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
        </div>
      </nav>

      <div class="source-control-scroll">
        <section v-if="!hasVisibleChanges" class="source-control-empty-card source-control-empty-card-inline">
          <p class="source-control-empty-title">{{ emptyChangesTitle }}</p>
          <p class="source-control-empty-text">{{ emptyChangesText }}</p>
        </section>

        <section
          v-for="section in filteredSections"
          :key="section.key"
          class="source-control-section"
          :class="{ 'is-collapsed': collapsedSections[section.key] }"
        >
          <button
            type="button"
            class="source-control-section-header"
            @click="toggleSectionCollapse(section.key)"
          >
            <svg class="source-control-section-chevron" viewBox="0 0 24 24" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span>{{ section.title }}</span>
            <span class="source-control-section-count">{{ section.entries.length }}</span>
          </button>

          <div class="source-control-file-list">
            <article
              v-for="entry in section.entries"
              :key="`${section.key}:${entry.path}`"
              class="source-control-file"
              :class="{ 'is-active': isActivePath(entry.path) }"
            >
              <button type="button" class="source-control-file-main" @click="handleOpenFile(entry.path)">
                <span
                  class="source-control-file-tag"
                  :class="`is-${resolveEntryTagTone(section.key, entry)}`"
                >
                  {{ resolveEntryTag(section.key, entry) }}
                </span>

                <span class="source-control-file-path">
                  <span class="source-control-file-name">{{ resolveEntryDisplayName(entry) }}</span>
                  <span class="source-control-file-dir">{{ resolveEntryDirectory(entry) }}</span>
                </span>
              </button>

              <div v-if="resolveEntryActions(section.key, entry).length > 0" class="source-control-file-actions">
                <button
                  v-for="action in resolveEntryActions(section.key, entry)"
                  :key="`${section.key}:${entry.path}:${action.key}`"
                  type="button"
                  class="source-control-icon-btn"
                  :disabled="isBusy"
                  :aria-label="action.title"
                  :title="action.title"
                  @click.stop="handleEntryAction(action.key, section.key, entry)"
                >
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
        <textarea
          v-model="commitMessage"
          class="source-control-commit-input"
          rows="3"
          placeholder="提交信息（⌘↵ 提交）"
          :disabled="isBusy"
          @keydown.ctrl.enter.prevent="handleCommit"
          @keydown.meta.enter.prevent="handleCommit"
        />

        <div class="source-control-commit-actions">
          <button
            type="button"
            class="source-control-btn source-control-btn-primary"
            :disabled="!canCommit"
            @click="handleCommit"
          >
            {{ commitButtonLabel }}
          </button>

          <button
            type="button"
            class="source-control-btn source-control-btn-icon"
            :disabled="isBusy"
            aria-label="更多选项"
            title="更多选项"
            @click="handleMoreActions"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </footer>

      <div class="source-control-statusbar">
        <span class="source-control-status-dot" :class="`is-${statusDotTone}`"></span>
        <span>{{ statusbarText }}</span>
      </div>
    </template>
  </aside>
</template>

<script setup lang="ts">
import { useMessage } from '@/composables/useMessage';
import { useGitStore } from '@/store/git';
import type { IGitFileStatusPayload, TGitChangeKind } from '@/types/git';
import { computed, reactive, ref, watch } from 'vue';

type TGitSectionKey = 'conflicts' | 'staged' | 'changes' | 'untracked';
type TGitNavKey = 'changes' | 'history' | 'branches' | 'pull-requests' | 'stash';
type TGitEntryActionKey = 'stage' | 'unstage' | 'discard';
type TStatusTone = 'success' | 'warning' | 'danger' | 'loading';

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

interface IGitNavItem {
  key: TGitNavKey;
  label: string;
  count: number;
  active: boolean;
}

const props = defineProps<{
  isDesktopRuntime: boolean;
  workspaceRootPath: string | null;
  activePath: string | null;
}>();

const emit = defineEmits<{
  'open-file': [path: string];
}>();

const gitStore = useGitStore();
const message = useMessage();
const commitMessage = ref('');
const searchQuery = ref('');
const pendingAction = ref<string | null>(null);
const lastSyncedAt = ref<number | null>(null);
const collapsedSections = reactive<Record<TGitSectionKey, boolean>>({
  conflicts: false,
  staged: false,
  changes: false,
  untracked: false,
});

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

const normalizePath = (value: string | null | undefined): string => {
  if (!value) {
    return '';
  }

  const normalized = value.replace(/\\/g, '/');
  const isWindowsStyle = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//');
  return isWindowsStyle ? normalized.toLowerCase() : normalized;
};

const getErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const resetSectionCollapse = (): void => {
  collapsedSections.conflicts = false;
  collapsedSections.staged = false;
  collapsedSections.changes = false;
  collapsedSections.untracked = false;
};

const markStatusSynced = (): void => {
  lastSyncedAt.value = Date.now();
};

const runWithPending = async (key: string, task: () => Promise<void>): Promise<void> => {
  if (pendingAction.value) {
    return;
  }

  pendingAction.value = key;

  try {
    await task();
  } finally {
    pendingAction.value = null;
  }
};

const syncRepositoryStatus = async (
  workspaceRootPath: string,
  options?: {
    showSuccessMessage?: boolean;
    showErrorMessage?: boolean;
  },
): Promise<void> => {
  try {
    await runWithPending('refresh', async () => {
      await gitStore.refreshRepositoryStatus(workspaceRootPath);
    });

    markStatusSynced();

    if (options?.showSuccessMessage) {
      message.success('Git 状态已刷新');
    }
  } catch (error) {
    if (options?.showErrorMessage) {
      message.error(getErrorMessage(error, '刷新 Git 状态失败'));
    }
  }
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

const hasVisibleChanges = computed(() => filteredSections.value.some((section) => section.entries.length > 0));
const canStageAll = computed(
  () => changedEntries.value.length > 0 || untrackedEntries.value.length > 0,
);
const canUnstageAll = computed(() => stagedEntries.value.length > 0);
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
    active: true,
  },
  {
    key: 'history',
    label: '历史',
    count: status.value.lastCommit ? 1 : 0,
    active: false,
  },
  {
    key: 'branches',
    label: '分支',
    count: status.value.headBranchName ? 1 : 0,
    active: false,
  },
  {
    key: 'pull-requests',
    label: '拉取请求',
    count: 0,
    active: false,
  },
  {
    key: 'stash',
    label: '贮藏',
    count: 0,
    active: false,
  },
]);

const emptyChangesTitle = computed(() =>
  searchQuery.value.trim() ? '没有匹配的变更' : '当前没有可显示的变更',
);

const emptyChangesText = computed(() =>
  searchQuery.value.trim()
    ? '试试搜索文件名、目录、状态，或者清空搜索关键字。'
    : '工作区已经和 HEAD 保持一致。你可以继续编辑文件，或点击右上角刷新重新同步仓库状态。',
);

const commitButtonLabel = computed(() => '提交到main');

const statusDotTone = computed<TStatusTone>(() => {
  if (isLoading.value) {
    return 'loading';
  }

  if (status.value.conflictedCount > 0) {
    return 'danger';
  }

  if (totalChangeCount.value > 0) {
    return 'warning';
  }

  return 'success';
});

const formatRelativeTime = (timestamp: number): string => {
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  if (elapsedMs < 30_000) {
    return '刚刚';
  }

  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }

  return `${Math.floor(hours / 24)} 天前`;
};

const statusbarText = computed(() => {
  if (isLoading.value) {
    return '正在同步 Git 状态…';
  }

  if (lastSyncedAt.value === null) {
    return workspaceStateLabel.value;
  }

  return `已同步 · ${formatRelativeTime(lastSyncedAt.value)}`;
});

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

  const normalizedPath = entry.relativePath.replace(/\\/g, '/');
  const segments = normalizedPath.split('/');
  return segments[segments.length - 1] ?? normalizedPath;
};

const resolveEntryDirectory = (entry: IGitFileStatusPayload): string => {
  if (entry.previousRelativePath) {
    return `${entry.previousRelativePath} → ${entry.relativePath}`;
  }

  const normalizedPath = entry.relativePath.replace(/\\/g, '/');
  const lastSlashIndex = normalizedPath.lastIndexOf('/');
  return lastSlashIndex === -1 ? '' : normalizedPath.slice(0, lastSlashIndex + 1);
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

const isActivePath = (path: string): boolean => normalizePath(path) === normalizePath(props.activePath);

const toggleSectionCollapse = (key: TGitSectionKey): void => {
  collapsedSections[key] = !collapsedSections[key];
};

const handleRefresh = async (showSuccessMessage = false): Promise<void> => {
  if (!props.workspaceRootPath) {
    return;
  }

  await syncRepositoryStatus(props.workspaceRootPath, {
    showSuccessMessage,
    showErrorMessage: true,
  });
};

const handleOpenFile = (path: string): void => {
  emit('open-file', path);
};

const handleStageAll = async (): Promise<void> => {
  try {
    await runWithPending('stage-all', async () => {
      await gitStore.stageAllChanges();
    });
    markStatusSynced();
    message.success('已暂存全部工作区变更');
  } catch (error) {
    message.error(getErrorMessage(error, '暂存 Git 变更失败'));
  }
};

const handleUnstageAll = async (): Promise<void> => {
  try {
    await runWithPending('unstage-all', async () => {
      await gitStore.unstageAllChanges();
    });
    markStatusSynced();
    message.success('已取消全部暂存');
  } catch (error) {
    message.error(getErrorMessage(error, '取消暂存失败'));
  }
};

const handleCommit = async (): Promise<void> => {
  const nextCommitMessage = commitMessage.value.trim();
  if (!nextCommitMessage) {
    message.warning('请先输入提交说明。');
    return;
  }

  try {
    await runWithPending('commit', async () => {
      const result = await gitStore.commitIndex(nextCommitMessage);
      commitMessage.value = '';
      markStatusSynced();
      message.success(`已创建提交 ${result.commit.shortId}`);
    });
  } catch (error) {
    message.error(getErrorMessage(error, '创建 Git 提交失败'));
  }
};

const handleMoreActions = (): void => {
  message.info('更多 Git 操作待接入');
};

const handleDiscardEntry = (entry: IGitFileStatusPayload): void => {
  message.info(`放弃更改 ${entry.fileName} 待接入`);
};

const handleEntryAction = async (
  actionKey: TGitEntryActionKey,
  sectionKey: TGitSectionKey,
  entry: IGitFileStatusPayload,
): Promise<void> => {
  if (actionKey === 'discard') {
    handleDiscardEntry(entry);
    return;
  }

  await handleSectionAction(sectionKey, entry);
};

const handleSectionAction = async (
  sectionKey: TGitSectionKey,
  entry: IGitFileStatusPayload,
): Promise<void> => {
  if (sectionKey === 'conflicts') {
    return;
  }

  try {
    if (sectionKey === 'staged') {
      await runWithPending(`unstage:${entry.path}`, async () => {
        await gitStore.unstagePaths([entry.path]);
      });
      markStatusSynced();
      message.success(`已取消暂存 ${entry.fileName}`);
      return;
    }

    await runWithPending(`stage:${entry.path}`, async () => {
      await gitStore.stagePaths([entry.path]);
    });
    markStatusSynced();
    message.success(`已暂存 ${entry.fileName}`);
  } catch (error) {
    message.error(getErrorMessage(error, 'Git 变更操作失败'));
  }
};

watch(
  () => props.workspaceRootPath,
  () => {
    commitMessage.value = '';
    searchQuery.value = '';
    lastSyncedAt.value = null;
    resetSectionCollapse();
  },
);

watch(
  () => [props.isDesktopRuntime, props.workspaceRootPath],
  ([ready, workspaceRootPath]) => {
    if (!ready || !workspaceRootPath) {
      gitStore.reset();
      lastSyncedAt.value = null;
      return;
    }

    void syncRepositoryStatus(workspaceRootPath);
  },
  { immediate: true },
);
</script>