import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import type { ISshFileItem } from '@/types/ssh';
import type { SshConnectionPayload } from '@/types/ssh/connection.schema';

export interface IUseSshPathMutationsOptions {
  isConnected: Ref<boolean>;
  currentRemotePath: Ref<string>;
  selectedFile: ComputedRef<ISshFileItem>;
  selectedFileId: Ref<string>;
  getConnectionRequest: () => SshConnectionPayload;
  loadRemoteDirectory: (path: string) => Promise<void>;
}

export const useSshPathMutations = (options: IUseSshPathMutationsOptions) => {
  const {
    isConnected,
    currentRemotePath,
    selectedFile,
    selectedFileId,
    getConnectionRequest,
    loadRemoteDirectory,
  } = options;
  const message = useMessage();

  const isPathMutating = ref(false);
  const pendingRenameItem = ref<ISshFileItem | null>(null);
  const pendingDeleteItem = ref<ISshFileItem | null>(null);
  const isCreateDirectoryDialogOpen = ref(false);
  const renameInputValue = ref('');
  const createDirectoryName = ref('');

  const normalizedRenameInput = computed(() => renameInputValue.value.trim());
  const normalizedCreateDirectoryName = computed(() => createDirectoryName.value.trim());

  const canConfirmRename = computed(() => {
    const item = pendingRenameItem.value;
    const nextName = normalizedRenameInput.value;
    return Boolean(
      item &&
        nextName &&
        nextName !== item.name &&
        !nextName.includes('/') &&
        !nextName.includes('\\'),
    );
  });

  const canConfirmCreateDirectory = computed(() => {
    const nextName = normalizedCreateDirectoryName.value;
    return Boolean(
      nextName &&
        nextName !== '.' &&
        nextName !== '..' &&
        !nextName.includes('/') &&
        !nextName.includes('\\'),
    );
  });

  const resetRenameDialog = (force = false): void => {
    if (isPathMutating.value && !force) return;
    pendingRenameItem.value = null;
    renameInputValue.value = '';
  };

  const closeRenameDialog = (): void => {
    resetRenameDialog(false);
  };

  const resetDeleteDialog = (force = false): void => {
    if (isPathMutating.value && !force) return;
    pendingDeleteItem.value = null;
  };

  const closeDeleteDialog = (): void => {
    resetDeleteDialog(false);
  };

  const resetCreateDirectoryDialog = (force = false): void => {
    if (isPathMutating.value && !force) return;
    isCreateDirectoryDialogOpen.value = false;
    createDirectoryName.value = '';
  };

  const closeCreateDirectoryDialog = (): void => {
    resetCreateDirectoryDialog(false);
  };

  const renameSelectedPath = (): void => {
    const fileItem = selectedFile.value;
    pendingRenameItem.value = fileItem;
    renameInputValue.value = fileItem.name;
  };

  const openCreateDirectoryDialog = (): void => {
    if (!isConnected.value || isPathMutating.value) return;
    createDirectoryName.value = '';
    isCreateDirectoryDialogOpen.value = true;
  };

  const deleteSelectedPath = (): void => {
    pendingDeleteItem.value = selectedFile.value;
  };

  const confirmRenamePath = async (): Promise<void> => {
    const fileItem = pendingRenameItem.value;
    const newName = normalizedRenameInput.value;
    if (!fileItem || !newName || newName === fileItem.name) {
      resetRenameDialog(true);
      return;
    }
    if (!canConfirmRename.value) {
      message.error('新名称不能包含路径分隔符。');
      return;
    }

    isPathMutating.value = true;
    try {
      await tauriService.renameSshPath({
        ...getConnectionRequest(),
        remotePath: fileItem.path,
        newName,
      });
      closeRenameDialog();
      await loadRemoteDirectory(currentRemotePath.value);
      message.success('远端路径已重命名。');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '重命名远端路径失败。';
      message.error(errorMessage);
    } finally {
      isPathMutating.value = false;
    }
  };

  const confirmCreateDirectory = async (): Promise<void> => {
    const directoryName = normalizedCreateDirectoryName.value;
    if (!canConfirmCreateDirectory.value) {
      message.error('目录名称不能为空，且不能包含路径分隔符。');
      return;
    }

    isPathMutating.value = true;
    try {
      const result = await tauriService.createSshDirectory({
        ...getConnectionRequest(),
        remoteDirectory: currentRemotePath.value,
        name: directoryName,
      });
      resetCreateDirectoryDialog(true);
      await loadRemoteDirectory(currentRemotePath.value);
      selectedFileId.value = result.remotePath;
      message.success('远端目录已创建。');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '创建远端目录失败。';
      message.error(errorMessage);
    } finally {
      isPathMutating.value = false;
    }
  };

  const confirmDeletePath = async (): Promise<void> => {
    const fileItem = pendingDeleteItem.value;
    if (!fileItem) return;

    isPathMutating.value = true;
    try {
      await tauriService.deleteSshPath({
        ...getConnectionRequest(),
        remotePath: fileItem.path,
      });
      resetDeleteDialog(true);
      await loadRemoteDirectory(currentRemotePath.value);
      message.success('远端路径已删除。');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '删除远端路径失败。';
      message.error(errorMessage);
    } finally {
      isPathMutating.value = false;
    }
  };

  return {
    isPathMutating,
    pendingRenameItem,
    pendingDeleteItem,
    isCreateDirectoryDialogOpen,
    renameInputValue,
    createDirectoryName,
    normalizedRenameInput,
    normalizedCreateDirectoryName,
    canConfirmRename,
    canConfirmCreateDirectory,
    closeRenameDialog,
    closeDeleteDialog,
    closeCreateDirectoryDialog,
    renameSelectedPath,
    openCreateDirectoryDialog,
    deleteSelectedPath,
    confirmRenamePath,
    confirmCreateDirectory,
    confirmDeletePath,
  };
};
