import type { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import type { useEditorStore } from '@/store/editor';
import type { IEditorDocument, IScriptFilePayload } from '@/types/editor';
import type { IGitDiffPreviewPayload, IGitDiffPreviewRequest } from '@/types/git';
import type { TSessionSnapshot, TSessionTabKind } from '@/types/session';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { isImageAssetPath } from '@/utils/file-assets';
import { getPathBaseName } from '@/utils/path';
import { isWorkspaceRootAccessible } from '@/utils/workspace';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type TEditorStore = ReturnType<typeof useEditorStore>;
type TNotifier = ReturnType<typeof useMessage>;
type TWorkbenchOpenTarget = 'file' | 'image';

type TRestoredSessionTab = {
  kind: TSessionTabKind;
  imagePath?: string;
  imageName?: string;
  payload?: IScriptFilePayload;
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

const MAX_OPEN_TABS = 30;

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
    notifier.warning(`最多只能同时打开 ${MAX_OPEN_TABS} 个标签页`);
    return false;
  };

  const notifyDocumentOpenResult = (
    scene: string,
    kind: TWorkbenchOpenTarget,
    name: string,
    path: string,
    reusedExisting: boolean,
  ): void => {
    const labels = ACTION_LABEL_TABLE[kind];
    const toasts = TOAST_TEMPLATE_TABLE[kind];
    const actionLabel = reusedExisting ? labels.reused : labels.opened;
    const toastMessage = reusedExisting ? toasts.reused(name) : toasts.opened(name);

    editorStore.appendLog(
      reusedExisting ? 'info' : 'success',
      scene,
      buildLogDetail(actionLabel, path),
    );
    notifier.success(toastMessage);
  };

  /**
   * 共享的"打开一个 tab"骨架：
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
  ): void => {
    const existing = editorStore.findDocumentByPath(path);
    if (!existing && !ensureCanOpenNewTab()) return;

    const { reusedExisting } = open();
    notifyDocumentOpenResult(scene, kind, name, path, reusedExisting);
  };

  // -----------------------------------------------------------------------
  // Document loaders
  // -----------------------------------------------------------------------

  const openScriptPayload = (payload: IScriptFilePayload, scene: string): void => {
    openTabAndNotify(scene, 'file', payload.path, payload.name, () =>
      editorStore.openDocumentTab(payload),
    );
  };

  const loadDocumentFromPath = async (path: string, scene: string): Promise<void> => {
    if (isImageAssetPath(path)) {
      const imageName = getPathBaseName(path);
      openTabAndNotify(scene, 'image', path, imageName, () =>
        editorStore.openImageDocument(path, imageName),
      );
      return;
    }

    const payload = await tauriService.loadScript(path);
    openScriptPayload(payload, scene);
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
    const loadedTabs = await Promise.all(
      openTabs.map(async (tab): Promise<TRestoredSessionTab | null> => {
        try {
          const kind = resolveSessionTabKind(tab);
          if (kind === 'image') {
            return {
              kind,
              imagePath: tab.path,
              imageName: getPathBaseName(tab.path),
              order: tab.order,
            };
          }
          const payload = await tauriService.loadScript(tab.path);
          return { kind, payload, order: tab.order };
        } catch {
          notifier.info(`文件已不可用，已从会话移除：${tab.path}`);
          return null;
        }
      }),
    );
    return loadedTabs.filter(isRestoredSessionTab).sort((left, right) => left.order - right.order);
  };

  /** 把单个还原后的 tab 派发回 editorStore，分支语义与原版一致。 */
  const applyRestoredTab = (tab: TRestoredSessionTab): void => {
    if (tab.kind === 'image' && tab.imagePath && tab.imageName) {
      editorStore.openImageDocument(tab.imagePath, tab.imageName);
      return;
    }
    if (tab.payload) {
      editorStore.openDocumentTab(tab.payload);
    }
  };

  const restoreActiveDocument = (activePath: string | null): void => {
    if (activePath) {
      const activeDocument = editorStore.documents.find((item) => item.path === activePath);
      if (activeDocument) {
        editorStore.setActiveDocument(activeDocument.id);
        return;
      }
    }
    const firstDocument = editorStore.documents[0];
    if (firstDocument) {
      editorStore.setActiveDocument(firstDocument.id);
    }
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

    restoreActiveDocument(snapshot.activeTabPath);
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
        editorStore.setActiveDocument(existingDocument.id);
        notifier.success(`已切换到 ${existingDocument.name}`);
        return;
      }
      await loadDocumentFromPath(path, '资源管理器打开文件');
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
  };
};
