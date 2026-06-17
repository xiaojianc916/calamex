<template>
  <section class="source-control-pull-requests-panel">
    <div class="source-control-pull-requests-header">
      <p class="source-control-pull-requests-heading">Pull requests</p>
      <div class="source-control-pull-requests-header-actions">
        <button v-if="pullRequestSupport.available && pullRequestView === 'list'" type="button"
          class="source-control-pr-action-btn is-primary source-control-pull-requests-create"
          :disabled="isPullRequestsLoading || isBusy" @click="handleStartCreatePullRequest">
          新建 PR
        </button>
        <button type="button" class="source-control-pull-requests-refresh" aria-label="刷新 Pull Request"
          title="刷新 Pull Request"
          :disabled="isPullRequestSupportLoading || isPullRequestsLoading || isSettingRemote || isBusy"
          @click="handleReloadPullRequestSupport">
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
    </div>

    <div v-if="isPullRequestSupportLoading" class="source-control-pr-skeleton" aria-hidden="true">
      <span class="source-control-pr-skeleton-row is-title" />
      <span class="source-control-pr-skeleton-row" />
      <span class="source-control-pr-skeleton-row is-short" />
    </div>

    <template v-else>
      <template v-if="pullRequestSupport.available">
        <template v-if="pullRequestView === 'list'">
          <div v-if="isPullRequestsLoading && pullRequests.length === 0" class="source-control-pr-skeleton">
            <span class="source-control-pr-skeleton-row is-title" />
            <span class="source-control-pr-skeleton-row" />
            <span class="source-control-pr-skeleton-row is-short" />
          </div>

          <div v-else-if="sortedPullRequests.length > 0" class="source-control-pr-list">
            <button v-for="pullRequest in sortedPullRequests" :key="pullRequest.number" type="button"
              class="source-control-pr-item" @click="handleOpenPullRequest(pullRequest.number)">
              <span class="source-control-pr-item-head">
                <span class="source-control-pr-item-title" v-text="pullRequest.title" />
                <span class="source-control-pr-state" :class="'is-' + resolvePullRequestStateTone(pullRequest)"
                  v-text="resolvePullRequestStateLabel(pullRequest)" />
              </span>
              <span class="source-control-pr-item-meta" v-text="resolvePullRequestMeta(pullRequest)" />
            </button>
          </div>

          <p v-else class="source-control-pr-empty" v-text="pullRequestsEmptyText" />
        </template>

        <template v-else-if="pullRequestView === 'detail'">
          <button type="button" class="source-control-pr-back-btn" @click="handleBackToPullRequestList">
            <span aria-hidden="true">←</span><span>返回列表</span>
          </button>

          <div v-if="isPullRequestDetailLoading && !pullRequestDetail" class="source-control-pr-skeleton">
            <span class="source-control-pr-skeleton-row is-title" />
            <span class="source-control-pr-skeleton-row" />
            <span class="source-control-pr-skeleton-row is-short" />
          </div>

          <div v-else-if="pullRequestDetail" class="source-control-pr-detail">
            <div class="source-control-pr-detail-head">
              <span class="source-control-pr-detail-title" v-text="pullRequestDetail.title" />
              <span class="source-control-pr-state" :class="'is-' + resolvePullRequestStateTone(pullRequestDetail)"
                v-text="resolvePullRequestStateLabel(pullRequestDetail)" />
            </div>
            <p class="source-control-pr-detail-meta" v-text="resolvePullRequestMeta(pullRequestDetail)" />
            <div class="source-control-pr-detail-stats">
              <span class="source-control-pr-stat is-add" v-text="'+' + (pullRequestDetail.additions ?? 0)" />
              <span class="source-control-pr-stat is-del" v-text="'-' + (pullRequestDetail.deletions ?? 0)" />
              <span class="source-control-pr-stat" v-text="(pullRequestDetail.changedFiles ?? 0) + ' 个文件'" />
            </div>
            <p v-if="pullRequestDetail.body" class="source-control-pr-detail-body" v-text="pullRequestDetail.body" />
            <p v-else class="source-control-pr-detail-body is-empty">这个 Pull Request 没有描述。</p>

            <div class="source-control-pr-merge-row">
              <select v-model="mergeMethod" class="source-control-pr-select" :disabled="isMutatingPullRequest">
                <option value="merge">Merge commit</option>
                <option value="squash">Squash</option>
                <option value="rebase">Rebase</option>
              </select>
              <button type="button" class="source-control-pr-action-btn is-primary"
                :disabled="isMutatingPullRequest || pullRequestDetail.state !== 'open'"
                @click="handleMergePullRequest(pullRequestDetail)">
                合并
              </button>
              <button type="button" class="source-control-pr-action-btn is-danger"
                :disabled="isMutatingPullRequest || pullRequestDetail.state !== 'open'"
                @click="handleClosePullRequest(pullRequestDetail)">
                关闭
              </button>
            </div>
          </div>
        </template>

        <template v-else>
          <button type="button" class="source-control-pr-back-btn" @click="handleBackToPullRequestList">
            <span aria-hidden="true">←</span><span>返回列表</span>
          </button>
          <form class="source-control-pr-create-form" @submit.prevent="handleSubmitCreatePullRequest">
            <label class="source-control-pr-field">
              <span class="source-control-pr-field-label">标题</span>
              <input v-model="createPullRequestTitle" type="text" class="source-control-pr-input"
                placeholder="简要描述这次改动" :disabled="isCreatingPullRequest" spellcheck="false" />
            </label>
            <div class="source-control-pr-merge-row">
              <label class="source-control-pr-field">
                <span class="source-control-pr-field-label">目标分支</span>
                <input v-model="createPullRequestBase" type="text" class="source-control-pr-input"
                  placeholder="main" :disabled="isCreatingPullRequest" spellcheck="false" />
              </label>
              <label class="source-control-pr-field">
                <span class="source-control-pr-field-label">来源分支</span>
                <input v-model="createPullRequestHead" type="text" class="source-control-pr-input"
                  placeholder="feature/..." :disabled="isCreatingPullRequest" spellcheck="false" />
              </label>
            </div>
            <label class="source-control-pr-field">
              <span class="source-control-pr-field-label">描述</span>
              <textarea v-model="createPullRequestBody" class="source-control-pr-textarea" rows="4"
                placeholder="补充背景、测试情况等（可选）" :disabled="isCreatingPullRequest" />
            </label>
            <label class="source-control-pr-draft-row">
              <input v-model="createPullRequestDraft" type="checkbox" :disabled="isCreatingPullRequest" />
              <span>创建为草稿 PR</span>
            </label>
            <p v-if="createPullRequestError" class="source-control-pr-form-error" v-text="createPullRequestError" />
            <div class="source-control-pr-create-actions">
              <button type="button" class="source-control-pr-action-btn"
                :disabled="isCreatingPullRequest" @click="handleBackToPullRequestList">取消</button>
              <button type="submit" class="source-control-pr-action-btn is-primary"
                :disabled="isCreatingPullRequest || !canSubmitCreatePullRequest"
                v-text="isCreatingPullRequest ? '创建中…' : '创建 PR'" />
            </div>
          </form>
        </template>
      </template>

      <template v-else>
        <p class="source-control-info-title" v-text="pullRequestPanelTitle" />
        <p class="source-control-info-text" v-text="pullRequestPanelText" />
      </template>

      <div class="source-control-pull-requests-config">
        <button v-if="!isRemoteFormOpen" type="button"
          class="source-control-pr-action-btn source-control-pull-requests-config-trigger"
          :disabled="isSettingRemote || isBusy" @click="handleOpenRemoteForm">
          更新远程地址
        </button>
        <form v-else class="source-control-pull-requests-form" @submit.prevent="handleSubmitRemoteForm">
          <label class="source-control-pr-field">
            <span class="source-control-pr-field-label">远程名称</span>
            <input v-model="remoteNameInput" type="text"
              class="source-control-pull-requests-input source-control-pr-input"
              placeholder="origin" :disabled="isSettingRemote" spellcheck="false" />
          </label>
          <label class="source-control-pr-field">
            <span class="source-control-pr-field-label">远程地址</span>
            <input v-model="remoteUrlInput" type="text"
              class="source-control-pull-requests-input source-control-pr-input"
              :class="{ 'is-invalid': Boolean(remoteFormError) }"
              placeholder="https://github.com/owner/repo.git" :disabled="isSettingRemote" spellcheck="false" />
          </label>
          <p v-if="remoteFormError" class="source-control-pr-form-error" v-text="remoteFormError" />
          <div class="source-control-pr-create-actions">
            <button type="button" class="source-control-pr-action-btn"
              :disabled="isSettingRemote" @click="handleCancelRemoteForm">取消</button>
            <button type="submit" class="source-control-pr-action-btn is-primary"
              :disabled="isSettingRemote || !canSubmitRemoteForm"
              v-text="isSettingRemote ? '保存中…' : '保存'" />
          </div>
        </form>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { RefreshCw } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useDialog } from '@/composables/useDialog';
import { useMessage } from '@/composables/useMessage';
import { useGitStore } from '@/store/git';
import type {
  IGitPullRequestDetailPayload,
  IGitPullRequestSummaryPayload,
  IGitPullRequestSupportPayload,
} from '@/types/git';
import { toErrorMessage } from '@/utils/error/error';

const props = defineProps<{
  isBusy: boolean;
  runWithPending: (key: string, task: () => Promise<void>) => Promise<boolean>;
}>();

type TPullRequestView = 'list' | 'detail' | 'create';

// 移除筛选维度后,PR 列表统一以 'all' 拉取并展示。
const PULL_REQUEST_LIST_STATE = 'all';
const PULL_REQUESTS_EMPTY_TEXT = '这个仓库还没有任何 Pull Request。';

const gitStore = useGitStore();
const message = useMessage();
const dialog = useDialog();

const status = computed(() => gitStore.status);
const pullRequestSupport = computed<IGitPullRequestSupportPayload>(
  () => gitStore.pullRequestSupport,
);
const isPullRequestSupportLoading = computed(() => gitStore.isPullRequestSupportLoading);
const isSettingRemote = computed(() => gitStore.isSettingRemote);
const pullRequests = computed<IGitPullRequestSummaryPayload[]>(() => gitStore.pullRequests);
const isPullRequestsLoading = computed(() => gitStore.isPullRequestsLoading);
const pullRequestDetail = computed<IGitPullRequestDetailPayload | null>(
  () => gitStore.pullRequestDetail,
);
const isPullRequestDetailLoading = computed(() => gitStore.isPullRequestDetailLoading);

// 按最新顺序从上而下展示:PR 编号单调递增,编号越大越新,故按编号降序排序。
const sortedPullRequests = computed<IGitPullRequestSummaryPayload[]>(() =>
  [...pullRequests.value].sort((a, b) => b.number - a.number),
);

const pullRequestsEmptyText = PULL_REQUESTS_EMPTY_TEXT;

const isRemoteFormOpen = ref(false);
const remoteNameInput = ref('');
const remoteUrlInput = ref('');
const remoteFormError = ref<string | null>(null);

const canSubmitRemoteForm = computed(
  () => remoteNameInput.value.trim().length > 0 && remoteUrlInput.value.trim().length > 0,
);

const pullRequestView = ref<TPullRequestView>('list');
const activePullRequestNumber = ref<number | null>(null);
const mergeMethod = ref<'merge' | 'squash' | 'rebase'>('merge');
const isMutatingPullRequest = ref(false);
const createPullRequestTitle = ref('');
const createPullRequestBody = ref('');
const createPullRequestBase = ref('');
const createPullRequestHead = ref('');
const createPullRequestDraft = ref(false);
const createPullRequestError = ref<string | null>(null);
const isCreatingPullRequest = ref(false);

const canSubmitCreatePullRequest = computed(
  () =>
    createPullRequestTitle.value.trim().length > 0 &&
    createPullRequestBase.value.trim().length > 0 &&
    createPullRequestHead.value.trim().length > 0,
);

const resolvePullRequestStateLabel = (pullRequest: IGitPullRequestSummaryPayload): string => {
  if (pullRequest.isDraft) {
    return '草稿';
  }
  if (pullRequest.state === 'merged') {
    return '已合并';
  }
  if (pullRequest.state === 'closed') {
    return '已关闭';
  }
  return '进行中';
};

const resolvePullRequestStateTone = (pullRequest: IGitPullRequestSummaryPayload): string => {
  if (pullRequest.isDraft) {
    return 'draft';
  }
  return pullRequest.state;
};

const resolvePullRequestMeta = (pullRequest: IGitPullRequestSummaryPayload): string => {
  const segments: string[] = [`#${pullRequest.number}`];
  if (pullRequest.author) {
    segments.push(pullRequest.author);
  }
  segments.push(`${pullRequest.headRef} → ${pullRequest.baseRef}`);
  return segments.join(' · ');
};

const pullRequestProviderLabel = computed(() => {
  switch (pullRequestSupport.value.provider) {
    case 'github':
      return 'GitHub';
    case 'gitlab':
      return 'GitLab';
    case 'gitea':
      return 'Gitea';
    case 'bitbucket':
      return 'Bitbucket';
    default:
      return '未知平台';
  }
});

const pullRequestPanelTitle = computed(() => {
  if (isPullRequestSupportLoading.value) {
    return '正在检测远程 Pull Request 支持';
  }

  if (pullRequestSupport.value.available) {
    return `已检测到 ${pullRequestProviderLabel.value} 远程`;
  }

  if (pullRequestSupport.value.remoteName) {
    return '当前远程暂未识别为可直达的 PR 平台';
  }

  return '当前仓库没有可用的远程评审入口';
});

const pullRequestPanelText = computed(() => {
  if (pullRequestSupport.value.available) {
    return '已根据 Git 远程地址解析出 Pull Request 列表与创建入口，点击按钮会直接打开外部页面。';
  }

  if (pullRequestSupport.value.remoteName) {
    return '已检测到远程仓库，但当前无法可靠推导 Pull Request 页面地址。';
  }

  return '先为仓库配置远程地址，再在这里打开 PR 列表或创建入口。';
});

const handleOpenPullRequest = async (pullRequestNumber: number): Promise<void> => {
  activePullRequestNumber.value = pullRequestNumber;
  pullRequestView.value = 'detail';
  try {
    await gitStore.loadPullRequestDetail(pullRequestNumber);
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Pull Request 详情失败'));
  }
};

const handleBackToPullRequestList = (): void => {
  pullRequestView.value = 'list';
  activePullRequestNumber.value = null;
};

const handleStartCreatePullRequest = (): void => {
  createPullRequestTitle.value = '';
  createPullRequestBody.value = '';
  createPullRequestBase.value = 'main';
  createPullRequestHead.value = status.value.headShortName ?? status.value.headBranchName ?? '';
  createPullRequestDraft.value = false;
  createPullRequestError.value = null;
  pullRequestView.value = 'create';
};

const handleSubmitCreatePullRequest = async (): Promise<void> => {
  if (!canSubmitCreatePullRequest.value || isCreatingPullRequest.value) {
    return;
  }
  isCreatingPullRequest.value = true;
  createPullRequestError.value = null;
  try {
    await gitStore.createPullRequest({
      title: createPullRequestTitle.value.trim(),
      body: createPullRequestBody.value.trim(),
      base: createPullRequestBase.value.trim(),
      head: createPullRequestHead.value.trim(),
      draft: createPullRequestDraft.value,
    });
    await gitStore.refreshPullRequests(PULL_REQUEST_LIST_STATE);
    pullRequestView.value = 'list';
    message.success('已创建 Pull Request');
  } catch (error) {
    createPullRequestError.value = toErrorMessage(error, '创建 Pull Request 失败');
  } finally {
    isCreatingPullRequest.value = false;
  }
};

const handleMergePullRequest = async (
  pullRequest: IGitPullRequestSummaryPayload,
): Promise<void> => {
  const action = await dialog.confirm({
    title: '合并这个 Pull Request？',
    description: `将以 ${mergeMethod.value} 方式合并 #${pullRequest.number}。`,
    confirmText: '合并',
    cancelText: '取消',
    variant: 'default',
  });
  if (action !== 'confirm') {
    return;
  }
  isMutatingPullRequest.value = true;
  try {
    await gitStore.mergePullRequest(pullRequest.number, mergeMethod.value);
    await gitStore.refreshPullRequests(PULL_REQUEST_LIST_STATE);
    pullRequestView.value = 'list';
    activePullRequestNumber.value = null;
    message.success(`已合并 #${pullRequest.number}`);
  } catch (error) {
    message.error(toErrorMessage(error, '合并 Pull Request 失败'));
  } finally {
    isMutatingPullRequest.value = false;
  }
};

const handleClosePullRequest = async (
  pullRequest: IGitPullRequestSummaryPayload,
): Promise<void> => {
  const action = await dialog.confirm({
    title: '关闭这个 Pull Request？',
    description: `将关闭 #${pullRequest.number}，但不会合并改动。`,
    confirmText: '关闭 PR',
    cancelText: '取消',
    variant: 'danger',
  });
  if (action !== 'confirm') {
    return;
  }
  isMutatingPullRequest.value = true;
  try {
    await gitStore.closePullRequest(pullRequest.number);
    await gitStore.refreshPullRequests(PULL_REQUEST_LIST_STATE);
    pullRequestView.value = 'list';
    activePullRequestNumber.value = null;
    message.success(`已关闭 #${pullRequest.number}`);
  } catch (error) {
    message.error(toErrorMessage(error, '关闭 Pull Request 失败'));
  } finally {
    isMutatingPullRequest.value = false;
  }
};

const handleReloadPullRequestSupport = async (): Promise<void> => {
  try {
    await gitStore.refreshPullRequests(PULL_REQUEST_LIST_STATE);
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Pull Request 列表失败'));
  }
};

const handleOpenRemoteForm = (): void => {
  remoteNameInput.value = pullRequestSupport.value.remoteName ?? 'origin';
  remoteUrlInput.value = pullRequestSupport.value.repositoryUrl ?? '';
  remoteFormError.value = null;
  isRemoteFormOpen.value = true;
};

const handleCancelRemoteForm = (): void => {
  if (isSettingRemote.value) {
    return;
  }

  isRemoteFormOpen.value = false;
  remoteFormError.value = null;
};

const handleSubmitRemoteForm = async (): Promise<void> => {
  const remoteName = remoteNameInput.value.trim();
  const remoteUrl = remoteUrlInput.value.trim();
  if (!remoteName || !remoteUrl) {
    remoteFormError.value = '请填写远程名称和远程地址。';
    return;
  }

  remoteFormError.value = null;

  await props.runWithPending('set-remote', async () => {
    try {
      await gitStore.setRemote(remoteName, remoteUrl);
      isRemoteFormOpen.value = false;
      message.success('已更新仓库远程地址');
    } catch (error) {
      remoteFormError.value = toErrorMessage(error, '配置远程地址失败');
    }
  });
};
</script>
