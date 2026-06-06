// fix-pr-panel.js — 在仓库根目录运行：node fix-pr-panel.js
const fs = require('fs');
const { execSync } = require('child_process');

const REF = '55f574f75958907fc5d19272e0a738747f0013a1';
const VUE = 'src/components/workbench/SourceControlPanel.vue';
const SPEC = 'src/components/workbench/SourceControlPanel.spec.ts';
const SIDEBAR_CSS = 'src/styles/sidebar-source-control.css';
const PR_CSS_PATH = 'src/styles/sidebar-source-control-pr.css';

// —— 插值占位符还原：脚本里用 « »，写盘时变成真正的双花括号 ——
const OPEN = '{' + '{';
const CLOSE = '}' + '}';
const toMustache = (s) => s.replace(/«/g, OPEN).replace(/»/g, CLOSE);

// —— 工具 ——
const norm = (s) => s.replace(/\r\n/g, '\n');
const gitShow = (p) =>
  norm(execSync('git show ' + REF + ':' + p, { maxBuffer: 64 * 1024 * 1024 }).toString('utf8'));

const replaceOnce = (content, label, oldStr, newStr) => {
  const i = content.indexOf(oldStr);
  if (i === -1) throw new Error('[' + label + '] 未找到锚点，已中止（未写入任何文件）');
  if (content.indexOf(oldStr, i + 1) !== -1)
    throw new Error('[' + label + '] 锚点不唯一，已中止（未写入任何文件）');
  return content.slice(0, i) + newStr + content.slice(i + oldStr.length);
};

const replaceBetween = (content, label, startAnchor, endAnchor, block) => {
  const s = content.indexOf(startAnchor);
  if (s === -1) throw new Error('[' + label + '] 未找到起始锚点，已中止');
  const e = content.indexOf(endAnchor, s);
  if (e === -1) throw new Error('[' + label + '] 未找到结束锚点，已中止');
  return content.slice(0, s) + block + content.slice(e);
};

const writeOut = (p, lf) => {
  let eol = '\n';
  try {
    if (fs.readFileSync(p, 'utf8').includes('\r\n')) eol = '\r\n';
  } catch (_) {}
  fs.writeFileSync(p, eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf, 'utf8');
};

// ===================== Vue 脚本逻辑块（无反引号、无 ${}，全部字符串拼接） =====================
const PR_FEATURE_BLOCK = `
type TPullRequestView = 'list' | 'detail' | 'create';

const pullRequests = computed<IGitPullRequestSummaryPayload[]>(() => gitStore.pullRequests);
const isPullRequestsLoading = computed(() => gitStore.isPullRequestsLoading);
const pullRequestStateFilter = computed(() => gitStore.pullRequestStateFilter);
const pullRequestDetail = computed<IGitPullRequestDetailPayload | null>(
  () => gitStore.pullRequestDetail,
);
const isPullRequestDetailLoading = computed(() => gitStore.isPullRequestDetailLoading);

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

const pullRequestFilters: Array<{ key: 'open' | 'closed' | 'all'; label: string }> = [
  { key: 'open', label: '进行中' },
  { key: 'closed', label: '已关闭' },
  { key: 'all', label: '全部' },
];

const canSubmitCreatePullRequest = computed(
  () =>
    createPullRequestTitle.value.trim().length > 0 &&
    createPullRequestBase.value.trim().length > 0 &&
    createPullRequestHead.value.trim().length > 0,
);

const pullRequestsEmptyText = computed(() => {
  if (pullRequestStateFilter.value === 'closed') {
    return '当前没有已关闭的 Pull Request。';
  }
  if (pullRequestStateFilter.value === 'all') {
    return '这个仓库还没有任何 Pull Request。';
  }
  return '当前没有进行中的 Pull Request。';
});

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
  const segments: string[] = ['#' + pullRequest.number];
  if (pullRequest.author) {
    segments.push(pullRequest.author);
  }
  segments.push(pullRequest.headRef + ' → ' + pullRequest.baseRef);
  return segments.join(' · ');
};

const handleSelectPullRequestFilter = async (
  stateKey: 'open' | 'closed' | 'all',
): Promise<void> => {
  if (isPullRequestsLoading.value || stateKey === pullRequestStateFilter.value) {
    return;
  }
  try {
    await gitStore.loadPullRequests(stateKey);
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Pull Request 列表失败'));
  }
};

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
    await gitStore.loadPullRequests(pullRequestStateFilter.value);
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
    description: '将以 ' + mergeMethod.value + ' 方式合并 #' + pullRequest.number + '。',
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
    await gitStore.loadPullRequests(pullRequestStateFilter.value);
    pullRequestView.value = 'list';
    activePullRequestNumber.value = null;
    message.success('已合并 #' + pullRequest.number);
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
    description: '将关闭 #' + pullRequest.number + '，但不会合并改动。',
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
    await gitStore.loadPullRequests(pullRequestStateFilter.value);
    pullRequestView.value = 'list';
    activePullRequestNumber.value = null;
    message.success('已关闭 #' + pullRequest.number);
  } catch (error) {
    message.error(toErrorMessage(error, '关闭 Pull Request 失败'));
  } finally {
    isMutatingPullRequest.value = false;
  }
};
`.trim();

// ===================== Vue 模板（用 « » 占位，写盘时 toMustache 还原成插值） =====================
const PR_SECTION_RAW = `        <section v-else-if="activeTab === 'pull-requests'" class="source-control-pull-requests-panel">
          <div class="source-control-pull-requests-header">
            <p class="source-control-pull-requests-heading">Pull requests</p>
            <div class="source-control-pull-requests-header-actions">
              <span v-if="pullRequestSupport.available" class="source-control-pull-requests-provider">
                «pullRequestProviderLabel»
              </span>
              <button type="button" class="source-control-pull-requests-refresh" aria-label="刷新 Pull Request"
                title="刷新 Pull Request"
                :disabled="isPullRequestSupportLoading || isPullRequestsLoading || isSettingRemote || isBusy"
                @click="handleReloadPullRequestSupport">
                <span aria-hidden="true" class="icon-[lucide--refresh-cw]" />
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
                <div class="source-control-pr-toolbar">
                  <div class="source-control-pr-filter" role="tablist">
                    <button v-for="filter in pullRequestFilters" :key="filter.key" type="button"
                      class="source-control-pr-filter-btn"
                      :class="{ 'is-active': pullRequestStateFilter === filter.key }"
                      :disabled="isPullRequestsLoading" @click="handleSelectPullRequestFilter(filter.key)">
                      «filter.label»
                    </button>
                  </div>
                  <button type="button" class="source-control-pr-action-btn is-primary"
                    :disabled="isPullRequestsLoading || isBusy" @click="handleStartCreatePullRequest">
                    新建 PR
                  </button>
                </div>

                <div v-if="isPullRequestsLoading && pullRequests.length === 0" class="source-control-pr-skeleton">
                  <span class="source-control-pr-skeleton-row is-title" />
                  <span class="source-control-pr-skeleton-row" />
                  <span class="source-control-pr-skeleton-row is-short" />
                </div>

                <div v-else-if="pullRequests.length > 0" class="source-control-pr-list">
                  <button v-for="pullRequest in pullRequests" :key="pullRequest.number" type="button"
                    class="source-control-pr-item" @click="handleOpenPullRequest(pullRequest.number)">
                    <span class="source-control-pr-item-head">
                      <span class="source-control-pr-item-title">«pullRequest.title»</span>
                      <span class="source-control-pr-state" :class="'is-' + resolvePullRequestStateTone(pullRequest)">
                        «resolvePullRequestStateLabel(pullRequest)»
                      </span>
                    </span>
                    <span class="source-control-pr-item-meta">«resolvePullRequestMeta(pullRequest)»</span>
                  </button>
                </div>

                <p v-else class="source-control-pr-empty">«pullRequestsEmptyText»</p>
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
                    <span class="source-control-pr-detail-title">«pullRequestDetail.title»</span>
                    <span class="source-control-pr-state" :class="'is-' + resolvePullRequestStateTone(pullRequestDetail)">
                      «resolvePullRequestStateLabel(pullRequestDetail)»
                    </span>
                  </div>
                  <p class="source-control-pr-detail-meta">«resolvePullRequestMeta(pullRequestDetail)»</p>
                  <div class="source-control-pr-detail-stats">
                    <span class="source-control-pr-stat is-add">+«pullRequestDetail.additions ?? 0»</span>
                    <span class="source-control-pr-stat is-del">-«pullRequestDetail.deletions ?? 0»</span>
                    <span class="source-control-pr-stat">«pullRequestDetail.changedFiles ?? 0» 个文件</span>
                  </div>
                  <p v-if="pullRequestDetail.body" class="source-control-pr-detail-body">«pullRequestDetail.body»</p>
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
                  <p v-if="createPullRequestError" class="source-control-pr-form-error">«createPullRequestError»</p>
                  <div class="source-control-pr-create-actions">
                    <button type="button" class="source-control-pr-action-btn"
                      :disabled="isCreatingPullRequest" @click="handleBackToPullRequestList">取消</button>
                    <button type="submit" class="source-control-pr-action-btn is-primary"
                      :disabled="isCreatingPullRequest || !canSubmitCreatePullRequest">
                      «isCreatingPullRequest ? '创建中…' : '创建 PR'»
                    </button>
                  </div>
                </form>
              </template>
            </template>

            <template v-else>
              <p class="source-control-info-title">«pullRequestPanelTitle»</p>
              <p class="source-control-info-text">«pullRequestPanelText»</p>
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
                <p v-if="remoteFormError" class="source-control-pr-form-error">«remoteFormError»</p>
                <div class="source-control-pr-create-actions">
                  <button type="button" class="source-control-pr-action-btn"
                    :disabled="isSettingRemote" @click="handleCancelRemoteForm">取消</button>
                  <button type="submit" class="source-control-pr-action-btn is-primary"
                    :disabled="isSettingRemote || !canSubmitRemoteForm">
                    «isSettingRemote ? '保存中…' : '保存'»
                  </button>
                </div>
              </form>
            </div>
          </template>
        </section>`;

// ===================== PR 面板样式（整体重写，扁平 / 现代 / 与侧栏同源变量） =====================
const PR_CSS = `
.source-control-pr-skeleton { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
.source-control-pr-skeleton-row {
  height: 12px; border-radius: 6px;
  background: linear-gradient(90deg, var(--scm-bg-elev) 25%, var(--scm-bg-hover) 37%, var(--scm-bg-elev) 63%);
  background-size: 400% 100%; animation: source-control-pr-shimmer 1.4s ease infinite;
}
.source-control-pr-skeleton-row.is-title { width: 60%; height: 14px; }
.source-control-pr-skeleton-row.is-short { width: 40%; }
@keyframes source-control-pr-shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }

.source-control-pr-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.source-control-pr-filter { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--scm-bg-elev); }
.source-control-pr-filter-btn {
  appearance: none; border: 0; background: transparent; color: var(--scm-text-dim);
  font-size: 12px; line-height: 1; padding: 6px 10px; border-radius: 6px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.source-control-pr-filter-btn:hover { color: var(--scm-text); }
.source-control-pr-filter-btn.is-active { background: var(--scm-bg-active); color: var(--scm-text); }
.source-control-pr-filter-btn:disabled { opacity: 0.5; cursor: default; }

.source-control-pr-action-btn {
  appearance: none; border: 1px solid var(--scm-border); background: var(--scm-bg-elev); color: var(--scm-text);
  font-size: 12px; padding: 6px 12px; border-radius: 7px; cursor: pointer; white-space: nowrap;
  transition: background 120ms ease, border-color 120ms ease, filter 120ms ease, opacity 120ms ease;
}
.source-control-pr-action-btn:hover { background: var(--scm-bg-hover); }
.source-control-pr-action-btn.is-primary { border-color: transparent; background: var(--scm-accent); color: var(--primary-foreground, #fff); }
.source-control-pr-action-btn.is-primary:hover { filter: brightness(1.06); }
.source-control-pr-action-btn.is-danger { border-color: transparent; background: var(--danger, var(--scm-red)); color: #fff; }
.source-control-pr-action-btn:disabled { opacity: 0.5; cursor: default; }

.source-control-pr-list { display: flex; flex-direction: column; gap: 2px; }
.source-control-pr-item {
  appearance: none; text-align: left; border: 0; background: transparent; color: var(--scm-text);
  display: flex; flex-direction: column; gap: 4px; padding: 10px; border-radius: 8px; cursor: pointer;
  transition: background 120ms ease;
}
.source-control-pr-item:hover { background: var(--scm-bg-hover); }
.source-control-pr-item-head { display: flex; align-items: center; gap: 8px; }
.source-control-pr-item-title {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.source-control-pr-item-meta { font-size: 11px; color: var(--scm-text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.source-control-pr-state {
  flex-shrink: 0; font-size: 11px; line-height: 1; padding: 3px 8px; border-radius: 999px; border: 1px solid transparent;
}
.source-control-pr-state.is-open { color: var(--scm-green); border-color: color-mix(in srgb, var(--scm-green) 40%, transparent); background: color-mix(in srgb, var(--scm-green) 12%, transparent); }
.source-control-pr-state.is-merged { color: var(--scm-accent); border-color: color-mix(in srgb, var(--scm-accent) 40%, transparent); background: color-mix(in srgb, var(--scm-accent) 12%, transparent); }
.source-control-pr-state.is-closed { color: var(--scm-red); border-color: color-mix(in srgb, var(--scm-red) 40%, transparent); background: color-mix(in srgb, var(--scm-red) 12%, transparent); }
.source-control-pr-state.is-draft { color: var(--scm-text-faint); border-color: var(--scm-border); background: var(--scm-bg-elev); }

.source-control-pr-empty { font-size: 12px; color: var(--scm-text-faint); padding: 16px 4px; text-align: center; }

.source-control-pr-back-btn {
  appearance: none; border: 0; background: transparent; color: var(--scm-text-dim);
  display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 0; cursor: pointer; align-self: flex-start;
}
.source-control-pr-back-btn:hover { color: var(--scm-text); }

.source-control-pr-detail { display: flex; flex-direction: column; gap: 12px; }
.source-control-pr-detail-head { display: flex; align-items: flex-start; gap: 8px; }
.source-control-pr-detail-title { flex: 1; font-size: 15px; font-weight: 600; line-height: 1.4; }
.source-control-pr-detail-meta { font-size: 12px; color: var(--scm-text-faint); }
.source-control-pr-detail-stats { display: flex; gap: 14px; font-size: 12px; color: var(--scm-text-dim); }
.source-control-pr-stat.is-add { color: var(--scm-green); }
.source-control-pr-stat.is-del { color: var(--scm-red); }
.source-control-pr-detail-body { font-size: 13px; line-height: 1.6; color: var(--scm-text); white-space: pre-wrap; word-break: break-word; }
.source-control-pr-detail-body.is-empty { color: var(--scm-text-faint); }

.source-control-pr-merge-row { display: flex; align-items: flex-end; gap: 8px; }
.source-control-pr-merge-row .source-control-pr-field { flex: 1; min-width: 0; }
.source-control-pr-select {
  flex: 1; min-width: 0; appearance: none; border: 1px solid var(--scm-border); background: var(--scm-bg-elev);
  color: var(--scm-text); font-size: 12px; padding: 7px 10px; border-radius: 7px; cursor: pointer;
}

.source-control-pr-create-form { display: flex; flex-direction: column; gap: 12px; }
.source-control-pr-field { display: flex; flex-direction: column; gap: 6px; }
.source-control-pr-field-label { font-size: 11px; color: var(--scm-text-dim); }
.source-control-pr-input, .source-control-pr-textarea {
  width: 100%; border: 1px solid var(--scm-border); background: var(--scm-bg-elev); color: var(--scm-text);
  font-size: 13px; padding: 8px 10px; border-radius: 7px; outline: none;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.source-control-pr-input:focus, .source-control-pr-textarea:focus {
  border-color: var(--scm-accent);
  box-shadow: 0 0 0 2px var(--settings-accent-soft, color-mix(in srgb, var(--scm-accent) 24%, transparent));
}
.source-control-pr-input.is-invalid { border-color: var(--scm-red); }
.source-control-pr-textarea { resize: vertical; min-height: 80px; font-family: inherit; }
.source-control-pr-draft-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--scm-text-dim); cursor: pointer; }
.source-control-pr-form-error { font-size: 12px; color: var(--scm-red); }
.source-control-pr-create-actions { display: flex; justify-content: flex-end; gap: 8px; }
`;

// ===================== 组装 Vue =====================
let vue = gitShow(VUE);

vue = replaceOnce(vue, 'V1',
`  IGitFileStatusPayload,
  IGitPullRequestSupportPayload,`,
`  IGitFileStatusPayload,
  IGitPullRequestDetailPayload,
  IGitPullRequestSummaryPayload,
  IGitPullRequestSupportPayload,`);

const V2 = `const canSubmitRemoteForm = computed(
  () => remoteNameInput.value.trim().length > 0 && remoteUrlInput.value.trim().length > 0,
);`;
vue = replaceOnce(vue, 'V2', V2, V2 + '\n\n' + PR_FEATURE_BLOCK);

vue = replaceOnce(vue, 'V3',
`const canOpenPullRequestList = computed(() =>
  Boolean(pullRequestSupport.value.pullRequestsUrl ?? pullRequestSupport.value.repositoryUrl),
);

const canOpenPullRequestCreate = computed(() =>
  Boolean(
    pullRequestSupport.value.createPullRequestUrl ??
      pullRequestSupport.value.pullRequestsUrl ??
      pullRequestSupport.value.repositoryUrl,
  ),
);

`, '');

vue = replaceOnce(vue, 'V4',
`const handleOpenPullRequestList = (): void => {
  const targetUrl =
    pullRequestSupport.value.pullRequestsUrl ?? pullRequestSupport.value.repositoryUrl;
  if (!targetUrl) {
    message.warning('当前没有可打开的 Pull Request 列表。');
    return;
  }

  openExternalUrl(targetUrl);
};

`, '');

vue = replaceOnce(vue, 'V5',
`const handleReloadPullRequestSupport = async (): Promise<void> => {
  try {
    await gitStore.loadPullRequestSupport();
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Pull Request 支持信息失败'));
  }
};`,
`const handleReloadPullRequestSupport = async (): Promise<void> => {
  try {
    await Promise.all([gitStore.loadPullRequestSupport(), gitStore.loadPullRequests()]);
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Pull Request 列表失败'));
  }
};`);

vue = replaceOnce(vue, 'V6',
`const handleOpenCreatePullRequest = (): void => {
  const targetUrl =
    pullRequestSupport.value.createPullRequestUrl ??
    pullRequestSupport.value.pullRequestsUrl ??
    pullRequestSupport.value.repositoryUrl;
  if (!targetUrl) {
    message.warning('当前没有可打开的 Pull Request 创建入口。');
    return;
  }

  openExternalUrl(targetUrl);
};

`, '');

vue = replaceOnce(vue, 'V7',
`    if (tabKey === 'stash') {
      await gitStore.loadStashes();
      return;
    }

    await gitStore.loadPullRequestSupport();
  } catch (error) {`,
`    if (tabKey === 'stash') {
      await gitStore.loadStashes();
      return;
    }

    await Promise.all([gitStore.loadPullRequestSupport(), gitStore.loadPullRequests()]);
  } catch (error) {`);

vue = replaceOnce(vue, 'V8',
`    isRemoteFormOpen.value = false;
    remoteFormError.value = null;
    closeSourceControlMenu();
    resetSectionCollapse();`,
`    isRemoteFormOpen.value = false;
    remoteFormError.value = null;
    pullRequestView.value = 'list';
    activePullRequestNumber.value = null;
    closeSourceControlMenu();
    resetSectionCollapse();`);

vue = replaceOnce(vue, 'V9',
`  (nextTab) => {
    if (!hasRepository.value || nextTab === 'changes') {
      return;
    }

    void ensureActiveTabData(nextTab);
  },`,
`  (nextTab) => {
    if (nextTab === 'pull-requests') {
      pullRequestView.value = 'list';
      activePullRequestNumber.value = null;
    }

    if (!hasRepository.value || nextTab === 'changes') {
      return;
    }

    void ensureActiveTabData(nextTab);
  },`);

const SECTION_START = `        <section v-else-if="activeTab === 'pull-requests'"
          class="source-control-info-panel source-control-pull-requests-panel">`;
const SECTION_END = `        <section v-else class="source-control-info-panel source-control-stash-panel">`;
vue = replaceBetween(vue, 'V10', SECTION_START, SECTION_END, toMustache(PR_SECTION_RAW) + '\n\n');

// ===================== 侧栏 CSS：去掉框框、改平铺 =====================
let sidebarCss = norm(fs.readFileSync(SIDEBAR_CSS, 'utf8'));
const SIDEBAR_RE = /\.source-control-pull-requests-panel\s*\{/;
if (!SIDEBAR_RE.test(sidebarCss)) {
  throw new Error('[CSS] 未找到 .source-control-pull-requests-panel 规则，已中止');
}
sidebarCss = sidebarCss.replace(SIDEBAR_RE,
  '.source-control-pull-requests-panel {\n' +
  '  margin: 0;\n  border: 0;\n  border-radius: 0;\n  background: transparent;\n  padding: 12px 14px 14px;');

// ===================== spec 断言修正（best-effort，匹配不到也不影响界面写入） =====================
let specOut = null;
try {
  const spec = gitShow(SPEC);
  specOut = replaceOnce(spec, 'SPEC',
    "    expect(tauriServiceMock.getGitPullRequestSupport).toHaveBeenCalledWith('D:/repo');",
    "    expect(tauriServiceMock.getGitPullRequestSupport).toHaveBeenCalledWith({ repositoryRootPath: 'D:/repo' });");
} catch (error) {
  console.warn('[SPEC] 跳过测试断言修正：' + error.message);
}

// ===================== 全部转换成功后再写盘 =====================
writeOut(VUE, vue);
writeOut(SIDEBAR_CSS, sidebarCss);
writeOut(PR_CSS_PATH, PR_CSS.trim() + '\n');
if (specOut) writeOut(SPEC, specOut);

console.log('✅ 已更新：');
console.log('  - ' + VUE);
console.log('  - ' + SIDEBAR_CSS + '（移除卡片边框，改平铺）');
console.log('  - ' + PR_CSS_PATH + '（整体重写为现代扁平样式）');
console.log(specOut ? '  - ' + SPEC + '（已修正断言）' : '  - 跳过 spec（锚点未命中，稍后手动改）');