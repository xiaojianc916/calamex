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

      <div class="source-control-scroll">
        <template v-if="activeTab === 'changes'">
          <section v-if="!hasVisibleChanges && searchQuery.trim()"
            class="source-control-empty-card source-control-empty-card-inline">
            <p class="source-control-empty-title">{{ emptyChangesTitle }}</p>
            <p class="source-control-empty-text">{{ emptyChangesText }}</p>
          </section>

          <section v-for="section in filteredSections" :key="section.key" class="source-control-section"
            :class="{ 'is-collapsed': collapsedSections[section.key] }">
            <button type="button" class="source-control-section-header" @click="toggleSectionCollapse(section.key)">
              <svg class="source-control-section-chevron" viewBox="0 0 24 24" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
              <span>{{ section.title }}</span>
              <span class="source-control-section-count">{{ section.entries.length }}</span>
            </button>

            <div class="source-control-file-list">
              <article v-for="entry in section.entries" :key="section.key + ':' + entry.path"
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

        <section v-else-if="activeTab === 'history'" class="source-control-info-panel source-control-history-panel">
          <div class="source-control-history-header">
            <p class="source-control-history-heading">History</p>
            <div class="source-control-history-header-actions">
              <button type="button" class="source-control-history-refresh" aria-label="刷新历史" title="刷新历史"
                :disabled="isCommitHistoryLoading || isBusy" @click="handleReloadCommitHistory">
                <span aria-hidden="true" class="icon-[lucide--refresh-cw]" />
              </button>
              <p class="source-control-history-summary">{{ historyPanelTitle }}</p>
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

          <p v-else class="source-control-info-note source-control-history-note">{{ historyEmptyText }}</p>
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
              <p class="source-control-branches-summary">{{ branchesPanelSummary }}</p>
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

              <p v-if="branchCreateError" class="source-control-branch-create-error">{{ branchCreateError }}</p>
            </form>
          </div>

          <div v-if="isBranchesLoading && filteredBranchEntries.length === 0"
            class="source-control-info-note source-control-branches-note">
            正在读取 Git 分支…
          </div>

          <template v-else-if="filteredBranchEntries.length > 0">
            <section v-for="group in branchGroups" :key="group.key" class="source-control-branch-group">
              <div class="source-control-branch-group-header">
                <span>{{ group.title }}</span>
                <span class="source-control-branch-group-count">{{ group.entries.length }}</span>
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
                    <span class="source-control-branch-row-name">{{ entry.shorthand }}</span>
                    <span v-if="resolveBranchMeta(entry)" class="source-control-branch-row-meta">{{ resolveBranchMeta(entry) }}</span>
                  </div>

                  <span v-if="entry.isCurrent" class="source-control-branch-row-current">当前</span>
                  <span v-else aria-hidden="true" class="source-control-branch-row-switch">切换</span>
                </article>
              </div>
            </section>
          </template>

          <p v-else class="source-control-info-note source-control-branches-note">{{ branchesEmptyText }}</p>
        </section>

        <section v-else-if="activeTab === 'pull-requests'" class="source-control-pull-requests-panel">
          <div class="source-control-pull-requests-header">
            <p class="source-control-pull-requests-heading">Pull requests</p>
            <div class="source-control-pull-requests-header-actions">
              <span v-if="pullRequestSupport.available" class="source-control-pull-requests-provider">
                {{pullRequestProviderLabel}}
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
                      {{filter.label}}
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
                      <span class="source-control-pr-item-title">{{pullRequest.title}}</span>
                      <span class="source-control-pr-state" :class="'is-' + resolvePullRequestStateTone(pullRequest)">
                        {{resolvePullRequestStateLabel(pullRequest)}}
                      </span>
                    </span>
                    <span class="source-control-pr-item-meta">{{resolvePullRequestMeta(pullRequest)}}</span>
                  </button>
                </div>

                <p v-else class="source-control-pr-empty">{{pullRequestsEmptyText}}</p>
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
                    <span class="source-control-pr-detail-title">{{pullRequestDetail.title}}</span>
                    <span class="source-control-pr-state" :class="'is-' + resolvePullRequestStateTone(pullRequestDetail)">
                      {{resolvePullRequestStateLabel(pullRequestDetail)}}
                    </span>
                  </div>
                  <p class="source-control-pr-detail-meta">{{resolvePullRequestMeta(pullRequestDetail)}}</p>
                  <div class="source-control-pr-detail-stats">
                    <span class="source-control-pr-stat is-add">+{{pullRequestDetail.additions ?? 0}}</span>
                    <span class="source-control-pr-stat is-del">-{{pullRequestDetail.deletions ?? 0}}</span>
                    <span class="source-control-pr-stat">{{pullRequestDetail.changedFiles ?? 0}} 个文件</span>
                  </div>
                  <p v-if="pullRequestDetail.body" class="source-control-pr-detail-body">{{pullRequestDetail.body}}</p>
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
                  <p v-if="createPullRequestError" class="source-control-pr-form-error">{{createPullRequestError}}</p>
                  <div class="source-control-pr-create-actions">
                    <button type="button" class="source-control-pr-action-btn"
                      :disabled="isCreatingPullRequest" @click="handleBackToPullRequestList">取消</button>
                    <button type="submit" class="source-control-pr-action-btn is-primary"
                      :disabled="isCreatingPullRequest || !canSubmitCreatePullRequest">
                      {{isCreatingPullRequest ? '创建中…' : '创建 PR'}}
                    </button>
                  </div>
                </form>
              </template>
            </template>

            <template v-else>
              <p class="source-control-info-title">{{pullRequestPanelTitle}}</p>
              <p class="source-control-info-text">{{pullRequestPanelText}}</p>
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
                <p v-if="remoteFormError" class="source-control-pr-form-error">{{remoteFormError}}</p>
                <div class="source-control-pr-create-actions">
                  <button type="button" class="source-control-pr-action-btn"
                    :disabled="isSettingRemote" @click="handleCancelRemoteForm">取消</button>
                  <button type="submit" class="source-control-pr-action-btn is-primary"
                    :disabled="isSettingRemote || !canSubmitRemoteForm">
                    {{isSettingRemote ? '保存中…' : '保存'}}
                  </button>
                </div>
              </form>
            </div>
          </template>
        </section>

        <section v-else class="source-control-info-panel source-control-stash-panel">
          <div class="source-control-stash-header">
            <p class="source-control-stash-heading">贮藏</p>
            <p class="source-control-stash-summary">{{ stashPanelTitle }}</p>
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
                <span class="source-control-stash-ref">{{ resolveStashIndexLabel(entry) }}</span>

                <span class="source-control-stash-info">
                  <span class="source-control-stash-title">{{ resolveStashTitle(entry) }}</span>
                  <span class="source-control-stash-meta">{{ resolveStashMeta(entry) }}</span>
                </span>

                <svg class="source-control-stash-chevron" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>

              <div v-if="isStashOpen(entry.stashId)" class="source-control-stash-body">
                <div class="source-control-stash-details">
                  <div class="source-control-stash-detail">
                    <span class="source-control-stash-detail-label">引用</span>
                    <span class="source-control-stash-detail-value">{{ entry.stashId }}</span>
                  </div>

                  <div v-if="entry.branchName" class="source-control-stash-detail">
                    <span class="source-control-stash-detail-label">分支</span>
                    <span class="source-control-stash-detail-value">{{ entry.branchName }}</span>
                  </div>

                  <div v-if="entry.commitShortId" class="source-control-stash-detail">
                    <span class="source-control-stash-detail-label">基线</span>
                    <span class="source-control-stash-detail-value">{{ entry.commitShortId }}</span>
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

          <p v-else class="source-control-info-note source-control-stash-note">{{ stashEmptyText }}</p>
        </section>
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
    if (gitStore.pullRequestSupport.available) {
      await gitStore.loadPullRequests();
    }
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
const isCommitHistoryLoading = computed(() => gitStore.isCommitHistoryLoading);
const branchEntries = computed<IGitBranchPayload[]>(() => gitStore.branches);
const isBranchesLoading = computed(() => gitStore.isBranchesLoading);
const stashEntries = computed<IGitStashEntryPayload[]>(() => gitStore.stashes);
const isStashesLoading = computed(() => gitStore.isStashesLoading);
const pullRequestSupport = computed<IGitPullRequestSupportPayload>(
  () => gitStore.pullRequestSupport,
);
const isPullRequestSupportLoading = computed(() => gitStore.isPullRequestSupportLoading);
const isSettingRemote = computed(() => gitStore.isSettingRemote);

const isRemoteFormOpen = ref(false);
const remoteNameInput = ref('');
const remoteUrlInput = ref('');
const remoteFormError = ref<string | null>(null);

const canSubmitRemoteForm = computed(
  () => remoteNameInput.value.trim().length > 0 && remoteUrlInput.value.trim().length > 0,
);

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

const matchesSearchQuery = (parts: Array<string | null | undefined>): boolean => {
  const keyword = searchQuery.value.trim().toLowerCase();
  if (!keyword) {
    return true;
  }

  return parts
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .join(' ')
    .toLowerCase()
    .includes(keyword);
};

const filteredCommitHistory = computed(() =>
  commitHistoryEntries.value.filter((entry) =>
    matchesSearchQuery([entry.summary, entry.shortId, entry.authorName]),
  ),
);

const filteredBranchEntries = computed(() =>
  branchEntries.value.filter((entry) =>
    matchesSearchQuery([entry.shorthand, entry.upstreamName, entry.lastCommit?.summary ?? null]),
  ),
);

const filteredStashEntries = computed(() =>
  stashEntries.value.filter((entry) =>
    matchesSearchQuery([entry.stashId, entry.summary, entry.branchName]),
  ),
);

const activeStashId = ref<string | null | undefined>(undefined);

const resolvedOpenStashId = computed(() => {
  const firstEntry = filteredStashEntries.value[0];

  if (!firstEntry) {
    return null;
  }

  if (activeStashId.value === undefined) {
    return firstEntry.stashId;
  }

  return activeStashId.value;
});

watch(
  () => filteredStashEntries.value.map((entry) => entry.stashId),
  (stashIds) => {
    if (stashIds.length === 0) {
      activeStashId.value = undefined;
      return;
    }

    if (activeStashId.value && !stashIds.includes(activeStashId.value)) {
      activeStashId.value = undefined;
    }
  },
  { immediate: true },
);

const historyPanelTitle = computed(() => {
  if (searchQuery.value.trim()) {
    return `匹配 ${filteredCommitHistory.value.length} 条`;
  }

  const visibleCount = commitHistoryEntries.value.length || (status.value.lastCommit ? 1 : 0);

  if (visibleCount > 0) {
    return `最近 ${visibleCount} 条`;
  }

  return isCommitHistoryLoading.value ? '正在同步' : '暂无提交';
});

const historyEmptyText = computed(() =>
  searchQuery.value.trim() ? '没有匹配的提交记录。' : '当前仓库还没有提交记录。',
);

const branchesPanelSummary = computed(() => {
  if (searchQuery.value.trim()) {
    return `匹配 ${filteredBranchEntries.value.length} 个`;
  }

  const total = branchEntries.value.length;
  if (total === 0) {
    return isBranchesLoading.value ? '正在同步' : '暂无分支';
  }

  return `共 ${total} 个`;
});

const branchGroups = computed<
  Array<{ key: 'local' | 'remote'; title: string; entries: IGitBranchPayload[] }>
>(() => {
  const localEntries = filteredBranchEntries.value.filter((entry) => entry.kind !== 'remote');
  const remoteEntries = filteredBranchEntries.value.filter((entry) => entry.kind === 'remote');

  const groups: Array<{ key: 'local' | 'remote'; title: string; entries: IGitBranchPayload[] }> =
    [];
  if (localEntries.length > 0) {
    groups.push({ key: 'local', title: '本地', entries: localEntries });
  }
  if (remoteEntries.length > 0) {
    groups.push({ key: 'remote', title: '远程', entries: remoteEntries });
  }

  return groups;
});

const branchesEmptyText = computed(() =>
  searchQuery.value.trim() ? '没有匹配的分支。' : '当前仓库没有可显示的分支。',
);

const stashPanelTitle = computed(() => {
  if (searchQuery.value.trim()) {
    return `匹配 ${filteredStashEntries.value.length} 条`;
  }

  return stashEntries.value.length > 0 ? `共 ${stashEntries.value.length} 条` : '暂无贮藏';
});

const stashEmptyText = computed(() =>
  searchQuery.value.trim() ? '没有匹配的贮藏记录。' : '当前仓库没有 Git 贮藏。',
);

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

const resolveBranchMeta = (entry: IGitBranchPayload): string => {
  const segments: string[] = [];
  if (entry.upstreamName) {
    segments.push(entry.upstreamName);
  }
  if (entry.lastCommit) {
    segments.push(entry.lastCommit.shortId);
  }

  return segments.join(' · ');
};

const resolveStashMeta = (entry: IGitStashEntryPayload): string => {
  const segments: string[] = [];

  if (entry.branchName) {
    segments.push(entry.branchName);
  }
  if (entry.commitShortId) {
    segments.push(entry.commitShortId);
  }

  if (segments.length === 0) {
    segments.push(entry.stashId);
  }

  return segments.join(' · ');
};

const STASH_SUMMARY_PREFIX_PATTERN = /^(?:On|WIP on)\s+[^:]+:\s*/u;

const resolveStashTitle = (entry: IGitStashEntryPayload): string => {
  const summary = entry.summary.trim();
  const normalized = summary.replace(STASH_SUMMARY_PREFIX_PATTERN, '').trim();

  return normalized || summary;
};

const resolveStashIndexLabel = (entry: IGitStashEntryPayload): string => `@${entry.index}`;

const isStashOpen = (stashId: string): boolean => resolvedOpenStashId.value === stashId;

const toggleStashOpen = (stashId: string): void => {
  activeStashId.value = isStashOpen(stashId) ? null : stashId;
};

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

const handleReloadCommitHistory = async (): Promise<void> => {
  try {
    await gitStore.loadCommitHistory();
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Git 提交历史失败'));
  }
};

const handleReloadBranches = async (): Promise<void> => {
  try {
    await gitStore.loadBranches();
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Git 分支失败'));
  }
};

const INVALID_BRANCH_CHARS = [' ', '~', '^', ':', '?', '*', '[', ']'];

const validateBranchName = (rawName: string): string | null => {
  const name = rawName.trim();
  if (!name) {
    return '分支名称不能为空。';
  }
  if (INVALID_BRANCH_CHARS.some((char) => name.includes(char))) {
    return '分支名称包含非法字符（空格、~、^、:、?、*、[、] 等）。';
  }
  if (name.includes('..')) {
    return '分支名称不能包含连续的点（..）。';
  }
  if (name.startsWith('.') || name.endsWith('.')) {
    return '分支名称不能以点（.）开头或结尾。';
  }
  if (name.startsWith('/') || name.endsWith('/')) {
    return '分支名称不能以斜杠（/）开头或结尾。';
  }
  const exists = branchEntries.value.some(
    (entry) => entry.kind !== 'remote' && entry.shorthand === name,
  );
  if (exists) {
    return '已存在同名本地分支。';
  }

  return null;
};

const openBranchCreate = (): void => {
  if (isBusy.value) {
    return;
  }

  isBranchCreateOpen.value = true;
  branchCreateName.value = '';
  branchCreateError.value = null;
  void nextTick(() => {
    branchNameInputRef.value?.focus();
  });
};

const cancelBranchCreate = (): void => {
  isBranchCreateOpen.value = false;
  branchCreateName.value = '';
  branchCreateError.value = null;
};

const submitBranchCreate = async (): Promise<void> => {
  const branchName = branchCreateName.value.trim();
  const validationError = validateBranchName(branchName);
  if (validationError) {
    branchCreateError.value = validationError;
    return;
  }

  try {
    const didRun = await runWithPending('create-branch', async () => {
      await gitStore.createBranch(branchName, true);
      await gitStore.loadBranches();
    });

    if (!didRun) {
      return;
    }

    cancelBranchCreate();
    message.success(`已创建并切换到 ${branchName}`);
  } catch (error) {
    branchCreateError.value = toErrorMessage(error, '创建 Git 分支失败');
  }
};

const handleCheckoutBranch = async (entry: IGitBranchPayload): Promise<void> => {
  if (entry.isCurrent) {
    return;
  }

  try {
    const didRun = await runWithPending(`checkout-branch:${entry.name}`, async () => {
      await gitStore.checkoutBranch(entry.shorthand);
      await gitStore.loadBranches();
    });

    if (!didRun) {
      return;
    }

    message.success(`已切换到 ${entry.shorthand}`);
  } catch (error) {
    message.error(toErrorMessage(error, '切换 Git 分支失败'));
  }
};

const handleReloadStashes = async (): Promise<void> => {
  try {
    await gitStore.loadStashes();
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Git 贮藏失败'));
  }
};

const handleSaveStash = async (): Promise<void> => {
  const stashMessageInput = promptForText('输入可选的贮藏说明；留空则使用 Git 默认说明。', '');
  if (stashMessageInput === null) {
    return;
  }

  const stashMode = await dialog.confirm({
    title: '是否同时保存未跟踪文件？',
    description: '确认会把未跟踪文件也放入 stash；取消则只保存已跟踪改动。',
    confirmText: '包含未跟踪',
    cancelText: '仅已跟踪',
    dismissText: '取消',
    variant: 'default',
  });
  if (stashMode === 'dismiss') {
    return;
  }

  const includeUntracked = stashMode === 'confirm';
  const stashMessage = stashMessageInput.trim() || null;

  try {
    const didRun = await runWithPending('save-stash', async () => {
      await gitStore.saveStash(stashMessage, includeUntracked);
      await gitStore.loadStashes();
    });

    if (!didRun) {
      return;
    }

    message.success('当前改动已保存到 Git 贮藏');
  } catch (error) {
    message.error(toErrorMessage(error, '保存 Git 贮藏失败'));
  }
};

const handleApplyStash = async (entry: IGitStashEntryPayload, pop: boolean): Promise<void> => {
  if (pop) {
    const action = await dialog.confirm({
      title: '弹出此贮藏？',
      description: `将应用 ${entry.stashId} 的改动并从贮藏列表移除。`,
      confirmText: '弹出',
      cancelText: '取消',
      variant: 'danger',
    });
    if (action !== 'confirm') {
      return;
    }
  }

  try {
    const didRun = await runWithPending(
      `${pop ? 'pop' : 'apply'}-stash:${entry.stashId}`,
      async () => {
        await gitStore.applyStash(entry.index, pop);
        await gitStore.loadStashes();
      },
    );

    if (!didRun) {
      return;
    }

    message.success(pop ? `已弹出 ${entry.stashId}` : `已应用 ${entry.stashId}`);
  } catch (error) {
    message.error(toErrorMessage(error, pop ? '弹出 Git 贮藏失败' : '应用 Git 贮藏失败'));
  }
};

const handleDropStash = async (entry: IGitStashEntryPayload): Promise<void> => {
  const action = await dialog.confirm({
    title: '删除此贮藏？',
    description: `将永久删除 ${entry.stashId}。此操作无法撤销。`,
    confirmText: '删除',
    cancelText: '取消',
    variant: 'danger',
  });
  if (action !== 'confirm') {
    return;
  }

  try {
    const didRun = await runWithPending(`drop-stash:${entry.stashId}`, async () => {
      await gitStore.dropStash(entry.index);
      await gitStore.loadStashes();
    });

    if (!didRun) {
      return;
    }

    message.success(`已删除 ${entry.stashId}`);
  } catch (error) {
    message.error(toErrorMessage(error, '删除 Git 贮藏失败'));
  }
};

const handleReloadPullRequestSupport = async (): Promise<void> => {
  try {
    await gitStore.loadPullRequestSupport();
    if (gitStore.pullRequestSupport.available) {
      await gitStore.loadPullRequests();
    }
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

  await runWithPending('set-remote', async () => {
    try {
      await gitStore.setRemote(remoteName, remoteUrl);
      isRemoteFormOpen.value = false;
      message.success('已更新仓库远程地址');
    } catch (error) {
      remoteFormError.value = toErrorMessage(error, '配置远程地址失败');
    }
  });
};

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
    activeStashId.value = undefined;
    isRemoteFormOpen.value = false;
    remoteFormError.value = null;
    pullRequestView.value = 'list';
    activePullRequestNumber.value = null;
    closeSourceControlMenu();
    resetSectionCollapse();
  },
);

watch(
  () => activeTab.value,
  (nextTab) => {
    if (nextTab === 'pull-requests') {
      pullRequestView.value = 'list';
      activePullRequestNumber.value = null;
    }

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
