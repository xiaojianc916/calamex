import { useDialog } from '@/composables/useDialog';
import { useMessage } from '@/composables/useMessage';
import type { useEditorStore } from '@/store/editor';
import type { useGitStore } from '@/store/git';
import type { IEditorDocument } from '@/types/editor';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import {
  allowNextProgrammaticWindowClose,
  clearProgrammaticWindowCloseAllowance,
} from '@/utils/window-close';

type TEditorStore = ReturnType<typeof useEditorStore>;
type TGitStore = ReturnType<typeof useGitStore>;

type TDirtyCloseAction = 'save' | 'discard' | 'cancel';
type TDirtyCloseScene =
  | 'close-document'
  | 'close-application'
  | 'close-workspace'
  | 'switch-workspace';

type TUseDocumentLifecycleOptions = {
  editorStore: TEditorStore;
  gitStore: TGitStore;
  saveDocument: (documentId?: string) => Promise<boolean>;
  saveDirtyDocuments: (documentIds: string[]) => Promise<boolean>;
  flushSession?: () => Promise<void>;
};

const CLOSE_FLUSH_TIMEOUT_MS = 1000;

const resolveCloseConfirmMessage = (
  dirtyDocuments: IEditorDocument[],
  scene: TDirtyCloseScene,
): { title: string; message: string } => {
  const fileName = dirtyDocuments[0]?.name ?? '当前文件';

  if (scene === 'close-document') {
    return {
      title: '保存更改？',
      message: `文件“${fileName}”的未保存修改将会丢失。`,
    };
  }

  if (scene === 'close-workspace') {
    return dirtyDocuments.length === 1
      ? {
          title: '保存更改？',
          message: `关闭工作区前，文件“${fileName}”的未保存修改将会丢失。`,
        }
      : {
          title: '保存更改？',
          message: `关闭工作区前，${dirtyDocuments.length} 个文件的未保存修改将会丢失。`,
        };
  }

  if (scene === 'switch-workspace') {
    return dirtyDocuments.length === 1
      ? {
          title: '保存更改？',
          message: `切换工作区前，文件“${fileName}”的未保存修改将会丢失。`,
        }
      : {
          title: '保存更改？',
          message: `切换工作区前，${dirtyDocuments.length} 个文件的未保存修改将会丢失。`,
        };
  }

  if (dirtyDocuments.length === 1) {
    return {
      title: '保存更改？',
      message: `关闭应用前，文件“${fileName}”的未保存修改将会丢失。`,
    };
  }

  return {
    title: '保存更改？',
    message: `关闭应用前，${dirtyDocuments.length} 个文件的未保存修改将会丢失。`,
  };
};

export const useDocumentLifecycle = ({
  editorStore,
  gitStore,
  saveDocument,
  saveDirtyDocuments,
  flushSession,
}: TUseDocumentLifecycleOptions) => {
  const notifier = useMessage();

  const flushSessionWithTimeout = async (): Promise<void> => {
    if (!flushSession) {
      return;
    }

    try {
      await Promise.race([
        flushSession(),
        new Promise<void>((resolve) => {
          window.setTimeout(() => resolve(), CLOSE_FLUSH_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      editorStore.appendLog('error', '会话落盘失败', String(error));
    }
  };

  const getAppWindow = async () => {
    const runtimeReady = await waitForDesktopRuntime();
    if (!runtimeReady) {
      return null;
    }

    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow();
  };

  const closeAppWindow = async (): Promise<void> => {
    const appWindow = await getAppWindow();
    if (!appWindow) {
      return;
    }

    allowNextProgrammaticWindowClose();

    try {
      await appWindow.close();
    } catch (error) {
      clearProgrammaticWindowCloseAllowance();
      throw error;
    }
  };

  const confirmCloseForDirtyDocuments = async (
    dirtyDocuments: IEditorDocument[],
    scene: TDirtyCloseScene,
  ): Promise<TDirtyCloseAction> => {
    if (dirtyDocuments.length === 0) {
      return 'discard';
    }

    const { title, message } = resolveCloseConfirmMessage(dirtyDocuments, scene);

    const action = await useDialog().confirm({
      title,
      description: message,
      confirmText: '保存',
      cancelText: '不保存',
      dismissText: '取消',
      variant: 'warning',
    });

    if (action === 'confirm') {
      return 'save';
    }

    if (action === 'cancel') {
      return 'discard';
    }

    return 'cancel';
  };

  const persistDirtyDocuments = async (dirtyDocuments: IEditorDocument[]): Promise<boolean> => {
    if (dirtyDocuments.length === 0) {
      return true;
    }

    if (dirtyDocuments.length === 1) {
      const targetDocument = dirtyDocuments[0];
      if (!targetDocument) {
        return true;
      }

      return saveDocument(targetDocument.id);
    }

    return saveDirtyDocuments(dirtyDocuments.map((item) => item.id));
  };

  const ensureDirtyDocumentsHandled = async (
    dirtyDocuments: IEditorDocument[],
    scene: TDirtyCloseScene,
  ): Promise<boolean> => {
    const action = await confirmCloseForDirtyDocuments(dirtyDocuments, scene);
    if (action === 'cancel') {
      return false;
    }

    if (action !== 'save') {
      // 用户选择“不保存”：连同未保存草稿一并清除，避免下次启动又被草稿恢复回来。
      dirtyDocuments.forEach((targetDocument) => {
        if (targetDocument.path) {
          editorStore.clearDocumentDraft(targetDocument.path);
        }
      });
      return true;
    }

    return persistDirtyDocuments(dirtyDocuments);
  };

  const requestCloseDocument = async (documentId: string): Promise<void> => {
    const targetDocument = editorStore.getDocumentById(documentId);
    if (!targetDocument) {
      return;
    }

    const canCloseDocument = await ensureDirtyDocumentsHandled(
      targetDocument.isDirty ? [targetDocument] : [],
      'close-document',
    );
    if (!canCloseDocument) {
      return;
    }

    editorStore.closeDocument(documentId);
  };

  const requestCloseWorkspace = async (): Promise<void> => {
    const canCloseWorkspace = await ensureDirtyDocumentsHandled(
      editorStore.dirtyDocuments,
      'close-workspace',
    );
    if (!canCloseWorkspace) {
      return;
    }

    editorStore.clearWorkspaceSession();
    gitStore.reset();
    notifier.success('工作区已关闭');
  };

  const requestCloseApplication = async (): Promise<void> => {
    const canCloseApplication = await ensureDirtyDocumentsHandled(
      editorStore.dirtyDocuments,
      'close-application',
    );
    if (!canCloseApplication) {
      return;
    }

    await flushSessionWithTimeout();
    await closeAppWindow();
  };

  return {
    ensureDirtyDocumentsHandled,
    requestCloseDocument,
    requestCloseWorkspace,
    requestCloseApplication,
  };
};
