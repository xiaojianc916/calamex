import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSearchPayload, WorkspaceSearchResult } from '@/bindings/tauri';
import SearchSidebarPanel from './SearchSidebarPanel.vue';

const SEARCH_DEBOUNCE_MS = 180;

const tauriServiceMock = vi.hoisted(() => ({
  searchWorkspace: vi.fn(),
  previewWorkspaceReplacement: vi.fn(),
  applyWorkspaceReplacement: vi.fn(),
}));

const messageMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(),
  promise: vi.fn(),
  dismiss: vi.fn(),
}));

const refreshMock = vi.hoisted(() => ({
  refreshSidecarChangedDocuments: vi.fn().mockResolvedValue({
    refreshedPaths: [],
    skippedDirtyNames: [],
    failedNames: [],
  }),
}));

vi.mock('@/services/tauri', () => ({
  tauriService: tauriServiceMock,
}));

vi.mock('@/composables/useMessage', () => ({
  useMessage: () => messageMock,
}));

vi.mock('@/composables/useSidecarChangedDocumentRefresh', () => ({
  useSidecarChangedDocumentRefresh: () => refreshMock,
}));

vi.mock('@/components/ui/input', () => ({
  Input: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
}));

vi.mock('@/components/workbench/ExplorerEntryIcon.vue', () => ({
  default: {
    props: ['kind', 'path'],
    template: '<i class="explorer-entry-icon" />',
  },
}));

vi.mock('@/components/common/InlineError.vue', () => ({
  default: {
    props: ['title', 'message', 'severity'],
    template: '<div class="inline-error"> title   message </div>',
  },
}));

const createFileNameResult = (
  overrides: Partial<WorkspaceSearchResult> = {},
): WorkspaceSearchResult => ({
  path: 'D:/repo/src/foo.sh',
  relativePath: 'src/foo.sh',
  name: 'foo.sh',
  kind: 'file-name',
  lineNumber: null,
  lineText: null,
  matchStart: null,
  matchEnd: null,
  score: 1,
  ...overrides,
});

const createSearchPayload = (
  overrides: Partial<WorkspaceSearchPayload> = {},
): WorkspaceSearchPayload => ({
  rootPath: 'D:/repo',
  scannedFileCount: 1,
  results: [createFileNameResult()],
  ...overrides,
});

const mountPanel = (
  propsOverrides: Partial<{
    documentPath: string | null;
    isDesktopRuntime: boolean;
    workspaceRootPath: string | null;
  }> = {},
) =>
  mount(SearchSidebarPanel, {
    props: {
      documentPath: null,
      isDesktopRuntime: true,
      workspaceRootPath: 'D:/repo',
      preloadedWorkspaceRoot: null,
      ...propsOverrides,
    },
  });

const flushDebouncedSearch = async (): Promise<void> => {
  await flushPromises();
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 20);
  await flushPromises();
};

describe('SearchSidebarPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    tauriServiceMock.searchWorkspace.mockResolvedValue(createSearchPayload());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('非桌面端运行时不调用后端并提示在桌面端使用', async () => {
    const wrapper = mountPanel({ isDesktopRuntime: false, workspaceRootPath: null });
    await flushDebouncedSearch();

    expect(tauriServiceMock.searchWorkspace).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('浏览器预览不提供本地搜索');
  });

  it('桌面端未打开工作区时不调用后端并提示先打开目录', async () => {
    const wrapper = mountPanel({ isDesktopRuntime: true, workspaceRootPath: null });
    await flushDebouncedSearch();

    expect(tauriServiceMock.searchWorkspace).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('尚未打开工作区');
  });

  it('空查询时短路不触发后端检索，且不渲染任何结果或空状态', async () => {
    const wrapper = mountPanel();
    await flushDebouncedSearch();

    expect(tauriServiceMock.searchWorkspace).not.toHaveBeenCalled();
    // 空查询是有意为之的「干净空白」:不渲染结果分组,也不显示任何空状态文案。
    expect(wrapper.find('.search-panel-result-group').exists()).toBe(false);
    expect(wrapper.find('.search-panel-empty-state').exists()).toBe(false);
  });

  it('输入关键字后按 scope=all 调用后端并渲染结果分组与高亮', async () => {
    const wrapper = mountPanel();
    await wrapper.find('input[aria-label="搜索关键字"]').setValue('foo');
    await flushDebouncedSearch();

    expect(tauriServiceMock.searchWorkspace).toHaveBeenCalledTimes(1);
    expect(tauriServiceMock.searchWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRootPath: 'D:/repo',
        query: 'foo',
        scope: 'all',
        useStructural: false,
        limit: 2000,
      }),
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(wrapper.find('.search-panel-result-group-name').text()).toBe('foo.sh');
    expect(wrapper.find('.search-panel-result-snippet-match').text()).toBe('foo');
  });

  it('开启结构化搜索会切到内容范围并高亮该选项', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    const structuralButton = wrapper.get('button[title="结构化搜索与替换"]');
    await structuralButton.trigger('click');

    expect(structuralButton.classes()).toContain('is-active');
    const contentChip = wrapper
      .findAll('.search-panel-chip')
      .find((chip) => chip.text().includes('内容'));
    expect(contentChip?.classes()).toContain('is-active');
  });
});
