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
            <span class="source-control-setup-project-name" v-text="workspaceLabel" />
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

            <p v-if="sourceControlActionError" class="source-control-setup-error" v-text="sourceControlActionError" />

            <div class="source-control-setup-actions">
              <button type="button" class="source-control-setup-btn source-control-setup-btn-primary"
                :disabled="isBusy || isLoading" :aria-busy="pendingAction === 'init-repository'"
                @click="handleInitRepository" v-text="initRepositoryButtonLabel" />

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
          <p class="source-control-branch-name" v-text="branchLabel" />
        </div>

        <div class="source-control-branch-sync">
          <span v-if="status.behind > 0">↓  status.behind </span>
          <span v-if="status.ahead > 0">↑  status.ahead </span>
          <span v-if="status.ahead === 0 && status.behind === 0" v-text="workspaceStateLabel" />
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

          <span class="source-control-nav-label" v-text="item.label" />
          <span class="source-control-nav-count" v-text="item.count" />
        </button>
      </nav>

      <SourceControlChangesTab
        v-if="activeTab === 'changes'"
        :workspace-root-path="workspaceRootPath"
        :active-path="activePath"
        :search-query="searchQuery"
        :pending-action="pendingAction"
        :run-with-pending="runWithPending"
        :sync-repository-status="syncRepositoryStatus"
        :set-source-control-action-error="setSourceControlActionError"
        @open-file="emit('open-file', $event)"
        @open-diff="emit('open-diff', $event)"
      />

      <div v-else class="source-control-scroll">
        <SourceControlHistoryTab v-if="activeTab === 'history'" :search-query="searchQuery" :is-busy="isBusy" />

        <SourceControlBranchesTab v-else-if="activeTab === 'branches'" :search-query="searchQuery"
          :is-busy="isBusy" :run-with-pending="runWithPending" />

        <SourceControlPullRequestsTab v-else-if="activeTab === 'pull-requests'" :is-busy="isBusy"
          :run-with-pending="runWithPending" />

        <SourceControlStashTab v-else :search-query="searchQuery" :is-busy="isBusy"
          :run-with-pending="runWithPending" />
      </div>
    </template>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useDialog } from '@/composables/useDialog';
import { useMessage } from '@/composables/useMessage';
import { useSourceControlActions } from '@/composables/useSourceControlActions';
import { useGitStore } from '@/store/git';
import type {
  IGitBranchPayload,
  IGitCommitSummaryPayload,
  IGitDiffPreviewRequest,
  IGitPullRequestSummaryPayload,
  IGitPullRequestSupportPayload,
  IGitStashEntryPayload,
} from '@/types/git';
import { openExternalUrl } from '@/utils/platform/browser';
import { toErrorMessage } from '@/utils/error/error';
import { getPathBaseName } from '@/utils/file/path';
import SourceControlBranchesTab from './SourceControlBranchesTab.vue';
import SourceControlChangesTab from './SourceControlChangesTab.vue';
import SourceControlHistoryTab from './SourceControlHistoryTab.vue';
import SourceControlPullRequestsTab from './SourceControlPullRequestsTab.vue';
import SourceControlStashTab from './SourceControlStashTab.vue';

const GIT_GETTING_STARTED_URL = 'https://git-scm.com/book/zh/v2';
const GIT_CLONE_GUIDE_URL =
  'https://git-scm.com/book/zh/v2/Git-%E5%9F%BA%E7%A1%80-%E8%8E%B7%E5%8F%96-Git-%E4%BB%93%E5%BA%93';

type TGitNavKey = 'changes' | 'history' | 'branches' | 'pull-requests' | 'stash';

interface IGitNavItem {
  key: TGitNavKey;
  label: string;
  count: number;
  active: boolean;
}

const props = withDefaults(
  defineProps<{
    isActive?: boolean;
    isDesktopRuntime: boolean;
    workspaceRootPath: string | null;
    activePath: string | null;
  }>(),
  {
    isActive: true,
  },
);

const emit = defineEmits<{
  'open-file': [path: string];
  'open-diff': [payload: IGitDiffPreviewRequest];
}>();

const gitStore = useGitStore();
const message = useMessage();
const dialog = useDialog();

const searchQuery = ref('');
const activeTab = ref<TGitNavKey>('changes');
const pendingAction = ref<string | null>(null);
const sourceControlActionError = ref<string | null>(null);

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

const setSourceControlActionError = (value: string | null): void => {
  sourceControlActionError.value = value;
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

const commitHistoryEntries = computed<IGitCommitSummaryPayload[]>(() => gitStore.commitHistory);
const branchEntries = computed<IGitBranchPayload[]>(() => gitStore.branches);
const stashEntries = computed<IGitStashEntryPayload[]>(() => gitStore.stashes);
const pullRequestSupport = computed<IGitPullRequestSupportPayload>(
  () => gitStore.pullRequestSupport,
);
const pullRequests = computed<IGitPullRequestSummaryPayload[]>(() => gitStore.pullRequests);
const pullRequestStateFilter = computed(() => gitStore.pullRequestStateFilter);

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

const selectNavItem = (key: TGitNavKey): void => {
  activeTab.value = key;
};

const handleOpenCloneGuide = (): void => {
  openExternalUrl(GIT_CLONE_GUIDE_URL);
};

const handleOpenGitGuide = (): void => {
  openExternalUrl(GIT_GETTING_STARTED_URL);
};

// 协调器仅消费 handleInitRepository（仓库尚未初始化时使用）。
// 变更/提交相关的 getter 不会在初始化流程中被调用，这里提供安全的空实现。
const { handleInitRepository } = useSourceControlActions({
  gitStore,
  message,
  dialog,
  getWorkspaceRootPath: () => props.workspaceRootPath,
  getStageableEntries: () => [],
  getStagedPaths: () => [],
  getDiscardableEntries: () => [],
  getStagedCount: () => 0,
  getCommitMessage: () => '',
  setCommitMessage: () => undefined,
  runWithPending,
  setSourceControlActionError,
  syncRepositoryStatus,
});

watch(
  () => props.workspaceRootPath,
  () => {
    searchQuery.value = '';
    activeTab.value = 'changes';
    sourceControlActionError.value = null;
  },
);

watch(
  () => activeTab.value,
  (nextTab) => {
    if (!props.isActive || !hasRepository.value || nextTab === 'changes') {
      return;
    }

    void ensureActiveTabData(nextTab);
  },
);

watch(
  [() => props.isDesktopRuntime, () => props.workspaceRootPath, () => props.isActive],
  ([ready, workspaceRootPath, active]) => {
    if (!active) {
      return;
    }

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
