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
};

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
}: TUseDocumentLifecycleOptions) => {
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

  const requestCloseDocument = async (documentId: string): Promise<void> => {
    const targetDocument = editorStore.getDocumentById(documentId);
    if (!targetDocument) {
      return;
    }

    if (!targetDocument.isDirty) {
      editorStore.closeDocument(documentId);
      return;
    }

    const action = await confirmCloseForDirtyDocuments([targetDocument], 'close-document');
    if (action === 'cancel') {
      return;
    }

    if (action === 'save') {
      const saved = await saveDocument(documentId);
      if (!saved) {
        return;
      }
    }

    editorStore.closeDocument(documentId);
  };

  const requestCloseWorkspace = async (): Promise<void> => {
    const dirtyDocuments = editorStore.dirtyDocuments;
    const action = await confirmCloseForDirtyDocuments(dirtyDocuments, 'close-workspace');
    if (action === 'cancel') {
      return;
    }

    if (action === 'save') {
      const saved = await saveDirtyDocuments(dirtyDocuments.map((item) => item.id));
      if (!saved) {
        return;
      }
    }

    editorStore.clearWorkspaceSession();
    gitStore.reset();
    useMessage().success('工作区已关闭');
  };

  const requestCloseApplication = async (): Promise<void> => {
    const dirtyDocuments = editorStore.dirtyDocuments;
    if (dirtyDocuments.length === 0) {
      await closeAppWindow();
      return;
    }

    const action = await confirmCloseForDirtyDocuments(dirtyDocuments, 'close-application');
    if (action === 'cancel') {
      return;
    }

    if (action === 'save') {
      const saved = await saveDirtyDocuments(dirtyDocuments.map((item) => item.id));
      if (!saved) {
        return;
      }
    }

    await closeAppWindow();
  };

  return {
    confirmCloseForDirtyDocuments,
    requestCloseDocument,
    requestCloseWorkspace,
    requestCloseApplication,
  };
};