import { onScopeDispose } from 'vue';
import type { useMessage } from '@/composables/useMessage';
import { WORKBENCH_TAB_LIMITS } from '@/constants/workbench';
import { tauriService } from '@/services/tauri';
import type { useEditorStore } from '@/store/editor';
import { isAppError } from '@/types/app-error';
import type { IEditorDocument, IWorkspaceDirectoryPayload } from '@/types/editor';
import type { IGitDiffPreviewPayload, IGitDiffPreviewRequest } from '@/types/git';
import type { TSessionSnapshot, TSessionTabKind } from '@/types/session';
import { isImageAssetPath } from '@/utils/file/file-assets';
import {
  areFileSystemPathsEqual,
  getPathBaseName,
  getRelativeFileSystemPath,
} from '@/utils/file/path';
import { waitForDesktopRuntime } from '@/utils/platform/desktop-runtime';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type TEditorStore = ReturnType<typeof useEditorStore>;
type TNotifier = ReturnType<typeof useMessage>;
type TWorkbenchOpenTarget = 'file' | 'image';

type TRestoredSessionTab = {
  kind: TSessionTabKind;
  path: string;
  name: string;
  order: number;
};

type TRestorableSessionSnapshot = Pick<TSessionSnapshot, 'workspaceRoot' | 'activeTabPath'> & {
  openTabs: Array<Pick<TSessionSnapshot['openTabs'][number], 'path' | 'order' | 'kind'>>;
};

type TDocumentIoLifecycle = {
  token: number;
  signal: AbortSignal;
};

type TCancelableLoadScript = (
  path: string,
  workspaceRootPath?: string | null,
  options?: { signal?: AbortSignal },
) => ReturnType<typeof tauriService.loadScript>;

type TCancelableListWorkspaceEntries = (
  path?: string,
  rootPath?: string,
  options?: { signal?: AbortSignal },
) => Promise<IWorkspaceDirectoryPayload>;

type TCancelableGetGitDiffPreview = (
  request: IGitDiffPreviewRequest,
  options?: { signal?: AbortSignal },
) => ReturnType<typeof tauriService.getGitDiffPreview>;

interface IUseWorkbenchDocumentIOOptions {
  editorStore: TEditorStore;
  notifier: TNotifier;
  reportError: (scene: string, error: unknown, fallbackMessage: string) => void;
  buildDefaultScriptContent: () => string;
  ensureDirtyDocumentsHandled: (
    dirtyDocuments: IEditorDocument[],
    scene: 'switch-workspace',
  ) => Promise<boolean>;
  refreshGitRepositoryStatus: (workspaceRootPath?: string | null) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants & module-level helpers
// ---------------------------------------------------------------------------

/** 文件 / 图片打开后的日志短语。 */
const ACTION_LABEL_TABLE: Record<TWorkbenchOpenTarget, { reused: string; opened: string }> = {
  image: { reused: '切换到已打开图片', opened: '已加载图片' },
  file: { reused: '切换到已打开文件', opened: '已加载文件' },
};

/** 文件 / 图片打开后的 toast 文案。 */
const TOAST_TEMPLATE_TABLE: Record<
  TWorkbenchOpenTarget,
  { reused: (name: string) => string; opened: (name: string) => string }
> = {
  image: {
    reused: (name) => `已切换到 ${name}`,
    opened: (name) => `已打开图片 ${name}`,
  },
  file: {
    reused: (name) => `已切换到 ${name}`,
    opened: (name) => `已打开 ${name}`,
  },
};

const buildLogDetail = (title: string, detail: string): string => `${title}：${detail}`;

const isSameGitDiffPreview = (
  left: IGitDiffPreviewPayload,
  right: IGitDiffPreviewPayload,
): boolean => left.id === right.id;

const resolveSessionTabKind = (
  tab: TRestorableSessionSnapshot['openTabs'][number],
): TSessionTabKind => tab.kind ?? (isImageAssetPath(tab.path) ? 'image' : 'text');

const pickRestorableSessionSnapshot = (snapshot: TSessionSnapshot): TRestorableSessionSnapshot => ({
  workspaceRoot: snapshot.workspaceRoot,
  activeTabPath: snapshot.activeTabPath,
  openTabs: snapshot.openTabs.map(({ path, order, kind }) => ({
    path,
    order,
    kind,
  })),
});

const scopedWorkspaceRootForPath = (
  path: string,
  workspaceRoot: string | null | undefined,
): string | null => {
  if (!workspaceRoot) return null;
  return getRelativeFileSystemPath(path, workspaceRoot) === null ? null : workspaceRoot;
};

const isCanceledIpcError = (error: unknown): boolean =>
  isAppError(error) && error.code === 'ipc.canceled';

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export const useWorkbenchDocumentIO = ({
  editorStore,
  notifier,
  reportError,
  buildDefaultScriptContent,
  ensureDirtyDocumentsHandled,
  refreshGitRepositoryStatus,
}: IUseWorkbenchDocumentIOOptions) => {
  let documentIoLifecycleToken = 0;
  let activeDocumentIoAbortController: AbortController | null = null;

  const loadScriptWithOptions = tauriService.loadScript as TCancelableLoadScript;
  const listWorkspaceEntriesWithOptions =
    tauriService.listWorkspaceEntries as TCancelableListWorkspaceEntries;
  const getGitDiffPreviewWithOptions =
    tauriService.getGitDiffPreview as TCancelableGetGitDiffPreview;

  const invalidateDocumentIoLifecycle = (): void => {
    documentIoLifecycleToken += 1;
    activeDocumentIoAbortController?.abort();
    activeDocumentIoAbortController = null;
  };

  const beginDocumentIoLifecycle = (): TDocumentIoLifecycle => {
    invalidateDocumentIoLifecycle();
    const controller = new AbortController();
    activeDocumentIoAbortController = controller;
    return {
      token: documentIoLifecycleToken,
      signal: controller.signal,
    };
  };

  const isDocumentIoLifecycleCurrent = (lifecycle: TDocumentIoLifecycle): boolean =>
    lifecycle.token === documentIoLifecycleToken && !lifecycle.signal.aborted;

  const isWorkspaceRootCurrent = (workspaceRootPath: string | null | undefined): boolean => {
    if (!workspaceRootPath) return true;
    return areFileSystemPathsEqual(workspaceRootPath, editorStore.workspaceRootPath);
  };

  onScopeDispose(() => {
    invalidateDocumentIoLifecycle();
  });

  // -----------------------------------------------------------------------
  // Tab quota & notifications
  // -----------------------------------------------------------------------

  const ensureCanOpenNewTab = (): boolean => {
    if (editorStore.canOpenMoreTabs) return true;
    notifier.warning(`最多只能同时打开 ${WORKBENCH_TAB_LIMITS.maxOpenTabs} 个标签页`);
    return false;
  };

  const notifyDocumentOpenResult = (
    scene: string,
    kind: TWorkbenchOpenTarget,
    name: string,
    path: string,
    reusedExisting: boolean,
    options?: {
      /**
       * 是否显示 toast。
       *
       * 默认规则：
       * - reusedExisting: false → true (真正打开了新 tab)
       * - reusedExisting: true → false (频繁切 tab 时 toast 会带来额外渲染/布局开销)
       */
      toast?: boolean;
      /** 是否写入 log；同 toast，切 tab 场景默认关闭以减少噪音与渲染开销。 */
      log?: boolean;
    },
  ): void => {
    const shouldToast = options?.toast ?? !reusedExisting;
    const shouldLog = options?.log ?? !reusedExisting;

    const labels = ACTION_LABEL_TABLE[kind];
    const toasts = TOAST_TEMPLATE_TABLE[kind];
    const actionLabel = reusedExisting ? labels.reused : labels.opened;
    const toastMessage = reusedExisting ? toasts.reused(name) : toasts.opened(name);

    if (shouldLog) {
      editorStore.appendLog(
        reusedExisting ? 'info' : 'success',
        scene,
        buildLogDetail(actionLabel, path),
      );
    }

    if (shouldToast) {
      notifier.success(toastMessage);
    }
  };

  /**
   * 共享的\"打开一个 tab\"骨架：
   *   1. 已有同 path 文档 → 跳过配额检查
   *   2. 否则受 `ensureCanOpenNewTab` 闸门控制
   *   3. 调用具体的 store 打开方法（image / script）
   *   4. 统一 toast + appendLog
   */
  const openTabAndNotify = (
    scene: string,
    kind: TWorkbenchOpenTarget,
    path: string,
    name: string,
    open: () => { reusedExisting: boolean },
    options?: {
      toast?: boolean;
      log?: boolean;
    },
  ): void => {
    const existing = editorStore.findDocumentByPath(path);
    if (!existing && !ensureCanOpenNewTab()) return;

    const { reusedExisting } = open();
    notifyDocumentOpenResult(scene, kind, name, path, reusedExisting, options);
  };

  // -----------------------------------------------------------------------
  // Document loaders
  // -----------------------------------------------------------------------

  const openScriptPayload = (
    payload: Awaited<ReturnType<typeof tauriService.loadScript>>,
    scene: string,
  ): void => {
    openTabAndNotify(scene, 'file', payload.path, payload.name, () =>
      editorStore.openDocumentTab(payload),
    );
  };

  const loadDocumentFromPath = async (
    path: string,
    scene: string,
    workspaceRootPath: string | null | undefined,
    lifecycle: TDocumentIoLifecycle,
  ): Promise<boolean> => {
    if (isImageAssetPath(path)) {
      if (!isDocumentIoLifecycleCurrent(lifecycle) || !isWorkspaceRootCurrent(workspaceRootPath)) {
        return false;
      }
      const imageName = getPathBaseName(path);
      openTabAndNotify(scene, 'image', path, imageName, () =>
        editorStore.openImageDocument(path, imageName),
      );
      return true;
    }

    const payload = await loadScriptWithOptions(
      path,
      scopedWorkspaceRootForPath(path, workspaceRootPath),
      { signal: lifecycle.signal },
    );

    if (!isDocumentIoLifecycleCurrent(lifecycle) || !isWorkspaceRootCurrent(workspaceRootPath)) {
      return false;
    }

    openScriptPayload(payload, scene);
    return true;
  };

  const ensureDocumentBufferLoaded = async (
    documentId: string,
    lifecycle: TDocumentIoLifecycle = beginDocumentIoLifecycle(),
  ): Promise<void> => {
    const targetDocument = editorStore.getDocumentById(documentId);
    if (
      targetDocument?.kind !== 'text' ||
      targetDocument.bufferLoaded !== false ||
      !targetDocument.path
    ) {
      return;
    }

    await loadDocumentFromPath(
      targetDocument.path,
      '加载标签页内容',
      editorStore.workspaceRootPath,
      lifecycle,
    );
  };

  // -----------------------------------------------------------------------
  // Session restoration
  // -----------------------------------------------------------------------

  const restoreWorkspaceRoot = async (
    workspaceRoot: string,
    lifecycle: TDocumentIoLifecycle,
  ): Promise<boolean> => {
    try {
      await listWorkspaceEntriesWithOptions(undefined, workspaceRoot, { signal: lifecycle.signal });
    } catch (error) {
      if (isCanceledIpcError(error) || !isDocumentIoLifecycleCurrent(lifecycle)) {
        return false;
      }
      editorStore.setWorkspaceRootPath(null);
      notifier.warning('上次的工作区已失效，已重置');
      return false;
    }

    if (!isDocumentIoLifecycleCurrent(lifecycle)) {
      return false;
    }

    editorStore.setWorkspaceRootPath(workspaceRoot);
    return true;
  };

  const restoreOpenTabs = (
    openTabs: TRestorableSessionSnapshot['openTabs'],
  ): TRestoredSessionTab[] =>
    openTabs
      .map(
        (tab): TRestoredSessionTab => ({
          kind: resolveSessionTabKind(tab),
          path: tab.path,
          name: getPathBaseName(tab.path),
          order: tab.order,
        }),
      )
      .sort((left, right) => left.order - right.order);

  /**
   * 把单个还原后的 tab 派发回 editorStore。
   * 恢复阶段只还原标签元数据；文本正文按需加载，避免启动时一次性读取大量文件。
   */
  const applyRestoredTab = (tab: TRestoredSessionTab): void => {
    if (tab.kind === 'image') {
      editorStore.openImageDocument(tab.path, tab.name);
      return;
    }

    editorStore.openUnloadedTextDocumentTab(tab.path, tab.name);
  };

  const restoreActiveDocument = (activePath: string | null): IEditorDocument | null => {
    if (activePath) {
      const activeDocument = editorStore.findDocumentByPath(activePath);
      if (activeDocument) {
        editorStore.setActiveDocument(activeDocument.id);
        return activeDocument;
      }
    }
    const firstDocument = editorStore.documents[0];
    if (firstDocument) {
      editorStore.setActiveDocument(firstDocument.id);
      return firstDocument;
    }
    return null;
  };

  const tryLoadRestoredDocument = async (
    document: IEditorDocument,
    lifecycle: TDocumentIoLifecycle,
  ): Promise<IEditorDocument | null> => {
    try {
      await ensureDocumentBufferLoaded(document.id, lifecycle);
      return isDocumentIoLifecycleCurrent(lifecycle)
        ? (editorStore.getDocumentById(document.id) ?? null)
        : null;
    } catch (error) {
      if (isCanceledIpcError(error) || !isDocumentIoLifecycleCurrent(lifecycle)) {
        return null;
      }
      editorStore.closeDocument(document.id);
      notifier.info('上次会话中部分文件已失效，已跳过');
      return null;
    }
  };

  const restoreActiveDocumentBuffer = async (
    activeDocument: IEditorDocument,
    lifecycle: TDocumentIoLifecycle,
  ): Promise<IEditorDocument | null> => {
    const loadedActiveDocument = await tryLoadRestoredDocument(activeDocument, lifecycle);
    if (loadedActiveDocument || !isDocumentIoLifecycleCurrent(lifecycle)) {
      return loadedActiveDocument;
    }

    const fallbackDocument = editorStore.getDocumentById();
    if (!fallbackDocument) {
      return null;
    }

    return tryLoadRestoredDocument(fallbackDocument, lifecycle);
  };

  const restoreSession = async (sessionSnapshot: TSessionSnapshot): Promise<void> => {
    const lifecycle = beginDocumentIoLifecycle();
    const runtimeReady = await waitForDesktopRuntime(120);
    if (!runtimeReady || !isDocumentIoLifecycleCurrent(lifecycle)) return;

    const snapshot = pickRestorableSessionSnapshot(sessionSnapshot);
    if (!snapshot.workspaceRoot && snapshot.openTabs.length === 0) return;

    if (snapshot.workspaceRoot) {
      await restoreWorkspaceRoot(snapshot.workspaceRoot, lifecycle);
      if (!isDocumentIoLifecycleCurrent(lifecycle)) return;
    }
    if (snapshot.openTabs.length === 0) return;

    if (!isDocumentIoLifecycleCurrent(lifecycle)) return;
    editorStore.clearDocuments();

    const aliveTabs = restoreOpenTabs(snapshot.openTabs);
    if (!isDocumentIoLifecycleCurrent(lifecycle)) return;

    aliveTabs.forEach(applyRestoredTab);

    if (aliveTabs.length === 0) return;

    const activeDocument = restoreActiveDocument(snapshot.activeTabPath);
    if (activeDocument) {
      const loadedActiveDocument = await restoreActiveDocumentBuffer(activeDocument, lifecycle);
      if (
        loadedActiveDocument &&
        isDocumentIoLifecycleCurrent(lifecycle) &&
        editorStore.restoreDraftForDocument(loadedActiveDocument.id)
      ) {
        notifier.info('已恢复 1 个文件未保存的修改');
      }
    }
  };

  // -----------------------------------------------------------------------
  // Public actions
  // -----------------------------------------------------------------------

  const createNewDocument = (): void => {
    if (!ensureCanOpenNewTab()) return;

    const nextDocument = editorStore.createDocumentTab({
      content: buildDefaultScriptContent(),
    });
    editorStore.appendLog('info', '新建脚本', `已创建新的脚本草稿：${nextDocument.name}。`);
    notifier.success('已创建新的脚本草稿');
  };

  const openDocument = async (): Promise<void> => {
    try {
      const path = await tauriService.pickOpenPath();
      if (!path) return;
      const lifecycle = beginDocumentIoLifecycle();
      await loadDocumentFromPath(path, '打开脚本', null, lifecycle);
    } catch (error) {
      if (isCanceledIpcError(error)) return;
      reportError('打开脚本失败', error, '打开脚本失败');
    }
  };

  const openFolder = async (): Promise<void> => {
    try {
      const path = await tauriService.pickOpenFolderPath();
      if (!path) return;

      const canSwitchWorkspace = await ensureDirtyDocumentsHandled(
        editorStore.dirtyDocuments,
        'switch-workspace',
      );
      if (!canSwitchWorkspace) return;

      invalidateDocumentIoLifecycle();
      editorStore.clearDocuments();
      editorStore.setWorkspaceRootPath(path);
      void refreshGitRepositoryStatus(path);

      editorStore.appendLog('success', '打开文件夹', buildLogDetail('资源目录', path));
      notifier.success(`已打开文件夹 ${getPathBaseName(path)}`);
    } catch (error) {
      if (isCanceledIpcError(error)) return;
      reportError('打开文件夹失败', error, '打开文件夹失败');
    }
  };

  const openDocumentByPath = async (path: string): Promise<void> => {
    const lifecycle = beginDocumentIoLifecycle();
    try {
      const existingDocument = editorStore.findDocumentByPath(path);
      if (existingDocument) {
        // 频繁切换文件时，toast + appendLog 会带来额外渲染/布局开销；这里默认静默切换。
        editorStore.setActiveDocument(existingDocument.id);
        await ensureDocumentBufferLoaded(existingDocument.id, lifecycle);
        return;
      }

      await loadDocumentFromPath(
        path,
        '资源管理器打开文件',
        editorStore.workspaceRootPath,
        lifecycle,
      );
    } catch (error) {
      if (isCanceledIpcError(error)) return;
      reportError('打开资源文件失败', error, '打开资源文件失败');
    }
  };

  const presentResolvedGitDiffPreview = (
    preview: IGitDiffPreviewPayload,
    options: { modeLabel: string; scene: string },
  ): void => {
    const existing = editorStore.documents.find(
      (item) =>
        item.kind === 'git-diff' &&
        item.gitDiffPreview !== undefined &&
        isSameGitDiffPreview(item.gitDiffPreview, preview),
    );

    if (!existing && !ensureCanOpenNewTab()) {
      return;
    }

    const { reusedExisting } = editorStore.openGitDiffDocument(preview);
    const detail = buildLogDetail(
      reusedExisting ? '切换到 Git Diff' : '已打开 Git Diff',
      `${preview.relativePath} · ${options.modeLabel}`,
    );

    editorStore.appendLog(preview.isEmpty ? 'info' : 'success', options.scene, detail);
    notifier.success(preview.isEmpty ? '没有可显示的 Diff' : `已打开 Diff ${preview.relativePath}`);
  };

  const openGitDiffPreview = async (request: IGitDiffPreviewRequest): Promise<void> => {
    const lifecycle = beginDocumentIoLifecycle();
    const workspaceRootPathAtStart = editorStore.workspaceRootPath;
    try {
      const preview = await getGitDiffPreviewWithOptions(request, { signal: lifecycle.signal });
      if (
        !isDocumentIoLifecycleCurrent(lifecycle) ||
        !isWorkspaceRootCurrent(workspaceRootPathAtStart)
      ) {
        return;
      }

      presentResolvedGitDiffPreview(preview, { modeLabel: preview.mode, scene: '查看 Git Diff' });
    } catch (error) {
      if (isCanceledIpcError(error)) return;
      reportError('打开 Git Diff 失败', error, '打开 Git Diff 失败');
    }
  };

  const openGitDiffPreviewPayload = (preview: IGitDiffPreviewPayload): void => {
    presentResolvedGitDiffPreview(preview, { modeLabel: 'Patch', scene: '查看 Patch Diff' });
  };

  return {
    createNewDocument,
    restoreSession,
    openDocument,
    openFolder,
    openDocumentByPath,
    openGitDiffPreview,
    openGitDiffPreviewPayload,
    ensureDocumentBufferLoaded,
  };
};
