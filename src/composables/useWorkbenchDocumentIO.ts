import type { useMessage } from '@/composables/useMessage';
import { WORKBENCH_TAB_LIMITS } from '@/constants/workbench';
import { tauriService } from '@/services/tauri';
import type { useEditorStore } from '@/store/editor';
import type { IEditorDocument } from '@/types/editor';
import type { IGitDiffPreviewPayload, IGitDiffPreviewRequest } from '@/types/git';
import type { TSessionSnapshot, TSessionTabKind } from '@/types/session';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { isImageAssetPath } from '@/utils/file-assets';
import { getPathBaseName, getRelativeFileSystemPath } from '@/utils/path';
import { isWorkspaceRootAccessible } from '@/utils/workspace';

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

const isRestoredSessionTab = (value: TRestoredSessionTab | null): value is TRestoredSessionTab =>
  value !== null;

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
    workspaceRootPath?: string | null,
  ): Promise<void> => {
    if (isImageAssetPath(path)) {
      const imageName = getPathBaseName(path);
      openTabAndNotify(scene, 'image', path, imageName, () =>
        editorStore.openImageDocument(path, imageName),
      );
      return;
    }

    const payload = await tauriService.loadScript(
      path,
      scopedWorkspaceRootForPath(path, workspaceRootPath),
    );
    openScriptPayload(payload, scene);
  };

  const ensureDocumentBufferLoaded = async (documentId: string): Promise<void> => {
    const targetDocument = editorStore.getDocumentById(documentId);
    if (
      !targetDocument ||
      targetDocument.kind !== 'text' ||
      targetDocument.bufferLoaded !== false ||
      !targetDocument.path
    ) {
      return;
    }

    await loadDocumentFromPath(
      targetDocument.path,
      '加载标签页内容',
      editorStore.workspaceRootPath,
    );
  };

  // -----------------------------------------------------------------------
  // Session restoration
  // -----------------------------------------------------------------------

  const restoreWorkspaceRoot = async (workspaceRoot: string): Promise<void> => {
    const accessible = await isWorkspaceRootAccessible(
      workspaceRoot,
      tauriService.listWorkspaceEntries,
    );
    if (accessible) {
      editorStore.setWorkspaceRootPath(workspaceRoot);
      return;
    }
    editorStore.setWorkspaceRootPath(null);
    notifier.warning('上次的工作区已失效，已重置');
  };

  const restoreOpenTabs = async (
    openTabs: TRestorableSessionSnapshot['openTabs'],
  ): Promise<TRestoredSessionTab[]> => {
    const restoredTabs = openTabs
      .map((tab): TRestoredSessionTab | null => {
        const kind = resolveSessionTabKind(tab);
        return {
          kind,
          path: tab.path,
          name: getPathBaseName(tab.path),
          order: tab.order,
        };
      })
      .filter(isRestoredSessionTab)
      .sort((left, right) => left.order - right.order);

    return restoredTabs;
  };

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

  const restoreSession = async (sessionSnapshot: TSessionSnapshot): Promise<void> => {
    const runtimeReady = await waitForDesktopRuntime(120);
    if (!runtimeReady) return;

    const snapshot = pickRestorableSessionSnapshot(sessionSnapshot);
    if (!snapshot.workspaceRoot && snapshot.openTabs.length === 0) return;

    if (snapshot.workspaceRoot) {
      await restoreWorkspaceRoot(snapshot.workspaceRoot);
    }
    if (snapshot.openTabs.length === 0) return;

    editorStore.clearDocuments();

    const aliveTabs = await restoreOpenTabs(snapshot.openTabs);
    aliveTabs.forEach(applyRestoredTab);

    if (aliveTabs.length === 0) return;

    const activeDocument = restoreActiveDocument(snapshot.activeTabPath);
    if (activeDocument) {
      await ensureDocumentBufferLoaded(activeDocument.id);
      if (editorStore.restoreDraftForDocument(activeDocument.id)) {
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
      await loadDocumentFromPath(path, '打开脚本');
    } catch (error) {
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

      editorStore.clearDocuments();
      editorStore.setWorkspaceRootPath(path);
      void refreshGitRepositoryStatus(path);

      editorStore.appendLog('success', '打开文件夹', buildLogDetail('资源目录', path));
      notifier.success(`已打开文件夹 ${getPathBaseName(path)}`);
    } catch (error) {
      reportError('打开文件夹失败', error, '打开文件夹失败');
    }
  };

  const openDocumentByPath = async (path: string): Promise<void> => {
    try {
      const existingDocument = editorStore.findDocumentByPath(path);
      if (existingDocument) {
        // 频繁切换文件时，toast + appendLog 会带来额外渲染/布局开销；这里默认静默切换。
        editorStore.setActiveDocument(existingDocument.id);
        await ensureDocumentBufferLoaded(existingDocument.id);
        return;
      }

      await loadDocumentFromPath(path, '资源管理器打开文件', editorStore.workspaceRootPath);
    } catch (error) {
      reportError('打开资源文件失败', error, '打开资源文件失败');
    }
  };

  const openGitDiffPreview = async (request: IGitDiffPreviewRequest): Promise<void> => {
    try {
      const preview = await tauriService.getGitDiffPreview(request);
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
        `${preview.relativePath} · ${preview.mode}`,
      );

      editorStore.appendLog(preview.isEmpty ? 'info' : 'success', '查看 Git Diff', detail);
      notifier.success(
        preview.isEmpty ? '没有可显示的 Diff' : `已打开 Diff ${preview.relativePath}`,
      );
    } catch (error) {
      reportError('打开 Git Diff 失败', error, '打开 Git Diff 失败');
    }
  };

  const openGitDiffPreviewPayload = (preview: IGitDiffPreviewPayload): void => {
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
      `${preview.relativePath} · Patch`,
    );

    editorStore.appendLog(preview.isEmpty ? 'info' : 'success', '查看 Patch Diff', detail);
    notifier.success(preview.isEmpty ? '没有可显示的 Diff' : `已打开 Diff ${preview.relativePath}`);
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
