import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    emits: ['update:modelValue', 'keydown'],
    template:
      '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" @keydown.enter="$emit(\'keydown\', $event)" />',
  },
}));

vi.mock('@/components/workbench/ExplorerEntryIcon.vue', () => ({
  default: { template: '<i />' },
}));

vi.mock('@/components/common/InlineError.vue', () => ({
  default: {
    props: ['title', 'message'],
    template: '<div class="inline-error"> title  message </div>',
  },
}));

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
};

const replacementPreview = {
  fileCount: 1,
  files: [
    {
      path: 'D:/repo/src/foo.sh',
      relativePath: 'src/foo.sh',
      beforeHash: 'hash-before',
      linePreviews: [
        {
          id: 'match-1',
          lineNumber: 1,
          beforeLine: 'echo old',
          afterLine: 'echo new',
          replacementCount: 1,
        },
      ],
    },
  ],
};

const replacementPayload = {
  rootPath: 'D:/repo',
  changedFileCount: 1,
  replacementCount: 1,
  files: [{ path: 'D:/repo/src/foo.sh' }],
};

const mountPanel = () =>
  mount(SearchSidebarPanel, {
    props: {
      documentPath: null,
      isDesktopRuntime: true,
      workspaceRootPath: 'D:/repo',
      preloadedWorkspaceRoot: null,
    },
  });

const flushDebounce = async (): Promise<void> => {
  await flushPromises();
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 20);
  await flushPromises();
};

const preparePreview = async (wrapper: ReturnType<typeof mountPanel>): Promise<void> => {
  tauriServiceMock.searchWorkspace.mockResolvedValue({
    rootPath: 'D:/repo',
    scannedFileCount: 0,
    results: [],
  });
  tauriServiceMock.previewWorkspaceReplacement.mockResolvedValue(replacementPreview);
  await wrapper.find('input[aria-label="搜索关键字"]').setValue('old');
  await flushDebounce();
  await wrapper.find('input[aria-label="替换内容"]').setValue('new');
  await flushDebounce();
  expect(tauriServiceMock.previewWorkspaceReplacement).toHaveBeenCalled();
};

describe('SearchSidebarPanel replacement lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    refreshMock.refreshSidecarChangedDocuments.mockResolvedValue({
      refreshedPaths: [],
      skippedDirtyNames: [],
      failedNames: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('输入新查询时立即取消旧搜索并抑制旧结果回写', async () => {
    const firstSearch = createDeferred<{
      rootPath: string;
      scannedFileCount: number;
      results: Array<{
        path: string;
        relativePath: string;
        name: string;
        kind: 'file-name';
        lineNumber: null;
        lineText: null;
        matchStart: null;
        matchEnd: null;
        score: number;
      }>;
    }>();
    tauriServiceMock.searchWorkspace
      .mockReturnValueOnce(firstSearch.promise)
      .mockResolvedValueOnce({
        rootPath: 'D:/repo',
        scannedFileCount: 1,
        results: [
          {
            path: 'D:/repo/bar.sh',
            relativePath: 'bar.sh',
            name: 'bar.sh',
            kind: 'file-name',
            lineNumber: null,
            lineText: null,
            matchStart: null,
            matchEnd: null,
            score: -10,
          },
        ],
      });

    const wrapper = mountPanel();
    await wrapper.find('input[aria-label="搜索关键字"]').setValue('foo');
    await flushDebounce();
    expect(tauriServiceMock.searchWorkspace).toHaveBeenCalledTimes(1);

    const firstSignal = tauriServiceMock.searchWorkspace.mock.calls[0]?.[1]?.signal as AbortSignal;
    await wrapper.find('input[aria-label="搜索关键字"]').setValue('bar');

    expect(firstSignal.aborted).toBe(true);

    firstSearch.resolve({
      rootPath: 'D:/repo',
      scannedFileCount: 1,
      results: [
        {
          path: 'D:/repo/foo.sh',
          relativePath: 'foo.sh',
          name: 'foo.sh',
          kind: 'file-name',
          lineNumber: null,
          lineText: null,
          matchStart: null,
          matchEnd: null,
          score: -100,
        },
      ],
    });
    await flushPromises();

    expect(wrapper.text()).not.toContain('foo.sh');

    await flushDebounce();

    expect(tauriServiceMock.searchWorkspace).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('bar.sh');
  });

  it('应用替换时向后端传入取消信号', async () => {
    tauriServiceMock.applyWorkspaceReplacement.mockResolvedValue(replacementPayload);
    const wrapper = mountPanel();
    await preparePreview(wrapper);

    await wrapper.get('button[title="全部替换"]').trigger('click');
    await flushPromises();
    await wrapper.get('button[title="再次点击确认全部替换（超时自动取消）"]').trigger('click');
    await flushPromises();

    expect(tauriServiceMock.applyWorkspaceReplacement).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ workspaceRootPath: 'D:/repo' }),
        expectedFiles: [
          {
            path: 'D:/repo/src/foo.sh',
            beforeHash: 'hash-before',
            includedMatchIds: ['match-1'],
          },
        ],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('切换工作区时取消替换应用并抑制旧成功提示', async () => {
    const applyDeferred = createDeferred<typeof replacementPayload>();
    tauriServiceMock.applyWorkspaceReplacement.mockReturnValue(applyDeferred.promise);
    const wrapper = mountPanel();
    await preparePreview(wrapper);

    await wrapper.get('button[title="全部替换"]').trigger('click');
    await flushPromises();
    await wrapper.get('button[title="再次点击确认全部替换（超时自动取消）"]').trigger('click');
    await flushPromises();
    const signal = tauriServiceMock.applyWorkspaceReplacement.mock.calls[0]?.[1]
      ?.signal as AbortSignal;

    await wrapper.setProps({ workspaceRootPath: 'D:/next-repo' });
    expect(signal.aborted).toBe(true);

    applyDeferred.resolve(replacementPayload);
    await flushPromises();

    expect(refreshMock.refreshSidecarChangedDocuments).not.toHaveBeenCalled();
    expect(messageMock.success).not.toHaveBeenCalledWith('已替换 1 个文件中的 1 处内容。');
  });
});
