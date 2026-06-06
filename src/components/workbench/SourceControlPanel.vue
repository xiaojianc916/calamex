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
            <span class="source-control-setup-project-name"> workspaceLabel </span>
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
               sourceControlActionError 
            </p>

            <div class="source-control-setup-actions">
              <button type="button" class="source-control-setup-btn source-control-setup-btn-primary"
                :disabled="isBusy || isLoading" :aria-busy="pendingAction === 'init-repository'"
                @click="handleInitRepository">
                 initRepositoryButtonLabel 
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
          <p class="source-control-branch-name"> branchLabel </p>
        </div>

        <div class="source-control-branch-sync">
          <span v-if="status.behind > 0">↓  status.behind </span>
          <span v-if="status.ahead > 0">↑  status.ahead </span>
          <span v-if="status.ahead === 0 && status.behind === 0"> workspaceStateLabel </span>
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

          <span class="source-control-nav-label"> item.label </span>
          <span class="source-control-nav-count"> item.count </span>
        </button>
      </nav>

      <div class="source-control-scroll">
        <template v-if="activeTab === 'changes'">
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
        </template>

        <section v-else-if="activeTab === 'history'" class="source-control-info-panel source-control-history-panel">
          <div class="source-control-history-header">
            <p class="source-control-history-heading">History</p>
            <div class="source-control-history-header-actions">
              <button type="button" class="source-control-history-refresh" aria-label="刷新历史" title="刷新历史"
                :disabled="isCommitHistoryLoading || isBusy" @click="handleReloadCommitHistory">
                <span aria-hidden="true" class="icon-[lucide--refresh-cw]" />
              </button>
              <p class="source-control-history-summary"> historyPanelTitle </p>
            </div>
          </div>

          <div v-if="isCommitHistoryLoading && filteredCommitHistory.length === 0"
            class="source-control-info-note source-control-history-note">
            正在读取 Git 提交历史…
          </div>

          <GitHistoryGraph
            v-else-if="filteredCommitHistory.length > 0"
            :commits="filteredCommitHistory"
            :ahead="status.ahead"
            :behind="status.behind"
          />

          <p v-else class="source-control-info-note source-control-history-note"> historyEmptyText </p>
        </section>

        <section v-else-if="activeTab === 'branches'"
          class="source-control-info-panel source-control-branches-panel">
          <div class="source-control-branches-header">
            <p class="source-control-branches-heading">Branches</p>
            <div class="source-control-branches-header-actions">
              <button type="button" class="source-control-branches-refresh" aria-label="刷新分支" title="刷新分支"
                :disabled="isBranchesLoading || isBusy" @click="handleReloadBranches">
                <span aria-hidden="true" class="icon-[lucide--refresh-cw]" />
              </button>
              <p class="source-control-branches-summary"> branchesPanelSummary </p>
            </div>
          </div>

          <p v-if="status.isDetached" class="source-control-info-note source-control-branches-detached">
            当前处于 detached HEAD，切换分支前请确认工作区已处理干净。
          </p>

          <div class="source-control-branch-create">
            <button v-if="!isBranchCreateOpen" type="button" class="source-control-branch-create-trigger"
              :disabled="isBusy" @click="openBranchCreate">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              <span>新建分支</span>
            </button>

            <form v-else class="source-control-branch-create-form" @submit.prevent="submitBranchCreate">
              <input ref="branchNameInputRef" v-model="branchCreateName" type="text"
                class="source-control-branch-create-input" :class="{ 'is-invalid': Boolean(branchCreateError) }"
                placeholder="新分支名称，基于当前 HEAD" :disabled="isBusy" autocomplete="off" spellcheck="false"
                @input="branchCreateError = null" @keydown.esc.prevent="cancelBranchCreate" />

              <div class="source-control-branch-create-actions">
                <button type="button" class="source-control-branch-create-btn" :disabled="isBusy"
                  @click="cancelBranchCreate">
                  取消
                </button>
                <button type="submit"
                  class="source-control-branch-create-btn source-control-branch-create-btn-primary"
                  :disabled="isBusy || branchCreateName.trim().length === 0">
                  创建并切换
                </button>
              </div>

              <p v-if="branchCreateError" class="source-control-branch-create-error"> branchCreateError </p>
            </form>
          </div>

          <div v-if="isBranchesLoading && filteredBranchEntries.length === 0"
            class="source-control-info-note source-control-branches-note">
            正在读取 Git 分支…
          </div>

          <template v-else-if="filteredBranchEntries.length > 0">
            <section v-for="group in branchGroups" :key="group.key" class="source-control-branch-group">
              <div class="source-control-branch-group-header">
                <span> group.title </span>
                <span class="source-control-branch-group-count"> group.entries.length </span>
              </div>

              <div class="source-control-branch-list">
                <article v-for="entry in group.entries" :key="entry.name" class="source-control-branch-row"
                  :class="{ 'is-current': entry.isCurrent }" :role="entry.isCurrent ? undefined : 'button'"
                  :tabindex="entry.isCurrent ? undefined : 0"
                  :aria-current="entry.isCurrent ? 'true' : undefined" @click="handleCheckoutBranch(entry)"
                  @keydown.enter.prevent="handleCheckoutBranch(entry)">
                  <svg class="source-control-branch-row-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="6" cy="6" r="2" />
                    <circle cx="18" cy="4" r="2" />
                    <circle cx="18" cy="18" r="2" />
                    <path d="M8 6h4a4 4 0 0 1 4 4v6" />
                    <path d="M16 6v2" />
                  </svg>

                  <div class="source-control-branch-row-body">
                    <span class="source-control-branch-row-name"> entry.shorthand </span>
                    <span v-if="resolveBranchMeta(entry)" class="source-control-branch-row-meta"> resolveBranchMeta(entry) </span>
                  </div>

                  <span v-if="entry.isCurrent" class="source-control-branch-row-current">当前</span>
                  <span v-else aria-hidden="true" class="source-control-branch-row-switch">切换</span>
                </article>
              </div>
            </section>
          </template>

          <p v-else class="source-control-info-note source-control-branches-note"> branchesEmptyText </p>
        </section>

        <section v-else-if="activeTab === 'pull-requests'"
          class="source-control-info-panel source-control-pull-requests-panel">
          <div class="source-control-pull-requests-header">
            <p class="source-control-pull-requests-heading">Pull requests</p>
            <div class="source-control-pull-requests-header-actions">
              <span v-if="pullRequestSupport.available" class="source-control-pull-requests-provider">
                 pullRequestProviderLabel 
              </span>
              <button type="button" class="source-control-pull-requests-refresh" aria-label="刷新 Pull Request 支持"
                title="刷新 Pull Request 支持"
                :disabled="isPullRequestSupportLoading || isSettingRemote || isBusy"
                @click="handleReloadPullRequestSupport">
                <span aria-hidden="true" class="icon-[lucide--refresh-cw]" />
              </button>
            </div>
          </div>

          <div v-if="isPullRequestSupportLoading" class="source-control-pull-requests-skeleton" aria-hidden="true">
            <span class="source-control-pull-requests-skeleton-line is-title" />
            <span class="source-control-pull-requests-skeleton-line" />
            <span class="source-control-pull-requests-skeleton-line is-short" />
          </div>

          <template v-else>
            <template v-if="!pullRequestSupport.available">
              <p class="source-control-info-title"> pullRequestPanelTitle </p>
              <p class="source-control-info-text"> pullRequestPanelText </p>
            </template>

            <p v-if="pullRequestSupport.remoteName" class="source-control-info-note">
              远程  pullRequestSupport.remoteName  ·  pullRequestProviderLabel 
            </p>

            <div v-if="pullRequestSupport.available" class="source-control-pr-shell">
              <template v-if="pullRequestView === 'detail'">
                <button type="button" class="source-control-pr-back-btn" :disabled="isBusy"
                  @click="handleBackToPullRequestList">
                  ← 返回列表
                </button>

                <div v-if="isPullRequestDetailLoading && !pullRequestDetail"
                  class="source-control-pr-skeleton" aria-hidden="true">
                  <span class="source-control-pr-skeleton-row" />
                  <span class="source-control-pr-skeleton-row" />
                </div>

                <div v-else-if="pullRequestDetail" class="source-control-pr-detail">
                  <div class="source-control-pr-detail-card">
                    <div class="source-control-pr-item-head">
                      <h3 class="source-control-pr-detail-title">
                        # pullRequestDetail.number   pullRequestDetail.title 
                      </h3>
                      <span class="source-control-pr-state"
                        :class="resolvePullRequestStateClass(pullRequestDetail)">
                         resolvePullRequestStateLabel(pullRequestDetail) 
                      </span>
                    </div>

                    <p class="source-control-pr-detail-meta">
                       resolvePullRequestMeta(pullRequestDetail) 
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

                    <p v-if="pullRequestActionError" class="source-control-pr-form-error">
                       pullRequestActionError 
                    </p>

                    <div v-if="isPullRequestOpen(pullRequestDetail)" class="source-control-pr-merge-row">
                      <select v-model="pullRequestMergeMethod" class="source-control-pr-select"
                        :disabled="isBusy">
                        <option v-for="option in pullRequestMergeMethodOptions" :key="option.value"
                          :value="option.value">
                           option.label 
                        </option>
                      </select>
                      <button type="button" class="source-control-pr-action-btn is-primary"
                        :disabled="isBusy" @click="handleMergePullRequest">
                        合并
                      </button>
                      <button type="button" class="source-control-pr-action-btn is-danger"
                        :disabled="isBusy" @click="handleClosePullRequest">
                        关闭
                      </button>
                    </div>
                  </div>
                </div>

                <p v-else class="source-control-info-note">未能读取该 Pull Request 的详情。</p>
              </template>

              <template v-else-if="pullRequestView === 'create'">
                <button type="button" class="source-control-pr-back-btn" :disabled="isCreatingPullRequest"
                  @click="handleBackToPullRequestList">
                  ← 返回列表
                </button>

                <form class="source-control-pr-create" @submit.prevent="handleSubmitCreatePullRequest">
                  <div class="source-control-pr-create-form">
                    <label class="source-control-pr-field">
                      <span class="source-control-pr-field-label">标题</span>
                      <input v-model="createPullRequestTitle" type="text" class="source-control-pr-input"
                        placeholder="Pull Request 标题" :disabled="isCreatingPullRequest" spellcheck="false" />
                    </label>

                    <label class="source-control-pr-field">
                      <span class="source-control-pr-field-label">来源分支 (head)</span>
                      <input v-model="createPullRequestHead" type="text" class="source-control-pr-input"
                        placeholder="feature/your-branch" :disabled="isCreatingPullRequest" spellcheck="false" />
                    </label>

                    <label class="source-control-pr-field">
                      <span class="source-control-pr-field-label">目标分支 (base)</span>
                      <input v-model="createPullRequestBase" type="text" class="source-control-pr-input"
                        placeholder="main" :disabled="isCreatingPullRequest" spellcheck="false" />
                    </label>

                    <label class="source-control-pr-field">
                      <span class="source-control-pr-field-label">描述（可选）</span>
                      <textarea v-model="createPullRequestBody" class="source-control-pr-textarea" rows="4"
                        placeholder="补充说明此次改动…" :disabled="isCreatingPullRequest" spellcheck="false" />
                    </label>

                    <label class="source-control-pr-draft-row">
                      <input v-model="createPullRequestDraft" type="checkbox" :disabled="isCreatingPullRequest" />
                      <span>创建为草稿 PR</span>
                    </label>

                    <p v-if="createPullRequestError" class="source-control-pr-form-error">
                       createPullRequestError 
                    </p>

                    <div class="source-control-pr-merge-row">
                      <button type="button" class="source-control-pr-action-btn"
                        :disabled="isCreatingPullRequest" @click="handleBackToPullRequestList">
                        取消
                      </button>
                      <button type="submit" class="source-control-pr-action-btn is-primary"
                        :disabled="isCreatingPullRequest || !canSubmitCreatePullRequest">
                         createPullRequestSubmitLabel 
                      </button>
                    </div>
                  </div>
                </form>
              </template>

              <template v-else>
                <div class="source-control-pr-toolbar">
                  <div class="source-control-pr-filter" role="group" aria-label="Pull Request 状态筛选">
                    <button v-for="option in pullRequestStateOptions" :key="option.value" type="button"
                      class="source-control-pr-filter-btn"
                      :class="{ 'is-active': pullRequestStateFilter === option.value }"
                      :disabled="isPullRequestsLoading || isBusy"
                      @click="handleSelectPullRequestState(option.value)">
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
                      新建 PR
                    </button>
                  </div>
                </div>

                <div v-if="isPullRequestsLoading && pullRequests.length === 0"
                  class="source-control-pr-skeleton" aria-hidden="true">
                  <span class="source-control-pr-skeleton-row" />
                  <span class="source-control-pr-skeleton-row" />
                  <span class="source-control-pr-skeleton-row" />
                </div>

                <div v-else-if="pullRequests.length > 0" class="source-control-pr-list">
                  <button v-for="pr in pullRequests" :key="pr.number" type="button"
                    class="source-control-pr-item" @click="handleOpenPullRequestDetail(pr)">
                    <span class="source-control-pr-item-head">
                      <span class="source-control-pr-item-title"># pr.number   pr.title </span>
                      <span class="source-control-pr-state" :class="resolvePullRequestStateClass(pr)">
                         resolvePullRequestStateLabel(pr) 
                      </span>
                    </span>
                    <span class="source-control-pr-item-meta"> resolvePullRequestMeta(pr) </span>
                  </button>
                </div>

                <p v-else class="source-control-info-note"> pullRequestsEmptyText </p>
              </template>
            </div>

            <div class="source-control-pull-requests-config">
              <button v-if="!isRemoteFormOpen" type="button"
                class="source-control-btn source-control-pull-requests-config-trigger"
                :disabled="isSettingRemote || isBusy" @click="handleOpenRemoteForm">
                 pullRequestSupport.remoteName ? '修改远程地址' : '配置远程地址' 
              </button>

              <form v-else class="source-control-pull-requests-form" @submit.prevent="handleSubmitRemoteForm">
                <label class="source-control-pull-requests-field">
                  <span class="source-control-pull-requests-field-label">远程名称</span>
                  <input v-model="remoteNameInput" type="text" class="source-control-pull-requests-input"
                    placeholder="origin" :disabled="isSettingRemote" spellcheck="false" />
                </label>

                <label class="source-control-pull-requests-field">
                  <span class="source-control-pull-requests-field-label">远程地址</span>
                  <input v-model="remoteUrlInput" type="text"
                    class="source-control-pull-requests-input"
                    :class="{ 'is-invalid': Boolean(remoteFormError) }"
                    placeholder="https://github.com/owner/repo.git" :disabled="isSettingRemote"
                    spellcheck="false" />
                </label>

                <p v-if="remoteFormError" class="source-control-pull-requests-form-error">
                   remoteFormError 
                </p>

                <div class="source-control-pull-requests-form-actions">
                  <button type="button"
                    class="source-control-btn source-control-pull-requests-form-btn"
                    :disabled="isSettingRemote" @click="handleCancelRemoteForm">
                    取消
                  </button>
                  <button type="submit"
                    class="source-control-btn source-control-btn-primary source-control-pull-requests-form-btn"
                    :disabled="isSettingRemote || !canSubmitRemoteForm">
                     isSettingRemote ? '保存中…' : '保存远程' 
                  </button>
                </div>
              </form>
            </div>
          </template>
        </section>

        <section v-else class="source-control-info-panel source-control-stash-panel">
          <div class="source-control-stash-header">
            <p class="source-control-stash-heading">贮藏</p>
            <p class="source-control-stash-summary"> stashPanelTitle </p>
          </div>

          <div class="source-control-stash-toolbar">
            <button type="button" class="source-control-btn source-control-btn-primary source-control-stash-toolbar-btn"
              :disabled="isStashesLoading || isBusy || totalChangeCount === 0" @click="handleSaveStash">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19 14V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v8" />
                <path d="m5 14 7 4 7-4" />
              </svg>
              <span>贮藏当前改动</span>
            </button>

            <button type="button" class="source-control-btn source-control-stash-toolbar-btn"
              :disabled="isStashesLoading || isBusy" @click="handleReloadStashes">
              <span aria-hidden="true" class="icon-[lucide--refresh-cw]" />
              <span>刷新</span>
            </button>
          </div>

          <div v-if="isStashesLoading && filteredStashEntries.length === 0"
            class="source-control-info-note source-control-stash-note">
            正在读取 Git 贮藏…
          </div>

          <div v-else-if="filteredStashEntries.length > 0" class="source-control-stash-list">
            <article v-for="entry in filteredStashEntries" :key="entry.stashId" class="source-control-stash-item"
              :class="{ 'is-open': isStashOpen(entry.stashId) }">
              <button type="button" class="source-control-stash-head" :aria-expanded="isStashOpen(entry.stashId)"
                @click="toggleStashOpen(entry.stashId)">
                <span class="source-control-stash-ref"> resolveStashIndexLabel(entry) </span>

                <span class="source-control-stash-info">
                  <span class="source-control-stash-title"> resolveStashTitle(entry) </span>
                  <span class="source-control-stash-meta"> resolveStashMeta(entry) </span>
                </span>

                <svg class="source-control-stash-chevron" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>

              <div v-if="isStashOpen(entry.stashId)" class="source-control-stash-body">
                <div class="source-control-stash-details">
                  <div class="source-control-stash-detail">
                    <span class="source-control-stash-detail-label">引用</span>
                    <span class="source-control-stash-detail-value"> entry.stashId </span>
                  </div>

                  <div v-if="entry.branchName" class="source-control-stash-detail">
                    <span class="source-control-stash-detail-label">分支</span>
                    <span class="source-control-stash-detail-value"> entry.branchName </span>
                  </div>

                  <div v-if="entry.commitShortId" class="source-control-stash-detail">
                    <span class="source-control-stash-detail-label">基线</span>
                    <span class="source-control-stash-detail-value"> entry.commitShortId </span>
                  </div>
                </div>

                <div class="source-control-stash-actions">
                  <button type="button" class="source-control-btn source-control-stash-action-btn" :disabled="isBusy"
                    @click.stop="handleApplyStash(entry, false)">
                    应用
                  </button>
                  <button type="button" class="source-control-btn source-control-stash-action-btn" :disabled="isBusy"
                    @click.stop="handleApplyStash(entry, true)">
                    应用并删除
                  </button>
                  <button type="button"
                    class="source-control-btn source-control-stash-action-btn source-control-stash-action-btn-danger"
                    :disabled="isBusy" @click.stop="handleDropStash(entry)">
                    丢弃
                  </button>
                </div>
              </div>
            </article>
          </div>

          <p v-else class="source-control-info-note source-control-stash-note"> stashEmptyText </p>
        </section>
      </div>

      <footer v-if="activeTab === 'changes'" class="source-control-commit">
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
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import LinearContextMenu from '@/components/common/LinearContextMenu.vue';
import type { ILinearContextMenuItem } from '@/components/common/linear-context-menu.types';
import GitHistoryGraph from '@/components/workbench/GitHistoryGraph.vue';
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
  IGitPullRequestDetailPayload,
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

type TGitNavKey = 'changes' | 'history' | 'branches' | 'pull-requests' | 'stash';
type TPullRequestView = 'list' | 'detail' | 'create';
type TPullRequestStateFilter = 'open' | 'closed' | 'all';
type TPullRequestMergeMethod = 'merge' | 'squash' | 'rebase';
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
const pendingAction = ref<string | null>(null);
const isBranchCreateOpen = ref(false);
const branchCreateName = ref('');
const branchCreateError = ref<string | null>(null);
const branchNameInputRef = ref<HTMLInputElement | null>(null);
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

const promptForText = (title: string, defaultValue = ''): string | null => {
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') {
    return null;
  }

  return window.prompt(title, defaultValue);
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

    await gitStore.loadPullRequestSupport();
    if (pullRequestSupport.value.available) {
      await gitStore.loadPullRequests(pullRequestStateFilter.value);
    }
  } catch (error) {
    const fallbackMessage =
      tabKey === 'history'
        ? '读取 Git 提交历史失败'
        : tabKey === 'branches'
          ? '读取 Git 分支失败'
          : tabKey === 'stash'
            ? '读取 Git 贮藏失败'
            : '读取 Pull Request 信息失败';
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
// 放弃全部的目标集合与可暂存集合完全一致(已跟踪改动