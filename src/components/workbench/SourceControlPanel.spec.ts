import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_DIALOG_EVENT } from '@/types/dialog';
import type { IGitRepositoryStatusPayload } from '@/types/git';
import SourceControlPanel from './SourceControlPanel.vue';

const tauriServiceMock = vi.hoisted(() => ({
  getGitRepositoryStatus: vi.fn(),
  initGitRepository: vi.fn(),
  listGitCommitHistory: vi.fn(),
  listGitBranches: vi.fn(),
  checkoutGitBranch: vi.fn(),
  createGitBranch: vi.fn(),
  getGitFileBaseline: vi.fn(),
  stageGitPaths: vi.fn(),
  unstageGitPaths: vi.fn(),
  discardGitPaths: vi.fn(),
  commitGitIndex: vi.fn(),
  listGitStashes: vi.fn(),
  saveGitStash: vi.fn(),
  applyGitStash: vi.fn(),
  dropGitStash: vi.fn(),
  getGitPullRequestSupport: vi.fn(),
  listGitPullRequests: vi.fn(),
  getGitPullRequestDetail: vi.fn(),
  createGitPullRequest: vi.fn(),
  mergeGitPullRequest: vi.fn(),
  closeGitPullRequest: vi.fn(),
  setGitRemote: vi.fn(),
}));

const clipboardMock = vi.hoisted(() => ({
  writeFileSystemPathToClipboard: vi.fn().mockResolvedValue(undefined),
}));

const LinearContextMenuStub = {
  props: ['open', 'groups'],
  emits: ['select'],
  template: `
    <div v-if="open" class="linear-context-menu-root">
      <template v-for="group in groups" :key="group.key">
        <button
          v-for="item in group.items"
          :key="item.key"
          type="button"
          data-slot="dropdown-menu-item"
          :disabled="item.disabled"
          @pointerdown="$emit('select', item)"
          v-text="item.label"
        ></button>
      </template>
    </div>
  `,
};

vi.mock('@/services/tauri', () => ({
  tauriService: tauriServiceMock,
}));

vi.mock('@/utils/clipboard', () => ({
  writeFileSystemPathToClipboard: clipboardMock.writeFileSystemPathToClipboard,
}));

const createStatus = (
  overrides: Partial<IGitRepositoryStatusPayload> = {},
): IGitRepositoryStatusPayload => ({
  available: true,
  message: null,
  repositoryRootPath: 'D:/repo',
  repositoryName: 'repo',
  gitDirPath: 'D:/repo/.git',
  headBranchName: 'main',
  headShortName: 'main',
  headShortOid: 'abc1234',
  isDetached: false,
  isClean: false,
  ahead: 0,
  behind: 0,
  stagedCount: 0,
  unstagedCount: 1,
  untrackedCount: 1,
  conflictedCount: 0,
  files: [
    {
      path: 'D:/repo/src/app.sh',
      relativePath: 'src/app.sh',
      fileName: 'app.sh',
      previousPath: null,
      previousRelativePath: null,
      indexStatus: null,
      worktreeStatus: 'modified',
      isConflicted: false,
      isUntracked: false,
    },
    {
      path: 'D:/repo/src/new.sh',
      relativePath: 'src/new.sh',
      fileName: 'new.sh',
      previousPath: null,
      previousRelativePath: null,
      indexStatus: null,
      worktreeStatus: 'untracked',
      isConflicted: false,
      isUntracked: true,
    },
  ],
  lastCommit: {
    id: 'abc123456789',
    shortId: 'abc1234',
    summary: 'feat: 初始化项目',
    authorName: 'test',
    authorEmail: 'test@example.com',
    authoredAt: '2026-04-26T00:00:00.000Z',
    parentIds: [],
    refs: [],
  },
  ...overrides,
});

const cleanStatus = createStatus({
  isClean: true,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  files: [],
});

const unavailableStatus = createStatus({
  available: false,
  message: '当前工作区未检测到 Git 仓库。',
  repositoryRootPath: null,
  repositoryName: null,
  gitDirPath: null,
  headBranchName: null,
  headShortName: null,
  headShortOid: null,
  isClean: true,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  conflictedCount: 0,
  files: [],
  lastCommit: null,
});

const commitHistoryPayload = {
  entries: [
    {
      id: 'commit-2',
      shortId: 'def5678',
      summary: 'fix: 修正边界处理',
      authorName: 'test',
      authoredAt: '2026-04-27T00:00:00.000Z',
    },
    {
      id: 'commit-1',
      shortId: 'abc1234',
      summary: 'feat: 初始化项目',
      authorName: 'test',
      authoredAt: '2026-04-26T00:00:00.000Z',
    },
  ],
  hasMore: false,
  nextOffset: null,
};

const branchListPayload = {
  branches: [
    {
      name: 'refs/heads/main',
      shorthand: 'main',
      kind: 'local',
      upstreamName: 'origin/main',
      isCurrent: true,
      isHead: true,
      ahead: 0,
      behind: 0,
      lastCommit: cleanStatus.lastCommit,
    },
    {
      name: 'refs/heads/feature/demo',
      shorthand: 'feature/demo',
      kind: 'local',
      upstreamName: null,
      isCurrent: false,
      isHead: false,
      ahead: 0,
      behind: 0,
      lastCommit: cleanStatus.lastCommit,
    },
  ],
};

const stashListPayload = {
  entries: [
    {
      index: 0,
      stashId: 'stash@{0}',
      summary: 'On main: demo stash',
      branchName: 'main',
      commitShortId: 'abc1234',
    },
  ],
};

const pullRequestSupportPayload = {
  available: true,
  remoteName: 'origin',
  provider: 'github',
  repositoryUrl: 'https://github.com/owner/repo',
  pullRequestsUrl: 'https://github.com/owner/repo/pulls',
  createPullRequestUrl: 'https://github.com/owner/repo/compare',
};

const pullRequestListPayload = [
  {
    number: 12,
    title: 'feat: add pull request panel',
    state: 'open',
    isDraft: false,
    author: 'octocat',
    headRef: 'feature/pr-panel',
    baseRef: 'main',
    htmlUrl: 'https://github.com/owner/repo/pull/12',
    createdAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:00.000Z',
    comments: 2,
  },
];

const pullRequestDetailPayload = {
  ...pullRequestListPayload[0],
  body: 'PR body',
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  mergeable: true,
  mergeableState: 'clean',
};

const mountPanel = async (
  status = createStatus(),
  propsOverrides: Partial<{ activePath: string | null }> = {},
) => {
  tauriServiceMock.getGitRepositoryStatus.mockResolvedValue(status);
  const wrapper = mount(SourceControlPanel, {
    props: {
      isDesktopRuntime: true,
      workspaceRootPath: 'D:/repo',
      activePath: null,
      ...propsOverrides,
    },
    global: {
      stubs: {
        LinearContextMenu: LinearContextMenuStub,
      },
    },
  });
  await flushPromises();
  return wrapper;
};

describe('SourceControlPanel', () => {
  const confirmDialog = (event: WindowEventMap[typeof APP_DIALOG_EVENT]): void => {
    event.detail.onAction('confirm');
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.spyOn(window, 'open').mockImplementation(() => null);
    tauriServiceMock.listGitCommitHistory.mockResolvedValue(commitHistoryPayload);
    tauriServiceMock.listGitBranches.mockResolvedValue(branchListPayload);
    tauriServiceMock.checkoutGitBranch.mockResolvedValue(cleanStatus);
    tauriServiceMock.createGitBranch.mockResolvedValue(cleanStatus);
    tauriServiceMock.stageGitPaths.mockResolvedValue(cleanStatus);
    tauriServiceMock.unstageGitPaths.mockResolvedValue(cleanStatus);
    tauriServiceMock.discardGitPaths.mockResolvedValue(cleanStatus);
    tauriServiceMock.commitGitIndex.mockResolvedValue({
      status: cleanStatus,
      commitId: 'abc123456789',
    });
    tauriServiceMock.listGitStashes.mockResolvedValue(stashListPayload);
    tauriServiceMock.saveGitStash.mockResolvedValue(cleanStatus);
    tauriServiceMock.applyGitStash.mockResolvedValue(
      createStatus({ unstagedCount: 1, isClean: false }),
    );
    tauriServiceMock.dropGitStash.mockResolvedValue(cleanStatus);
    tauriServiceMock.getGitPullRequestSupport.mockResolvedValue(pullRequestSupportPayload);
    tauriServiceMock.listGitPullRequests.mockResolvedValue(pullRequestListPayload);
    tauriServiceMock.getGitPullRequestDetail.mockResolvedValue(pullRequestDetailPayload);
    tauriServiceMock.createGitPullRequest.mockResolvedValue(pullRequestListPayload[0]);
    tauriServiceMock.mergeGitPullRequest.mockResolvedValue({
      ...pullRequestListPayload[0],
      state: 'merged',
    });
    tauriServiceMock.closeGitPullRequest.mockResolvedValue({
      ...pullRequestListPayload[0],
      state: 'closed',
    });
    tauriServiceMock.setGitRemote.mockResolvedValue(pullRequestSupportPayload);
    window.addEventListener(APP_DIALOG_EVENT, confirmDialog);
  });

  afterEach(() => {
    window.removeEventListener(APP_DIALOG_EVENT, confirmDialog);
    document.body.innerHTML = '';
  });

  it('未初始化时点击初始化按钮会调用 init_git_repository 并进入仓库视图', async () => {
    const wrapper = await mountPanel(unavailableStatus);
    tauriServiceMock.initGitRepository.mockResolvedValueOnce(cleanStatus);
    tauriServiceMock.getGitRepositoryStatus.mockResolvedValueOnce(cleanStatus);

    const initButton = wrapper.find('.source-control-setup-btn-primary');
    expect(initButton.text()).toBe('初始化 Git 仓库');

    await initButton.trigger('click');
    await flushPromises();

    expect(tauriServiceMock.initGitRepository).toHaveBeenCalledWith('D:/repo');
    expect(tauriServiceMock.getGitRepositoryStatus).toHaveBeenLastCalledWith('D:/repo');
    expect(wrapper.find('.source-control-branch-name').text()).toBe('main');
  });

  it('初始化后仍未得到当前工作区仓库时停留在引导页并显示错误', async () => {
    const wrapper = await mountPanel(unavailableStatus);
    tauriServiceMock.initGitRepository.mockResolvedValueOnce(
      createStatus({
        repositoryRootPath: 'D:/parent',
        repositoryName: 'parent',
        gitDirPath: 'D:/parent/.git',
      }),
    );

    await wrapper.find('.source-control-setup-btn-primary').trigger('click');
    await flushPromises();

    expect(wrapper.find('.source-control-repo-name').exists()).toBe(false);
    expect(wrapper.find('.source-control-setup-error').text()).toContain('Git 初始化目标不一致');
  });

  it('批量暂存会调用真实 Git store/IPC 路径', async () => {
    const wrapper = await mountPanel();

    await wrapper.get('[aria-label="更多 Git 操作"]').trigger('click');
    await flushPromises();

    const stageAllButton = wrapper
      .findAll('[data-slot="dropdown-menu-item"]')
      .find((button) => button.text() === '全部暂存');
    expect(stageAllButton).toBeDefined();

    await stageAllButton?.trigger('pointerdown');
    await flushPromises();

    expect(tauriServiceMock.stageGitPaths).toHaveBeenCalledWith({
      repositoryRootPath: 'D:/repo',
      paths: ['D:/repo/src/app.sh', 'D:/repo/src/new.sh'],
    });
  });

  it('点击变更文件会按原交互打开文件', async () => {
    const wrapper = await mountPanel();

    await wrapper.find('.source-control-file-main').trigger('click');

    expect(wrapper.emitted('open-file')).toEqual([['D:/repo/src/app.sh']]);
    expect(wrapper.emitted('open-diff')).toBeUndefined();
  });

  it('工作区干净且未搜索时不显示默认空状态文案', async () => {
    const wrapper = await mountPanel(cleanStatus);

    expect(wrapper.find('.source-control-empty-card-inline').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('当前没有可显示的变更');
    expect(wrapper.text()).not.toContain('工作区已经和 HEAD 保持一致');
  });

  it('右键菜单的查看 Diff 会打开独立 Git Diff 预览', async () => {
    const wrapper = await mountPanel();

    await wrapper.find('.source-control-file').trigger('contextmenu', {
      clientX: 160,
      clientY: 180,
    });
    await flushPromises();

    const diffMenuItem = wrapper
      .findAll('[data-slot="dropdown-menu-item"]')
      .find((button) => button.text().includes('查看 Diff'));
    expect(diffMenuItem).toBeDefined();

    await diffMenuItem?.trigger('pointerdown');
    await flushPromises();

    expect(wrapper.emitted('open-diff')).toEqual([
      [
        {
          repositoryRootPath: 'D:/repo',
          path: 'D:/repo/src/app.sh',
          mode: 'worktree',
        },
      ],
    ]);
  });

  it('右键未选中的 Git 文件时会保留临时高亮，菜单关闭后清除', async () => {
    const wrapper = await mountPanel();

    const row = wrapper.find('.source-control-file');

    await row.trigger('contextmenu', {
      clientX: 160,
      clientY: 180,
    });
    await flushPromises();

    expect(row.classes()).toContain('is-context-target');
    expect(row.classes()).not.toContain('is-active');

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await flushPromises();

    expect(row.classes()).not.toContain('is-context-target');
  });

  it('右键当前选中的 Git 文件时不叠加临时高亮类', async () => {
    const wrapper = await mountPanel(createStatus(), {
      activePath: 'D:/repo/src/app.sh',
    });

    const row = wrapper.find('.source-control-file');
    expect(row.classes()).toContain('is-active');

    await row.trigger('contextmenu', {
      clientX: 160,
      clientY: 180,
    });
    await flushPromises();

    expect(row.classes()).toContain('is-active');
    expect(row.classes()).not.toContain('is-context-target');
  });

  it('右键菜单的复制路径会走文件系统路径剪贴板封装', async () => {
    const wrapper = await mountPanel(
      createStatus({
        files: [
          {
            path: String.raw`\\?\D:\repo\src\app.sh`,
            relativePath: 'src/app.sh',
            fileName: 'app.sh',
            previousPath: null,
            previousRelativePath: null,
            indexStatus: null,
            worktreeStatus: 'modified',
            isConflicted: false,
            isUntracked: false,
          },
        ],
      }),
    );

    await wrapper.find('.source-control-file').trigger('contextmenu', {
      clientX: 160,
      clientY: 180,
    });
    await flushPromises();

    const copyPathMenuItem = wrapper
      .findAll('[data-slot="dropdown-menu-item"]')
      .find((button) => button.text().includes('复制路径'));
    expect(copyPathMenuItem).toBeDefined();

    await copyPathMenuItem?.trigger('pointerdown');
    await flushPromises();

    expect(clipboardMock.writeFileSystemPathToClipboard).toHaveBeenCalledWith(
      String.raw`\\?\D:\repo\src\app.sh`,
    );
  });

  it('单文件放弃更改会二次确认并调用 discard_git_paths', async () => {
    const wrapper = await mountPanel();

    const discardButton = wrapper
      .findAll('.source-control-icon-btn')
      .find((button) => button.attributes('aria-label') === '放弃更改 app.sh');
    expect(discardButton).toBeDefined();

    await discardButton?.trigger('click');
    await flushPromises();

    expect(tauriServiceMock.discardGitPaths).toHaveBeenCalledWith({
      repositoryRootPath: 'D:/repo',
      paths: ['D:/repo/src/app.sh'],
    });
  });

  it('提交时允许任意非空提交说明并直接提交', async () => {
    const stagedStatus = createStatus({
      stagedCount: 1,
      unstagedCount: 0,
      untrackedCount: 0,
      files: [
        {
          path: 'D:/repo/src/app.sh',
          relativePath: 'src/app.sh',
          fileName: 'app.sh',
          previousPath: null,
          previousRelativePath: null,
          indexStatus: 'modified',
          worktreeStatus: null,
          isConflicted: false,
          isUntracked: false,
        },
      ],
    });
    const wrapper = await mountPanel(stagedStatus);

    await wrapper.find('.source-control-commit-input').setValue('随便写点提交说明。');
    await wrapper.find('.source-control-btn-primary').trigger('click');
    await flushPromises();

    expect(tauriServiceMock.commitGitIndex).toHaveBeenCalledWith({
      repositoryRootPath: 'D:/repo',
      message: '随便写点提交说明。',
      paths: [],
    });
  });

  it('切换到历史标签时会加载并渲染提交历史', async () => {
    const wrapper = await mountPanel();

    const historyTab = wrapper
      .findAll('.source-control-nav-item')
      .find((button) => button.text().includes('历史'));
    expect(historyTab).toBeDefined();

    await historyTab?.trigger('click');
    await flushPromises();

    expect(tauriServiceMock.listGitCommitHistory).toHaveBeenCalledWith({
      repositoryRootPath: 'D:/repo',
      offset: 0,
      limit: null,
    });
    expect(wrapper.find('.source-control-history-timeline').exists()).toBe(true);
    expect(wrapper.find('.source-control-history-refresh').exists()).toBe(true);
    expect(wrapper.find('.source-control-history-toolbar').exists()).toBe(false);
    expect(wrapper.findAll('.source-control-history-item')).toHaveLength(2);
    expect(wrapper.find('.source-control-history-item').classes()).toContain('is-active');
    expect(wrapper.find('.source-control-history-author').text()).toBe('test');
    expect(wrapper.text()).toContain('fix: 修正边界处理');
  });

  it('分支标签里的切换按钮会调用 checkout_git_branch', async () => {
    tauriServiceMock.listGitBranches
      .mockResolvedValueOnce(branchListPayload)
      .mockResolvedValueOnce({
        branches: branchListPayload.branches.map((entry) => ({
          ...entry,
          isCurrent: entry.shorthand === 'feature/demo',
          isHead: entry.shorthand === 'feature/demo',
        })),
      });

    const wrapper = await mountPanel();
    const branchTab = wrapper
      .findAll('.source-control-nav-item')
      .find((button) => button.text().includes('分支'));
    expect(branchTab).toBeDefined();

    await branchTab?.trigger('click');
    await flushPromises();

    const checkoutButton = wrapper
      .findAll('.source-control-btn')
      .find((button) => button.text() === '切换');
    expect(checkoutButton).toBeDefined();

    await checkoutButton?.trigger('click');
    await flushPromises();

    expect(tauriServiceMock.checkoutGitBranch).toHaveBeenCalledWith({
      repositoryRootPath: 'D:/repo',
      branchName: 'feature/demo',
    });
  });

  it('贮藏标签里的应用按钮会调用 apply_git_stash', async () => {
    tauriServiceMock.listGitStashes
      .mockResolvedValueOnce(stashListPayload)
      .mockResolvedValueOnce(stashListPayload);

    const wrapper = await mountPanel();
    const stashTab = wrapper
      .findAll('.source-control-nav-item')
      .find((button) => button.text().includes('贮藏'));
    expect(stashTab).toBeDefined();

    await stashTab?.trigger('click');
    await flushPromises();

    const applyButton = wrapper
      .findAll('.source-control-btn')
      .find((button) => button.text() === '应用');
    expect(applyButton).toBeDefined();

    await applyButton?.trigger('click');
    await flushPromises();

    expect(tauriServiceMock.applyGitStash).toHaveBeenCalledWith({
      repositoryRootPath: 'D:/repo',
      stashIndex: 0,
      pop: false,
    });
  });

  it('拉取请求标签会在软件内加载 PR 列表', async () => {
    const wrapper = await mountPanel();
    const pullRequestTab = wrapper
      .findAll('.source-control-nav-item')
      .find((button) => button.text().includes('拉取请求'));
    expect(pullRequestTab).toBeDefined();

    await pullRequestTab?.trigger('click');
    await flushPromises();

    expect(tauriServiceMock.getGitPullRequestSupport).toHaveBeenCalledWith('D:/repo');
    expect(tauriServiceMock.listGitPullRequests).toHaveBeenCalledWith({
      repositoryRootPath: 'D:/repo',
      state: 'open',
    });
    expect(wrapper.find('.source-control-pr-item').exists()).toBe(true);
    expect(wrapper.text()).toContain('feat: add pull request panel');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('拉取请求面板可在软件内配置远程并调用 set_git_remote', async () => {
    const wrapper = await mountPanel();
    const pullRequestTab = wrapper
      .findAll('.source-control-nav-item')
      .find((button) => button.text().includes('拉取请求'));
    expect(pullRequestTab).toBeDefined();

    await pullRequestTab?.trigger('click');
    await flushPromises();

    await wrapper.find('.source-control-pull-requests-config-trigger').trigger('click');
    await flushPromises();

    const inputs = wrapper.findAll('.source-control-pull-requests-input');
    expect(inputs).toHaveLength(2);

    await inputs[0].setValue('origin');
    await inputs[1].setValue('https://github.com/owner/repo.git');
    await wrapper.find('.source-control-pull-requests-form').trigger('submit');
    await flushPromises();

    expect(tauriServiceMock.setGitRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteName: 'origin',
        remoteUrl: 'https://github.com/owner/repo.git',
      }),
    );
  });
});
