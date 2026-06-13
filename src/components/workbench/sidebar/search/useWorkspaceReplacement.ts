import { type ComputedRef, computed, onScopeDispose, type Ref, ref } from 'vue';
import { useMessage } from '@/composables/useMessage';
import {
  type IRefreshSidecarChangedDocumentsResult,
  useSidecarChangedDocumentRefresh,
} from '@/composables/useSidecarChangedDocumentRefresh';
import { tauriService } from '@/services/tauri';
import { isAppError } from '@/types/app-error';
import type { IWorkbenchOpenFileRequest } from '@/types/editor';
import type {
  IWorkspaceReplacementFilePreview,
  IWorkspaceReplacementLinePreview,
  IWorkspaceReplacementPreviewPayload,
  IWorkspaceReplacementRequest,
} from '@/types/search';
import { toErrorMessage } from '@/utils/error';
import type { IReplacementFileView, IReplacementLineView } from './search-sidebar.types';
import {
  buildReplacementLineSegments,
  getFileName,
  getParentPath,
  toggleReadonlySetValue,
} from './search-sidebar-text';

const SEARCH_DEBOUNCE_MS = 180;
const REPLACEMENT_FILE_LIMIT = 200;

type TReplacementApplyLifecycle = {
  requestId: number;
  workspaceRootPath: string | null;
  signal: AbortSignal;
};

type TCancelableApplyWorkspaceReplacement = (
  payload: Parameters<typeof tauriService.applyWorkspaceReplacement>[0],
  options?: { signal?: AbortSignal },
) => ReturnType<typeof tauriService.applyWorkspaceReplacement>;

export interface IUseWorkspaceReplacementOptions {
  isDesktopRuntime: Ref<boolean>;
  workspaceRootPath: Ref<string | null>;
  searchQuery: Ref<string>;
  matchCase: Ref<boolean>;
  wholeWord: Ref<boolean>;
  useRegex: Ref<boolean>;
  useStructural: Ref<boolean>;
  effectiveIncludePatterns: ComputedRef<string[]>;
  effectiveExcludePatterns: ComputedRef<string[]>;
  hasSearchQuery: ComputedRef<boolean>;
  searchError: Ref<string>;
  isWorkspaceRootCurrent: (candidate: string | null | undefined) => boolean;
  runSearch: () => Promise<void>;
  emitOpenFile: (payload: IWorkbenchOpenFileRequest) => void;
  clearSelectedResult: () => void;
}

export const useWorkspaceReplacement = (options: IUseWorkspaceReplacementOptions) => {
  const {
    isDesktopRuntime,
    workspaceRootPath,
    searchQuery,
    matchCase,
    wholeWord,
    useRegex,
    useStructural,
    effectiveIncludePatterns,
    effectiveExcludePatterns,
    hasSearchQuery,
    searchError,
    isWorkspaceRootCurrent,
    runSearch,
    emitOpenFile,
    clearSelectedResult,
  } = options;

  const replacementQuery = ref('');
  const replaceRunning = ref(false);
  const replacementApplying = ref(false);
  const replacementApplyingLineId = ref<string | null>(null);
  const replacementPreviewOpen = ref(false);
  const replacementPreview = ref<IWorkspaceReplacementPreviewPayload | null>(null);
  const replacementPreviewRequest = ref<IWorkspaceReplacementRequest | null>(null);
  const skippedReplacementLineIds = ref<ReadonlySet<string>>(new Set<string>());
  const collapsedReplacementFilePaths = ref<ReadonlySet<string>>(new Set<string>());

  let replacementPreviewRequestId = 0;
  let replacementApplyRequestId = 0;
  let replacementPreviewTimer: ReturnType<typeof setTimeout> | null = null;
  let activeReplacementPreviewAbortController: AbortController | null = null;
  let activeReplacementApplyAbortController: AbortController | null = null;

  const message = useMessage();
  const { refreshSidecarChangedDocuments } = useSidecarChangedDocumentRefresh();
  const applyWorkspaceReplacementWithOptions =
    tauriService.applyWorkspaceReplacement as TCancelableApplyWorkspaceReplacement;

  const isCanceledIpcError = (error: unknown): boolean =>
    isAppError(error) && error.code === 'ipc.canceled';

  const beginReplacementApplyLifecycle = (): TReplacementApplyLifecycle => {
    replacementApplyRequestId += 1;
    activeReplacementApplyAbortController?.abort();
    const controller = new AbortController();
    activeReplacementApplyAbortController = controller;
    return {
      requestId: replacementApplyRequestId,
      workspaceRootPath: workspaceRootPath.value,
      signal: controller.signal,
    };
  };

  const isReplacementApplyLifecycleCurrent = (lifecycle: TReplacementApplyLifecycle): boolean =>
    lifecycle.requestId === replacementApplyRequestId &&
    !lifecycle.signal.aborted &&
    isWorkspaceRootCurrent(lifecycle.workspaceRootPath);

  const invalidateReplacementApplyLifecycle = (): void => {
    replacementApplyRequestId += 1;
    activeReplacementApplyAbortController?.abort();
    activeReplacementApplyAbortController = null;
    replacementApplying.value = false;
    replacementApplyingLineId.value = null;
  };

  const canApplyReplacement = computed(
    () =>
      !replaceRunning.value &&
      hasSearchQuery.value &&
      isDesktopRuntime.value &&
      Boolean(workspaceRootPath.value),
  );

  // beforeLine/insertedText 与 matchStart/matchEnd 均由后端给出（偏移基于 beforeLine 的 UTF-16 码元），
  // 这里不再前端 trim，以免改变长度造成偏移错位；行首缩进已由后端去除，视觉截断交给 CSS。
  const toReplacementLineView = (line: IWorkspaceReplacementLinePreview): IReplacementLineView => ({
    ...line,
    segments: buildReplacementLineSegments(
      line.beforeLine,
      line.insertedText,
      line.matchStart,
      line.matchEnd,
    ),
  });

  const toReplacementFileView = (
    file: IWorkspaceReplacementFilePreview,
  ): IReplacementFileView | null => {
    const visibleLinePreviews = file.linePreviews
      .filter((line) => !skippedReplacementLineIds.value.has(line.id))
      .map(toReplacementLineView);
    if (visibleLinePreviews.length === 0) return null;
    return {
      ...file,
      name: getFileName(file.relativePath),
      parentPath: getParentPath(file.relativePath),
      visibleLinePreviews,
      visibleReplacementCount: visibleLinePreviews.reduce(
        (total, line) => total + line.replacementCount,
        0,
      ),
    };
  };

  const visibleReplacementFiles = computed<IReplacementFileView[]>(() => {
    const preview = replacementPreview.value;
    if (!preview) return [];
    return preview.files
      .map(toReplacementFileView)
      .filter((file): file is IReplacementFileView => Boolean(file));
  });

  const isReplacementFileCollapsed = (path: string): boolean =>
    collapsedReplacementFilePaths.value.has(path);
  const toggleReplacementFile = (path: string): void => {
    collapsedReplacementFilePaths.value = toggleReadonlySetValue(
      collapsedReplacementFilePaths.value,
      path,
    );
  };

  const resetReplacementPreview = (): void => {
    if (replacementPreviewTimer) {
      clearTimeout(replacementPreviewTimer);
      replacementPreviewTimer = null;
    }
    replacementPreviewRequestId += 1;
    activeReplacementPreviewAbortController?.abort();
    activeReplacementPreviewAbortController = null;
    invalidateReplacementApplyLifecycle();
    replaceRunning.value = false;
    replacementPreviewOpen.value = false;
    replacementPreview.value = null;
    replacementPreviewRequest.value = null;
    skippedReplacementLineIds.value = new Set<string>();
    collapsedReplacementFilePaths.value = new Set<string>();
  };

  const buildReplacementRequest = (): IWorkspaceReplacementRequest | null => {
    if (!workspaceRootPath.value) return null;
    return {
      workspaceRootPath: workspaceRootPath.value,
      query: searchQuery.value.trim(),
      replacement: replacementQuery.value,
      matchCase: matchCase.value,
      wholeWord: wholeWord.value,
      useRegex: useRegex.value,
      useStructural: useStructural.value,
      includePatterns: effectiveIncludePatterns.value,
      excludePatterns: effectiveExcludePatterns.value,
      limit: REPLACEMENT_FILE_LIMIT,
    };
  };

  const previewReplacementToSearch = async (source: 'manual' | 'auto'): Promise<boolean> => {
    if (replaceRunning.value) return false;
    const query = searchQuery.value.trim();
    if (!hasSearchQuery.value) {
      if (source === 'manual') message.warning('请先输入搜索内容。');
      return false;
    }
    if (!useRegex.value && !useStructural.value && query === replacementQuery.value) {
      if (source === 'manual') message.warning('替换内容与搜索内容相同，无需替换。');
      else resetReplacementPreview();
      return false;
    }
    if (!isDesktopRuntime.value) {
      if (source === 'manual')
        message.warning('浏览器预览不支持写入文件，请在 Tauri 桌面端使用替换。');
      return false;
    }
    if (!workspaceRootPath.value) {
      if (source === 'manual') message.warning('请先打开工作区后再替换。');
      return false;
    }

    const request = buildReplacementRequest();
    if (!request) return false;
    const requestId = replacementPreviewRequestId + 1;
    replacementPreviewRequestId = requestId;
    activeReplacementPreviewAbortController?.abort();
    const abortController = new AbortController();
    activeReplacementPreviewAbortController = abortController;

    replaceRunning.value = true;
    replacementPreviewOpen.value = true;
    replacementPreview.value = null;
    replacementPreviewRequest.value = null;
    skippedReplacementLineIds.value = new Set<string>();

    try {
      const preview = await tauriService.previewWorkspaceReplacement(request, {
        signal: abortController.signal,
      });
      if (
        abortController.signal.aborted ||
        requestId !== replacementPreviewRequestId ||
        !isWorkspaceRootCurrent(request.workspaceRootPath)
      )
        return false;
      if (preview.fileCount === 0) {
        replacementPreviewOpen.value = false;
        if (source === 'manual') message.warning('当前没有可替换的内容匹配结果。');
        return false;
      }
      replacementPreview.value = preview;
      replacementPreviewRequest.value = request;
      return true;
    } catch (error) {
      if (abortController.signal.aborted || requestId !== replacementPreviewRequestId) return false;
      replacementPreviewOpen.value = false;
      if (source === 'manual') message.error(toErrorMessage(error, '替换失败。'));
      else searchError.value = toErrorMessage(error, '替换预览失败。');
      return false;
    } finally {
      if (requestId === replacementPreviewRequestId) {
        replaceRunning.value = false;
        activeReplacementPreviewAbortController = null;
      }
    }
  };

  const retainVisibleSkippedReplacementLines = (
    preview: IWorkspaceReplacementPreviewPayload,
  ): void => {
    const visibleLineIds = new Set(
      preview.files.flatMap((file) => file.linePreviews.map((line) => line.id)),
    );
    skippedReplacementLineIds.value = new Set(
      [...skippedReplacementLineIds.value].filter((lineId) => visibleLineIds.has(lineId)),
    );
  };

  const refreshReplacementPreviewAfterLineApply = async (
    request: IWorkspaceReplacementRequest,
    lifecycle: TReplacementApplyLifecycle,
  ): Promise<void> => {
    const requestId = replacementPreviewRequestId + 1;
    replacementPreviewRequestId = requestId;
    activeReplacementPreviewAbortController?.abort();
    const abortController = new AbortController();
    activeReplacementPreviewAbortController = abortController;
    replacementPreviewOpen.value = true;

    try {
      const preview = await tauriService.previewWorkspaceReplacement(request, {
        signal: abortController.signal,
      });
      if (
        abortController.signal.aborted ||
        requestId !== replacementPreviewRequestId ||
        !isReplacementApplyLifecycleCurrent(lifecycle)
      )
        return;
      if (preview.fileCount === 0) {
        replacementPreview.value = null;
        replacementPreviewRequest.value = request;
        skippedReplacementLineIds.value = new Set<string>();
        return;
      }
      replacementPreview.value = preview;
      replacementPreviewRequest.value = request;
      retainVisibleSkippedReplacementLines(preview);
    } catch (error) {
      if (
        abortController.signal.aborted ||
        requestId !== replacementPreviewRequestId ||
        !isReplacementApplyLifecycleCurrent(lifecycle)
      )
        return;
      message.error(toErrorMessage(error, '刷新替换预览失败。'));
    } finally {
      if (requestId === replacementPreviewRequestId) activeReplacementPreviewAbortController = null;
    }
  };

  const reportReplacementRefreshOutcome = (
    refreshResult: IRefreshSidecarChangedDocumentsResult,
    replacementCount: number,
    successMessage: string,
  ): void => {
    const issues: string[] = [];
    if (refreshResult.skippedDirtyNames.length > 0)
      issues.push(`${refreshResult.skippedDirtyNames.join('、')} 有未保存改动，已跳过自动刷新`);
    if (refreshResult.failedNames.length > 0)
      issues.push(`${refreshResult.failedNames.join('、')} 刷新失败，请手动重新打开`);
    if (issues.length > 0) {
      message.warning(`已替换 ${replacementCount} 处内容，但 ${issues.join('；')}。`);
      return;
    }
    message.success(successMessage);
  };

  const applyReplacementAndRefresh = async (
    request: IWorkspaceReplacementRequest,
    expectedFiles: Array<{ path: string; beforeHash: string; includedMatchIds: string[] }>,
    lifecycle: TReplacementApplyLifecycle,
  ) => {
    const payload = await applyWorkspaceReplacementWithOptions(
      { request, expectedFiles },
      { signal: lifecycle.signal },
    );
    if (!isReplacementApplyLifecycleCurrent(lifecycle)) return null;
    const refreshResult = await refreshSidecarChangedDocuments({
      changedFilePaths: payload.files.map((changedFile: { path: string }) => changedFile.path),
      hasFileMutations: true,
      workspaceRootPath: payload.rootPath,
    });
    if (!isReplacementApplyLifecycleCurrent(lifecycle)) return null;
    return { payload, refreshResult };
  };

  const confirmReplacementPreview = async (): Promise<void> => {
    const request = replacementPreviewRequest.value;
    const files = visibleReplacementFiles.value;
    if (!request || replacementApplying.value) return;
    if (files.length === 0) {
      message.warning('当前没有待替换项。');
      return;
    }

    const lifecycle = beginReplacementApplyLifecycle();
    replacementApplying.value = true;
    replaceRunning.value = true;

    try {
      const result = await applyReplacementAndRefresh(
        request,
        files.map((file) => ({
          path: file.path,
          beforeHash: file.beforeHash,
          includedMatchIds: file.visibleLinePreviews.map((line) => line.id),
        })),
        lifecycle,
      );
      if (!result || !isReplacementApplyLifecycleCurrent(lifecycle)) return;
      const { payload, refreshResult } = result;
      replacementPreviewOpen.value = false;
      replacementPreview.value = null;
      replacementPreviewRequest.value = null;
      replacementPreviewRequestId += 1;
      reportReplacementRefreshOutcome(
        refreshResult,
        payload.replacementCount,
        `已替换 ${payload.changedFileCount} 个文件中的 ${payload.replacementCount} 处内容。`,
      );
      void runSearch();
    } catch (error) {
      if (
        lifecycle.signal.aborted ||
        !isReplacementApplyLifecycleCurrent(lifecycle) ||
        isCanceledIpcError(error)
      )
        return;
      message.error(toErrorMessage(error, '替换失败。'));
    } finally {
      if (lifecycle.requestId === replacementApplyRequestId) {
        replacementApplying.value = false;
        replaceRunning.value = false;
        replacementApplyingLineId.value = null;
        activeReplacementApplyAbortController = null;
      }
    }
  };

  const handleReplacementAction = async (): Promise<void> => {
    if (replacementPreviewOpen.value && replacementPreview.value) {
      await confirmReplacementPreview();
      return;
    }
    const hasPreview = await previewReplacementToSearch('manual');
    if (hasPreview) await confirmReplacementPreview();
  };

  const scheduleReplacementPreview = (): void => {
    if (replacementPreviewTimer) clearTimeout(replacementPreviewTimer);
    replacementPreviewTimer = setTimeout(() => {
      replacementPreviewTimer = null;
      void previewReplacementToSearch('auto');
    }, SEARCH_DEBOUNCE_MS);
  };

  const skipReplacementLine = (lineId: string): void => {
    skippedReplacementLineIds.value = new Set([...skippedReplacementLineIds.value, lineId]);
  };

  const replaceReplacementLine = async (
    file: IReplacementFileView,
    line: IReplacementLineView,
  ): Promise<void> => {
    const request = replacementPreviewRequest.value;
    if (!request || replacementApplying.value) return;

    const lifecycle = beginReplacementApplyLifecycle();
    replacementApplying.value = true;
    replaceRunning.value = true;
    replacementApplyingLineId.value = line.id;

    try {
      const result = await applyReplacementAndRefresh(
        request,
        [
          {
            path: file.path,
            beforeHash: file.beforeHash,
            includedMatchIds: [line.id],
          },
        ],
        lifecycle,
      );
      if (!result || !isReplacementApplyLifecycleCurrent(lifecycle)) return;
      const { payload, refreshResult } = result;
      await refreshReplacementPreviewAfterLineApply(request, lifecycle);
      if (!isReplacementApplyLifecycleCurrent(lifecycle)) return;
      reportReplacementRefreshOutcome(
        refreshResult,
        payload.replacementCount,
        `已替换 ${payload.replacementCount} 处内容。`,
      );
      void runSearch();
    } catch (error) {
      if (
        lifecycle.signal.aborted ||
        !isReplacementApplyLifecycleCurrent(lifecycle) ||
        isCanceledIpcError(error)
      )
        return;
      message.error(toErrorMessage(error, '替换失败。'));
    } finally {
      if (lifecycle.requestId === replacementApplyRequestId) {
        replacementApplying.value = false;
        replaceRunning.value = false;
        replacementApplyingLineId.value = null;
        activeReplacementApplyAbortController = null;
      }
    }
  };

  const handleReplacementLineOpen = (path: string, lineNumber: number): void => {
    clearSelectedResult();
    emitOpenFile({ path, lineNumber, column: 1 });
  };

  const resetReplacementQuery = (): void => {
    replacementQuery.value = '';
  };

  const cancelPendingReplacement = (): void => {
    if (replacementPreviewTimer) {
      clearTimeout(replacementPreviewTimer);
      replacementPreviewTimer = null;
    }
    activeReplacementPreviewAbortController?.abort();
    activeReplacementPreviewAbortController = null;
    invalidateReplacementApplyLifecycle();
  };

  onScopeDispose(() => {
    resetReplacementPreview();
  });

  return {
    replacementQuery,
    replaceRunning,
    replacementApplying,
    replacementApplyingLineId,
    replacementPreviewOpen,
    replacementPreview,
    skippedReplacementLineIds,
    collapsedReplacementFilePaths,
    canApplyReplacement,
    visibleReplacementFiles,
    isReplacementFileCollapsed,
    toggleReplacementFile,
    resetReplacementPreview,
    resetReplacementQuery,
    previewReplacementToSearch,
    handleReplacementAction,
    scheduleReplacementPreview,
    confirmReplacementPreview,
    skipReplacementLine,
    replaceReplacementLine,
    handleReplacementLineOpen,
    cancelPendingReplacement,
  };
};
