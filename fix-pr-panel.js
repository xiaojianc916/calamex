// fix-pr-panel.js  —— 在仓库根目录运行：node fix-pr-panel.js
// 作用：从 55f574f7 还原 SourceControlPanel.vue / .spec.ts，再注入应用内 PR 面板（列表+详情+创建+合并/关闭）。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GOOD_COMMIT = '55f574f75958907fc5d19272e0a738747f0013a1';
const VUE_REL = 'src/components/workbench/SourceControlPanel.vue';
const SPEC_REL = 'src/components/workbench/SourceControlPanel.spec.ts';

// 1) 定位仓库根目录
const repoRoot = execSync('git rev-parse --show-toplevel').toString().trim();
const VUE_PATH = path.join(repoRoot, VUE_REL);
const SPEC_PATH = path.join(repoRoot, SPEC_REL);

// 2) 从已知完好的提交还原两个文件（会覆盖工作区并暂存）
console.log(`[restore] git checkout ${GOOD_COMMIT.slice(0, 8)} -- 两个文件`);
execSync(`git checkout ${GOOD_COMMIT} -- "${VUE_REL}" "${SPEC_REL}"`, {
  cwd: repoRoot,
  stdio: 'inherit',
});

// 3) 替换工具：必须命中且仅命中一次，否则抛错
function replaceOnce(content, label, oldStr, newStr) {
    content = content.replace(/\r\n/g, '\n');   // ← 新增这一行
  const parts = content.split(oldStr);
  if (parts.length === 1) throw new Error(`[${label}] 未找到锚点，已中止（文件未写入）`);
  if (parts.length > 2) throw new Error(`[${label}] 锚点出现 ${parts.length - 1} 次（应为 1），已中止`);
  console.log(`[ok] ${label}`);
  return parts.join(newStr);
}

// ===== 新增/替换片段（均不含反引号与 ${}，可安全内联）=====

const S1_OLD = `  IGitPullRequestSupportPayload,
  IGitStashEntryPayload,`;
const S1_NEW = `  IGitPullRequestDetailPayload,
  IGitPullRequestSummaryPayload,
  IGitPullRequestSupportPayload,
  IGitStashEntryPayload,`;

const S2_OLD = `type TGitNavKey = 'changes' | 'history' | 'branches' | 'pull-requests' | 'stash';`;
const S2_NEW = `type TGitNavKey = 'changes' | 'history' | 'branches' | 'pull-requests' | 'stash';
type TPullRequestView = 'list' | 'detail' | 'create';
type TPullRequestStateFilter = 'open' | 'closed' | 'all';
type TPullRequestMergeMethod = 'merge' | 'squash' | 'rebase';`;

const S3A_OLD = `const isSettingRemote = computed(() => gitStore.isSettingRemote);`;
const S3A_NEW = `const isSettingRemote = computed(() => gitStore.isSettingRemote);

const pullRequests = computed<IGitPullRequestSummaryPayload[]>(() => gitStore.pullRequests);
const isPullRequestsLoading = computed(() => gitStore.isPullRequestsLoading);
const pullRequestDetail = computed<IGitPullRequestDetailPayload | null>(
  () => gitStore.pullRequestDetail,
);
const isPullRequestDetailLoading = computed(() => gitStore.isPullRequestDetailLoading);`;

const S3B_OLD = `const canSubmitRemoteForm = computed(
  () => remoteNameInput.value.trim().length > 0 && remoteUrlInput.value.trim().length > 0,
);`;
const S3B_NEW = `const canSubmitRemoteForm = computed(
  () => remoteNameInput.value.trim().length > 0 && remoteUrlInput.value.trim().length > 0,
);

const pullRequestView = ref<TPullRequestView>('list');
const pullRequestStateFilter = ref<TPullRequestStateFilter>('open');
const pullRequestActionError = ref<string | null>(null);
const pullRequestMergeMethod = ref<TPullRequestMergeMethod>('merge');
const createPullRequestTitle = ref('');
const createPullRequestBody = ref('');
const createPullRequestBase = ref('');
const createPullRequestHead = ref('');
const createPullRequestDraft = ref(false);
const createPullRequestError = ref<string | null>(null);

const pullRequestStateOptions: Array<{ value: TPullRequestStateFilter; label: string }> = [
  { value: 'open', label: '开放' },
  { value: 'closed', label: '已关闭' },
  { value: 'all', label: '全部' },
];

const pullRequestMergeMethodOptions: Array<{ value: TPullRequestMergeMethod; label: string }> = [
  { value: 'merge', label: '合并提交' },
  { value: 'squash', label: '压缩合并' },
  { value: 'rebase', label: '变基合并' },
];

const isCreatingPullRequest = computed(() => pendingAction.value === 'create-pull-request');

const canSubmitCreatePullRequest = computed(
  () =>
    !isCreatingPullRequest.value &&
    createPullRequestTitle.value.trim().length > 0 &&
    createPullRequestBase.value.trim().length > 0 &&
    createPullRequestHead.value.trim().length > 0,
);

const createPullRequestSubmitLabel = computed(() =>
  isCreatingPullRequest.value ? '创建中…' : '创建 Pull Request',
);`;

const S4_OLD = `const canOpenPullRequestList = computed(() =>
  Boolean(pullRequestSupport.value.pullRequestsUrl ?? pullRequestSupport.value.repositoryUrl),
);

const canOpenPullRequestCreate = computed(() =>
  Boolean(
    pullRequestSupport.value.createPullRequestUrl ??
      pullRequestSupport.value.pullRequestsUrl ??
      pullRequestSupport.value.repositoryUrl,
  ),
);`;
const S4_NEW = `const pullRequestsEmptyText = computed(() => {
  if (pullRequestStateFilter.value === 'closed') {
    return '当前没有已关闭的 Pull Request。';
  }
  if (pullRequestStateFilter.value === 'all') {
    return '当前仓库还没有 Pull Request。';
  }
  return '当前没有开放中的 Pull Request。';
});

const isPullRequestOpen = (
  pullRequest: IGitPullRequestSummaryPayload | IGitPullRequestDetailPayload,
): boolean => pullRequest.state === 'open';

const resolvePullRequestStateClass = (
  pullRequest: IGitPullRequestSummaryPayload | IGitPullRequestDetailPayload,
): string => {
  if (pullRequest.state === 'merged') {
    return 'is-merged';
  }
  if (pullRequest.state === 'closed') {
    return 'is-closed';
  }
  return pullRequest.isDraft ? 'is-draft' : 'is-open';
};

const resolvePullRequestStateLabel = (
  pullRequest: IGitPullRequestSummaryPayload | IGitPullRequestDetailPayload,
): string => {
  if (pullRequest.state === 'merged') {
    return '已合并';
  }
  if (pullRequest.state === 'closed') {
    return '已关闭';
  }
  return pullRequest.isDraft ? '草稿' : '开放';
};

const formatPullRequestTimestamp = (value: string | null | undefined): string => {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toLocaleString();
};

const resolvePullRequestMeta = (
  pullRequest: IGitPullRequestSummaryPayload | IGitPullRequestDetailPayload,
): string => {
  const segments: string[] = [];
  if (pullRequest.author) {
    segments.push(pullRequest.author);
  }
  segments.push(pullRequest.headRef + ' → ' + pullRequest.baseRef);
  const updatedAt = formatPullRequestTimestamp(pullRequest.updatedAt);
  if (updatedAt) {
    segments.push('更新于 ' + updatedAt);
  }
  return segments.join(' · ');
};`;

const S5_OLD = `    if (tabKey === 'stash') {
      await gitStore.loadStashes();
      return;
    }

    await gitStore.loadPullRequestSupport();`;
const S5_NEW = `    if (tabKey === 'stash') {
      await gitStore.loadStashes();
      return;
    }

    await gitStore.loadPullRequestSupport();
    if (pullRequestSupport.value.available) {
      await gitStore.loadPullRequests(pullRequestStateFilter.value);
    }`;

const S6_OLD = `const handleOpenPullRequestList = (): void => {
  const targetUrl =
    pullRequestSupport.value.pullRequestsUrl ?? pullRequestSupport.value.repositoryUrl;
  if (!targetUrl) {
    message.warning('当前没有可打开的 Pull Request 列表。');
    return;
  }

  openExternalUrl(targetUrl);
};`;
const S6_NEW = `const handleReloadPullRequests = async (): Promise<void> => {
  try {
    await gitStore.loadPullRequests(pullRequestStateFilter.value);
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Pull Request 列表失败'));
  }
};

const handleSelectPullRequestState = async (state: TPullRequestStateFilter): Promise<void> => {
  if (pullRequestStateFilter.value === state) {
    return;
  }
  pullRequestStateFilter.value = state;
  pullRequestActionError.value = null;
  try {
    await gitStore.loadPullRequests(state);
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Pull Request 列表失败'));
  }
};

const handleOpenPullRequestDetail = async (
  pullRequest: IGitPullRequestSummaryPayload,
): Promise<void> => {
  pullRequestActionError.value = null;
  pullRequestMergeMethod.value = 'merge';
  pullRequestView.value = 'detail';
  try {
    await gitStore.loadPullRequestDetail(pullRequest.number);
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Pull Request 详情失败'));
  }
};

const handleBackToPullRequestList = (): void => {
  pullRequestView.value = 'list';
  pullRequestActionError.value = null;
  createPullRequestError.value = null;
};

const handleMergePullRequest = async (
  pullRequest: IGitPullRequestSummaryPayload | IGitPullRequestDetailPayload,
): Promise<void> => {
  const action = await dialog.confirm({
    title: '合并此 Pull Request？',
    description: '将把 ' + pullRequest.headRef + ' 合并到 ' + pullRequest.baseRef + '。',
    confirmText: '合并',
    cancelText: '取消',
    variant: 'default',
  });
  if (action !== 'confirm') {
    return;
  }
  pullRequestActionError.value = null;
  try {
    const didRun = await runWithPending('merge-pull-request', async () => {
      await gitStore.mergePullRequest(pullRequest.number, pullRequestMergeMethod.value);
      await gitStore.loadPullRequests(pullRequestStateFilter.value);
    });
    if (!didRun) {
      return;
    }
    pullRequestView.value = 'list';
    message.success('已合并 #' + pullRequest.number);
  } catch (error) {
    pullRequestActionError.value = toErrorMessage(error, '合并 Pull Request 失败');
  }
};

const handleClosePullRequest = async (
  pullRequest: IGitPullRequestSummaryPayload | IGitPullRequestDetailPayload,
): Promise<void> => {
  const action = await dialog.confirm({
    title: '关闭此 Pull Request？',
    description: '将关闭 #' + pullRequest.number + '（' + pullRequest.title + '）。',
    confirmText: '关闭',
    cancelText: '取消',
    variant: 'danger',
  });
  if (action !== 'confirm') {
    return;
  }
  pullRequestActionError.value = null;
  try {
    const didRun = await runWithPending('close-pull-request', async () => {
      await gitStore.closePullRequest(pullRequest.number);
      await gitStore.loadPullRequests(pullRequestStateFilter.value);
    });
    if (!didRun) {
      return;
    }
    pullRequestView.value = 'list';
    message.success('已关闭 #' + pullRequest.number);
  } catch (error) {
    pullRequestActionError.value = toErrorMessage(error, '关闭 Pull Request 失败');
  }
};`;

const S7_OLD = `const handleOpenCreatePullRequest = (): void => {
  const targetUrl =
    pullRequestSupport.value.createPullRequestUrl ??
    pullRequestSupport.value.pullRequestsUrl ??
    pullRequestSupport.value.repositoryUrl;
  if (!targetUrl) {
    message.warning('当前没有可打开的 Pull Request 创建入口。');
    return;
  }

  openExternalUrl(targetUrl);
};`;
const S7_NEW = `const handleOpenCreatePullRequest = (): void => {
  createPullRequestTitle.value = '';
  createPullRequestBody.value = '';
  createPullRequestBase.value = 'main';
  createPullRequestHead.value = status.value.headShortName ?? status.value.headBranchName ?? '';
  createPullRequestDraft.value = false;
  createPullRequestError.value = null;
  pullRequestActionError.value = null;
  pullRequestView.value = 'create';
};

const handleSubmitCreatePullRequest = async (): Promise<void> => {
  const title = createPullRequestTitle.value.trim();
  const base = createPullRequestBase.value.trim();
  const head = createPullRequestHead.value.trim();
  const body = createPullRequestBody.value.trim();
  if (!title || !base || !head) {
    createPullRequestError.value = '请填写标题、来源分支和目标分支。';
    return;
  }
  createPullRequestError.value = null;
  try {
    await runWithPending('create-pull-request', async () => {
      const created = await gitStore.createPullRequest({
        title,
        body: body || null,
        base,
        head,
        draft: createPullRequestDraft.value,
      });
      await gitStore.loadPullRequests(pullRequestStateFilter.value);
      pullRequestView.value = 'list';
      message.success('已创建 #' + created.number);
    });
  } catch (error) {
    createPullRequestError.value = toErrorMessage(error, '创建 Pull Request 失败');
  }
};`;

const S8_OLD = `    isRemoteFormOpen.value = false;
    remoteFormError.value = null;
    closeSourceControlMenu();
    resetSectionCollapse();`;
const S8_NEW = `    isRemoteFormOpen.value = false;
    remoteFormError.value = null;
    pullRequestView.value = 'list';
    pullRequestStateFilter.value = 'open';
    pullRequestActionError.value = null;
    createPullRequestError.value = null;
    closeSourceControlMenu();
    resetSectionCollapse();`;

const S9_OLD = `  (nextTab) => {
    if (!hasRepository.value || nextTab === 'changes') {
      return;
    }

    void ensureActiveTabData(nextTab);
  },`;
const S9_NEW = `  (nextTab) => {
    if (!hasRepository.value || nextTab === 'changes') {
      return;
    }

    if (nextTab === 'pull-requests') {
      pullRequestView.value = 'list';
      pullRequestActionError.value = null;
    }

    void ensureActiveTabData(nextTab);
  },`;

// 模板：把信息文案收敛到“不支持”分支，并用真正的 PR 外壳替换原“查看列表 / 创建 PR”工具条
const T1_OLD = `            <p class="source-control-info-title">`;
const T1_NEW = `            <p v-if="!pullRequestSupport.available" class="source-control-info-title">`;

const T2_OLD = `            <p class="source-control-info-text">`;
const T2_NEW = `            <p v-if="!pullRequestSupport.available" class="source-control-info-text">`;

const T3_OLD = `            <div v-if="pullRequestSupport.available"
              class="source-control-toolbar source-control-pull-requests-toolbar">
              <button type="button" class="source-control-toolbar-btn"
                :disabled="!canOpenPullRequestList || isBusy" @click="handleOpenPullRequestList">
                查看列表
              </button>

              <button type="button" class="source-control-toolbar-btn"
                :disabled="!canOpenPullRequestCreate || isBusy" @click="handleOpenCreatePullRequest">
                创建 PR
              </button>
            </div>`;
const T3_NEW = `            <div v-if="pullRequestSupport.available" class="source-control-pr-shell">
              <template v-if="pullRequestView === 'detail'">
                <div class="source-control-pr-toolbar">
                  <button type="button" class="source-control-pr-back-btn" :disabled="isBusy"
                    @click="handleBackToPullRequestList">
                    ← 返回列表
                  </button>
                </div>

                <p v-if="pullRequestActionError" class="source-control-pr-form-error">
                   pullRequestActionError 
                </p>

                <div v-if="isPullRequestDetailLoading && !pullRequestDetail"
                  class="source-control-pr-skeleton" aria-hidden="true">
                  <span class="source-control-pr-skeleton-row is-title" />
                  <span class="source-control-pr-skeleton-row" />
                  <span class="source-control-pr-skeleton-row is-short" />
                </div>

                <article v-else-if="pullRequestDetail" class="source-control-pr-detail">
                  <div class="source-control-pr-detail-card">
                    <p class="source-control-pr-detail-title">
                      # pullRequestDetail.number  ·  pullRequestDetail.title 
                    </p>
                    <p class="source-control-pr-detail-meta">
                      <span class="source-control-pr-state"
                        :class="resolvePullRequestStateClass(pullRequestDetail)">
                         resolvePullRequestStateLabel(pullRequestDetail) 
                      </span>
                      <span> resolvePullRequestMeta(pullRequestDetail) </span>
                    </p>

                    <div class="source-control-pr-detail-stats">
                      <span class="source-control-pr-stat">
                        <span class="source-control-pr-stat-value">+ pullRequestDetail.additions ?? 0 </span>
                        <span class="source-control-pr-stat-label">新增</span>
                      </span>
                      <span class="source-control-pr-stat">
                        <span class="source-control-pr-stat-value">- pullRequestDetail.deletions ?? 0 </span>
                        <span class="source-control-pr-stat-label">删除</span>
                      </span>
                      <span class="source-control-pr-stat">
                        <span class="source-control-pr-stat-value"> pullRequestDetail.changedFiles ?? 0 </span>
                        <span class="source-control-pr-stat-label">文件</span>
                      </span>
                    </div>

                    <p v-if="pullRequestDetail.body" class="source-control-pr-detail-body">
                       pullRequestDetail.body 
                    </p>

                    <div v-if="isPullRequestOpen(pullRequestDetail)" class="source-control-pr-merge-row">
                      <select v-model="pullRequestMergeMethod" class="source-control-pr-select" :disabled="isBusy">
                        <option v-for="option in pullRequestMergeMethodOptions" :key="option.value"
                          :value="option.value">
                           option.label 
                        </option>
                      </select>

                      <div class="source-control-pr-actions">
                        <button type="button" class="source-control-pr-action-btn is-primary" :disabled="isBusy"
                          @click="handleMergePullRequest(pullRequestDetail)">
                          合并
                        </button>
                        <button type="button" class="source-control-pr-action-btn is-danger" :disabled="isBusy"
                          @click="handleClosePullRequest(pullRequestDetail)">
                          关闭
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              </template>

              <template v-else-if="pullRequestView === 'create'">
                <div class="source-control-pr-toolbar">
                  <button type="button" class="source-control-pr-back-btn" :disabled="isBusy"
                    @click="handleBackToPullRequestList">
                    ← 返回列表
                  </button>
                </div>

                <form class="source-control-pr-create-form" @submit.prevent="handleSubmitCreatePullRequest">
                  <label class="source-control-pr-field">
                    <span class="source-control-pr-field-label">标题</span>
                    <input v-model="createPullRequestTitle" type="text" class="source-control-pr-input"
                      placeholder="Pull Request 标题" :disabled="isCreatingPullRequest" spellcheck="false" />
                  </label>

                  <label class="source-control-pr-field">
                    <span class="source-control-pr-field-label">来源分支</span>
                    <input v-model="createPullRequestHead" type="text" class="source-control-pr-input"
                      placeholder="feature/your-branch" :disabled="isCreatingPullRequest" spellcheck="false" />
                  </label>

                  <label class="source-control-pr-field">
                    <span class="source-control-pr-field-label">目标分支</span>
                    <input v-model="createPullRequestBase" type="text" class="source-control-pr-input"
                      placeholder="main" :disabled="isCreatingPullRequest" spellcheck="false" />
                  </label>

                  <label class="source-control-pr-field">
                    <span class="source-control-pr-field-label">描述</span>
                    <textarea v-model="createPullRequestBody" class="source-control-pr-textarea" rows="4"
                      placeholder="可选的 Pull Request 描述" :disabled="isCreatingPullRequest" />
                  </label>

                  <label class="source-control-pr-draft-row">
                    <input v-model="createPullRequestDraft" type="checkbox" :disabled="isCreatingPullRequest" />
                    <span>创建为草稿</span>
                  </label>

                  <p v-if="createPullRequestError" class="source-control-pr-form-error">
                     createPullRequestError 
                  </p>

                  <div class="source-control-pr-actions">
                    <button type="button" class="source-control-pr-action-btn" :disabled="isCreatingPullRequest"
                      @click="handleBackToPullRequestList">
                      取消
                    </button>
                    <button type="submit" class="source-control-pr-action-btn is-primary"
                      :disabled="!canSubmitCreatePullRequest">
                       createPullRequestSubmitLabel 
                    </button>
                  </div>
                </form>
              </template>

              <template v-else>
                <div class="source-control-pr-toolbar">
                  <div class="source-control-pr-filter">
                    <button v-for="option in pullRequestStateOptions" :key="option.value" type="button"
                      class="source-control-pr-filter-btn"
                      :class="{ 'is-active': pullRequestStateFilter === option.value }"
                      :disabled="isBusy" @click="handleSelectPullRequestState(option.value)">
                       option.label 
                    </button>
                  </div>

                  <div class="source-control-pr-actions">
                    <button type="button" class="source-control-pr-icon-btn" aria-label="刷新 Pull Request 列表"
                      title="刷新 Pull Request 列表" :disabled="isPullRequestsLoading || isBusy"
                      @click="handleReloadPullRequests">
                      <span aria-hidden="true" class="icon-[lucide--refresh-cw]" />
                    </button>
                    <button type="button" class="source-control-pr-action-btn is-primary" :disabled="isBusy"
                      @click="handleOpenCreatePullRequest">
                      创建 PR
                    </button>
                  </div>
                </div>

                <p v-if="pullRequestActionError" class="source-control-pr-form-error">
                   pullRequestActionError 
                </p>

                <div v-if="isPullRequestsLoading && pullRequests.length === 0"
                  class="source-control-pr-skeleton" aria-hidden="true">
                  <span class="source-control-pr-skeleton-row is-title" />
                  <span class="source-control-pr-skeleton-row" />
                  <span class="source-control-pr-skeleton-row is-short" />
                </div>

                <div v-else-if="pullRequests.length > 0" class="source-control-pr-list">
                  <article v-for="pullRequest in pullRequests" :key="pullRequest.number"
                    class="source-control-pr-item" role="button" tabindex="0"
                    @click="handleOpenPullRequestDetail(pullRequest)"
                    @keydown.enter.prevent="handleOpenPullRequestDetail(pullRequest)">
                    <div class="source-control-pr-item-head">
                      <span class="source-control-pr-item-title">
                        # pullRequest.number  ·  pullRequest.title 
                      </span>
                      <span class="source-control-pr-state" :class="resolvePullRequestStateClass(pullRequest)">
                         resolvePullRequestStateLabel(pullRequest) 
                      </span>
                    </div>
                    <span class="source-control-pr-item-meta"> resolvePullRequestMeta(pullRequest) </span>
                  </article>
                </div>

                <p v-else class="source-control-info-note source-control-pr-empty"> pullRequestsEmptyText </p>
              </template>
            </div>`;

// 4) 应用到 Vue 文件
let vue = fs.readFileSync(VUE_PATH, 'utf8');
vue = replaceOnce(vue, 'S1 类型导入', S1_OLD, S1_NEW);
vue = replaceOnce(vue, 'S2 类型别名', S2_OLD, S2_NEW);
vue = replaceOnce(vue, 'S3a 计算属性', S3A_OLD, S3A_NEW);
vue = replaceOnce(vue, 'S3b 响应式状态', S3B_OLD, S3B_NEW);
vue = replaceOnce(vue, 'S4 列表辅助方法', S4_OLD, S4_NEW);
vue = replaceOnce(vue, 'S5 ensureActiveTabData', S5_OLD, S5_NEW);
vue = replaceOnce(vue, 'S6 列表/详情/合并/关闭', S6_OLD, S6_NEW);
vue = replaceOnce(vue, 'S7 创建 PR', S7_OLD, S7_NEW);
vue = replaceOnce(vue, 'S8 workspaceRootPath watch', S8_OLD, S8_NEW);
vue = replaceOnce(vue, 'S9 activeTab watch', S9_OLD, S9_NEW);
vue = replaceOnce(vue, 'T1 info-title gating', T1_OLD, T1_NEW);
vue = replaceOnce(vue, 'T2 info-text gating', T2_OLD, T2_NEW);
vue = replaceOnce(vue, 'T3 PR 外壳模板', T3_OLD, T3_NEW);
fs.writeFileSync(VUE_PATH, vue, 'utf8');
console.log('[written] ' + VUE_REL);

// 5) 修正 spec 断言（store 现在以对象入参调用 getGitPullRequestSupport）
let spec = fs.readFileSync(SPEC_PATH, 'utf8');
spec = replaceOnce(
  spec,
  'spec 断言',
  `    expect(tauriServiceMock.getGitPullRequestSupport).toHaveBeenCalledWith('D:/repo');`,
  `    expect(tauriServiceMock.getGitPullRequestSupport).toHaveBeenCalledWith({ repositoryRootPath: 'D:/repo' });`,
);
fs.writeFileSync(SPEC_PATH, spec, 'utf8');
console.log('[written] ' + SPEC_REL);

console.log('\n完成。建议接着执行：');
console.log('  pnpm tsc --noEmit');
console.log('  pnpm test -- SourceControlPanel');
console.log('  git add -A && git commit -m "feat(scm): 应用内 GitHub PR 面板（列表/详情/创建/合并/关闭）"');