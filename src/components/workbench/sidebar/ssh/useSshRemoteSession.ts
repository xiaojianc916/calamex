import { useEventListener } from '@vueuse/core';
import { storeToRefs } from 'pinia';
import { computed, nextTick, reactive, ref } from 'vue';
import type { ILinearContextMenuItem } from '@/components/common/linear-context-menu.types';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import { useSshStore } from '@/store/ssh';
import type {
  ISshFileItem,
  ISshPathSegment,
  ISshTransferItem,
  TSshTransferDirection,
} from '@/types/ssh';
import type { SshConnectionPayload } from '@/types/ssh/connection.schema';
import type { ISshFileReadPayload, ISshFileWriteRequest } from '@/types/tauri';
import {
  CONTEXT_MENU_HEIGHT,
  CONTEXT_MENU_WIDTH,
  FALLBACK_SELECTED_FILE,
  SSH_BREADCRUMB_COLLAPSE_THRESHOLD,
  SSH_BREADCRUMB_TAIL_COUNT,
} from './ssh-sidebar.constants';
import type { TSshBreadcrumbItem } from './ssh-sidebar.types';
import { buildRemotePathSegments, formatRemoteFileSize, resolveFileKind } from './ssh-sidebar-text';

interface IUseSshRemoteSessionOptions {
  createSshDirectoryRequest: (path: string) => SshConnectionPayload & { path: string };
  createSshFileTransferRequest: (
    remotePath: string,
    localPath: string,
  ) => SshConnectionPayload & { remotePath: string; localPath: string };
  createSshFileUploadRequest: (
    localPath: string,
    remoteDirectory: string,
  ) => SshConnectionPayload & { localPath: string; remoteDirectory: string };
  createSshPathDeleteRequest: (remotePath: string) => SshConnectionPayload & { remotePath: string };
  createSshPathRenameRequest: (
    remotePath: string,
    newName: string,
  ) => SshConnectionPayload & { remotePath: string; newName: string };
  createSshDirectoryCreateRequest: (
    remoteDirectory: string,
    name: string,
  ) => SshConnectionPayload & { remoteDirectory: string; name: string };
  createSshFileReadRequest: (remotePath: string) => SshConnectionPayload & { remotePath: string };
  createSshFileWriteRequest: (
    remotePath: string,
    content: string,
    encoding: ISshFileWriteRequest['encoding'],
    lineEnding: ISshFileWriteRequest['lineEnding'],
  ) => SshConnectionPayload & {
    remotePath: string;
    content: string;
    encoding: ISshFileWriteRequest['encoding'];
    lineEnding: ISshFileWriteRequest['lineEnding'];
  };
}

export const useSshRemoteSession = (options: IUseSshRemoteSessionOptions) => {
  const {
    createSshDirectoryRequest,
    createSshFileTransferRequest,
    createSshFileUploadRequest,
    createSshPathDeleteRequest,
    createSshPathRenameRequest,
    createSshDirectoryCreateRequest,
    createSshFileReadRequest,
    createSshFileWriteRequest,
  } = options;

  const message = useMessage();
  const sshStore = useSshStore();
  const { isConnected, selectedFileId, sshFileItems, transferItems, currentRemotePath } =
    storeToRefs(sshStore);

  const renameInputRef = ref<HTMLInputElement | null>(null);
  const createDirectoryInputRef = ref<HTMLInputElement | null>(null);
  const isRemoteDirectoryLoading = ref(false);
  const isUploading = ref(false);
  const isDownloading = ref(false);
  const isPathMutating = ref(false);
  const pendingRenameItem = ref<ISshFileItem | null>(null);
  const pendingDeleteItem = ref<ISshFileItem | null>(null);
  const previewFileItem = ref<ISshFileItem | null>(null);
  const previewPayload = ref<ISshFileReadPayload | null>(null);
  const isPreviewLoading = ref(false);
  const isPreviewSaving = ref(false);
  const isCreateDirectoryDialogOpen = ref(false);
  const renameInputValue = ref('');
  const createDirectoryName = ref('');
  const remoteDirectoryRequestVersion = ref(0);
  const previewRequestVersion = ref(0);
  const contextMenu = reactive({ open: false, x: 0, y: 0 });

  const selectedFile = computed<ISshFileItem>(
    () =>
      sshFileItems.value.find((item) => item.id === selectedFileId.value) ?? FALLBACK_SELECTED_FILE,
  );
  const sshPathSegments = computed<ISshPathSegment[]>(() =>
    buildRemotePathSegments(currentRemotePath.value),
  );
  const sshBreadcrumbItems = computed<TSshBreadcrumbItem[]>(() => {
    const segments = sshPathSegments.value;
    if (segments.length <= SSH_BREADCRUMB_COLLAPSE_THRESHOLD) {
      return segments.map((segment) => ({ ...segment, type: 'segment' as const }));
    }

    return [
      { ...segments[0], type: 'segment' as const },
      {
        id: 'ssh-path-ellipsis',
        type: 'ellipsis',
        segments: segments.slice(1, -SSH_BREADCRUMB_TAIL_COUNT),
      },
      ...segments
        .slice(-SSH_BREADCRUMB_TAIL_COUNT)
        .map((segment) => ({ ...segment, type: 'segment' as const })),
    ];
  });
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

  const closeContextMenu = (): void => {
    contextMenu.open = false;
  };

  const createTransferItem = (
    direction: TSshTransferDirection,
    name: string,
    progressLabel: string,
  ): ISshTransferItem => ({
    id: `${direction}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    direction,
    sizeLabel: '\u2014',
    progressLabel,
    progress: 0,
    status: direction === 'upload' ? 'uploading' : 'downloading',
  });

  const updateTransferItem = (
    transferId: string,
    patch: Partial<Omit<ISshTransferItem, 'id'>>,
  ): void => {
    const target = transferItems.value.find((item) => item.id === transferId);
    if (!target) return;
    Object.assign(target, patch);
  };

  const loadRemoteDirectorySnapshot = async (path: string): Promise<void> => {
    const requestVersion = remoteDirectoryRequestVersion.value + 1;
    remoteDirectoryRequestVersion.value = requestVersion;
    isRemoteDirectoryLoading.value = true;

    try {
      const result = await tauriService.listSshDirectory(createSshDirectoryRequest(path));
      if (requestVersion !== remoteDirectoryRequestVersion.value) return;

      currentRemotePath.value = result.path;
      sshFileItems.value = result.entries.map((entry) => {
        const isDirectory = entry.kind === 'directory';
        return {
          id: entry.path,
          name: entry.name,
          kind: resolveFileKind(entry.name, isDirectory),
          metaLabel: isDirectory ? '\u76ee\u5f55' : formatRemoteFileSize(entry.size),
          path: entry.path,
          isDirectory,
        };
      });
      selectedFileId.value = sshFileItems.value[0]?.id ?? '';
    } catch (error) {
      if (requestVersion !== remoteDirectoryRequestVersion.value) return;
      throw error;
    } finally {
      if (requestVersion === remoteDirectoryRequestVersion.value) {
        isRemoteDirectoryLoading.value = false;
      }
    }
  };

  const loadRemoteDirectory = async (path: string): Promise<void> => {
    try {
      await loadRemoteDirectorySnapshot(path);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : '\u8bfb\u53d6\u8fdc\u7aef\u76ee\u5f55\u5931\u8d25\u3002';
      message.error(errorMessage);
    }
  };

  const downloadRemoteFile = async (fileItem: ISshFileItem): Promise<void> => {
    if (!isConnected.value || isDownloading.value) return;
    if (fileItem.isDirectory) {
      message.info(
        '\u6682\u4e0d\u652f\u6301\u4e0b\u8f7d\u76ee\u5f55\uff0c\u8bf7\u9009\u62e9\u4e00\u4e2a\u6587\u4ef6\u3002',
      );
      return;
    }

    const savePath = await tauriService.pickAnySavePath(fileItem.name);
    if (!savePath) return;

    const transferItem = createTransferItem('download', fileItem.name, '\u4e0b\u8f7d\u4e2d\u2026');
    transferItems.value.unshift(transferItem);
    isDownloading.value = true;

    try {
      const result = await tauriService.downloadSshFile(
        createSshFileTransferRequest(fileItem.path, savePath),
      );
      updateTransferItem(transferItem.id, {
        sizeLabel: formatRemoteFileSize(result.byteSize),
        progressLabel: '\u5df2\u5b8c\u6210',
        progress: 100,
        status: 'done',
      });
      message.success(
        `\u5df2\u4e0b\u8f7d ${fileItem.name}\uff0c\u5171 ${formatRemoteFileSize(result.byteSize)}\u3002`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : '\u4e0b\u8f7d\u8fdc\u7aef\u6587\u4ef6\u5931\u8d25\u3002';
      updateTransferItem(transferItem.id, {
        progressLabel: errorMessage,
        progress: 100,
        status: 'failed',
      });
      message.error(errorMessage);
    } finally {
      isDownloading.value = false;
    }
  };

  const downloadSelectedFile = async (): Promise<void> => {
    await downloadRemoteFile(selectedFile.value);
  };

  const uploadFileToCurrentDirectory = async (): Promise<void> => {
    if (!isConnected.value || isUploading.value) return;
    const localPath = await tauriService.pickAnyOpenPath();
    if (!localPath) return;

    const selectedItem = sshFileItems.value.find((item) => item.id === selectedFileId.value);
    const remoteDirectory = selectedItem?.isDirectory ? selectedItem.path : currentRemotePath.value;
    const transferItem = createTransferItem(
      'upload',
      localPath.split(/[\\/]/).pop() ?? localPath,
      '\u4e0a\u4f20\u4e2d\u2026',
    );
    transferItems.value.unshift(transferItem);
    isUploading.value = true;

    const directoryAtStart = currentRemotePath.value;

    try {
      const result = await tauriService.uploadSshFile(
        createSshFileUploadRequest(localPath, remoteDirectory),
      );
      if (isConnected.value && currentRemotePath.value === directoryAtStart) {
        await loadRemoteDirectory(directoryAtStart);
      }
      updateTransferItem(transferItem.id, {
        sizeLabel: formatRemoteFileSize(result.byteSize),
        progressLabel: '\u5df2\u5b8c\u6210',
        progress: 100,
        status: 'done',
      });
      message.success(
        `\u5df2\u4e0a\u4f20\u5230 ${result.remotePath}\uff0c\u5171 ${formatRemoteFileSize(result.byteSize)}\u3002`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : '\u4e0a\u4f20\u672c\u5730\u6587\u4ef6\u5931\u8d25\u3002';
      updateTransferItem(transferItem.id, {
        progressLabel: errorMessage,
        progress: 100,
        status: 'failed',
      });
      message.error(errorMessage);
    } finally {
      isUploading.value = false;
    }
  };

  const copySelectedPath = async (): Promise<void> => {
    const fileItem = selectedFile.value;
    try {
      await navigator.clipboard.writeText(fileItem.path);
      message.success('\u5df2\u590d\u5236\u8fdc\u7aef\u8def\u5f84\u3002');
    } catch {
      message.error('\u590d\u5236\u8fdc\u7aef\u8def\u5f84\u5931\u8d25\u3002');
    }
  };

  const closePreviewDialog = (): void => {
    if (isPreviewLoading.value || isPreviewSaving.value) return;
    previewFileItem.value = null;
    previewPayload.value = null;
  };

  const previewRemoteFile = async (
    fileItem: ISshFileItem,
    options: { preservePayload?: boolean } = {},
  ): Promise<void> => {
    if (isPreviewLoading.value) return;

    const requestVersion = previewRequestVersion.value + 1;
    previewRequestVersion.value = requestVersion;

    previewFileItem.value = fileItem;
    if (!options.preservePayload) {
      previewPayload.value = null;
    }

    isPreviewLoading.value = true;
    try {
      const result = await tauriService.readSshFile(createSshFileReadRequest(fileItem.path));
      if (requestVersion !== previewRequestVersion.value) return;
      if (previewFileItem.value?.path !== fileItem.path) return;
      previewPayload.value = result;
    } catch (error) {
      if (requestVersion !== previewRequestVersion.value) return;
      const errorMessage =
        error instanceof Error
          ? error.message
          : '\u8bfb\u53d6\u8fdc\u7aef\u6587\u4ef6\u5931\u8d25\u3002';
      message.error(errorMessage);
      previewFileItem.value = null;
      previewPayload.value = null;
    } finally {
      if (requestVersion === previewRequestVersion.value) {
        isPreviewLoading.value = false;
      }
    }
  };

  const reloadPreviewFile = async (): Promise<void> => {
    const fileItem = previewFileItem.value;
    if (!fileItem) return;
    await previewRemoteFile(fileItem, { preservePayload: true });
  };

  const downloadPreviewFile = async (): Promise<void> => {
    const fileItem = previewFileItem.value;
    if (!fileItem) return;
    await downloadRemoteFile(fileItem);
  };

  const savePreviewFile = async (content: string): Promise<void> => {
    const fileItem = previewFileItem.value;
    const currentPreviewPayload = previewPayload.value;
    if (!fileItem || !currentPreviewPayload || isPreviewSaving.value) return;

    isPreviewSaving.value = true;
    try {
      const result = await tauriService.writeSshFile(
        createSshFileWriteRequest(
          fileItem.path,
          content,
          currentPreviewPayload.encoding as ISshFileWriteRequest['encoding'],
          currentPreviewPayload.lineEnding as ISshFileWriteRequest['lineEnding'],
        ),
      );
      message.success(
        `\u5df2\u4fdd\u5b58 ${fileItem.name}\uff0c\u5171 ${formatRemoteFileSize(result.byteSize)}\u3002`,
      );
      await previewRemoteFile(fileItem, { preservePayload: true });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : '\u4fdd\u5b58\u8fdc\u7aef\u6587\u4ef6\u5931\u8d25\u3002';
      message.error(errorMessage);
    } finally {
      isPreviewSaving.value = false;
    }
  };

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

  const focusRenameInput = async (): Promise<void> => {
    await nextTick();
    renameInputRef.value?.focus();
    renameInputRef.value?.select();
  };

  const focusCreateDirectoryInput = async (): Promise<void> => {
    await nextTick();
    createDirectoryInputRef.value?.focus();
  };

  const renameSelectedPath = async (): Promise<void> => {
    const fileItem = selectedFile.value;
    pendingRenameItem.value = fileItem;
    renameInputValue.value = fileItem.name;
    await focusRenameInput();
  };

  const openCreateDirectoryDialog = async (): Promise<void> => {
    if (!isConnected.value || isPathMutating.value) return;
    createDirectoryName.value = '';
    isCreateDirectoryDialogOpen.value = true;
    await focusCreateDirectoryInput();
  };

  const confirmRenamePath = async (): Promise<void> => {
    const fileItem = pendingRenameItem.value;
    const newName = normalizedRenameInput.value;
    if (!fileItem || !newName || newName === fileItem.name) {
      resetRenameDialog(true);
      return;
    }
    if (!canConfirmRename.value) {
      message.error(
        '\u65b0\u540d\u79f0\u4e0d\u80fd\u5305\u542b\u8def\u5f84\u5206\u9694\u7b26\u3002',
      );
      return;
    }

    const directoryAtStart = currentRemotePath.value;

    isPathMutating.value = true;
    try {
      await tauriService.renameSshPath(createSshPathRenameRequest(fileItem.path, newName));
      closeRenameDialog();
      if (isConnected.value && currentRemotePath.value === directoryAtStart) {
        await loadRemoteDirectory(directoryAtStart);
      }
      message.success('\u8fdc\u7aef\u8def\u5f84\u5df2\u91cd\u547d\u540d\u3002');
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : '\u91cd\u547d\u540d\u8fdc\u7aef\u8def\u5f84\u5931\u8d25\u3002';
      message.error(errorMessage);
    } finally {
      isPathMutating.value = false;
    }
  };

  const deleteSelectedPath = (): void => {
    pendingDeleteItem.value = selectedFile.value;
  };

  const confirmCreateDirectory = async (): Promise<void> => {
    const directoryName = normalizedCreateDirectoryName.value;
    if (!canConfirmCreateDirectory.value) {
      message.error(
        '\u76ee\u5f55\u540d\u79f0\u4e0d\u80fd\u4e3a\u7a7a\uff0c\u4e14\u4e0d\u80fd\u5305\u542b\u8def\u5f84\u5206\u9694\u7b26\u3002',
      );
      return;
    }

    const directoryAtStart = currentRemotePath.value;

    isPathMutating.value = true;
    try {
      const result = await tauriService.createSshDirectory(
        createSshDirectoryCreateRequest(directoryAtStart, directoryName),
      );
      resetCreateDirectoryDialog(true);
      if (isConnected.value && currentRemotePath.value === directoryAtStart) {
        await loadRemoteDirectory(directoryAtStart);
        selectedFileId.value = result.remotePath;
      }
      message.success('\u8fdc\u7aef\u76ee\u5f55\u5df2\u521b\u5efa\u3002');
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : '\u521b\u5efa\u8fdc\u7aef\u76ee\u5f55\u5931\u8d25\u3002';
      message.error(errorMessage);
    } finally {
      isPathMutating.value = false;
    }
  };

  const confirmDeletePath = async (): Promise<void> => {
    const fileItem = pendingDeleteItem.value;
    if (!fileItem) return;

    const directoryAtStart = currentRemotePath.value;

    isPathMutating.value = true;
    try {
      await tauriService.deleteSshPath(createSshPathDeleteRequest(fileItem.path));
      resetDeleteDialog(true);
      if (isConnected.value && currentRemotePath.value === directoryAtStart) {
        await loadRemoteDirectory(directoryAtStart);
      }
      message.success('\u8fdc\u7aef\u8def\u5f84\u5df2\u5220\u9664\u3002');
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : '\u5220\u9664\u8fdc\u7aef\u8def\u5f84\u5931\u8d25\u3002';
      message.error(errorMessage);
    } finally {
      isPathMutating.value = false;
    }
  };

  const handlePathSegmentClick = (segment: ISshPathSegment): void => {
    if (segment.path === currentRemotePath.value || isRemoteDirectoryLoading.value) return;
    void loadRemoteDirectory(segment.path);
  };

  const refreshCurrentRemoteDirectory = (): void => {
    if (!isConnected.value || isRemoteDirectoryLoading.value) return;
    void loadRemoteDirectory(currentRemotePath.value);
  };

  const handleSelectFile = (fileId: string): void => {
    selectedFileId.value = fileId;
    closeContextMenu();

    const fileItem = sshFileItems.value.find((item) => item.id === fileId);
    if (fileItem?.isDirectory && !isRemoteDirectoryLoading.value) {
      void loadRemoteDirectory(fileItem.path);
    }
  };

  const handleOpenFile = (fileId: string): void => {
    const fileItem = sshFileItems.value.find((item) => item.id === fileId);
    if (!fileItem) return;
    if (fileItem.isDirectory) {
      if (!isRemoteDirectoryLoading.value) {
        void loadRemoteDirectory(fileItem.path);
      }
      return;
    }
    void previewRemoteFile(fileItem);
  };

  const handleFileContextMenu = (event: MouseEvent, fileId: string): void => {
    selectedFileId.value = fileId;

    const maxX = Math.max(12, window.innerWidth - CONTEXT_MENU_WIDTH - 12);
    const maxY = Math.max(12, window.innerHeight - CONTEXT_MENU_HEIGHT - 12);

    contextMenu.x = Math.min(event.clientX, maxX);
    contextMenu.y = Math.min(event.clientY, maxY);
    contextMenu.open = true;
  };

  const handleContextMenuSelect = (action: ILinearContextMenuItem): void => {
    if (isPathMutating.value || isRemoteDirectoryLoading.value) {
      closeContextMenu();
      return;
    }

    const targetLabel = selectedFile.value.name;
    if (action.key === 'new-folder') {
      closeContextMenu();
      void openCreateDirectoryDialog();
      return;
    }
    if (action.key === 'download') {
      closeContextMenu();
      void downloadSelectedFile();
      return;
    }
    if (action.key === 'upload') {
      closeContextMenu();
      void uploadFileToCurrentDirectory();
      return;
    }
    if (action.key === 'copy-path') {
      closeContextMenu();
      void copySelectedPath();
      return;
    }
    if (action.key === 'rename') {
      closeContextMenu();
      void renameSelectedPath();
      return;
    }
    if (action.key === 'delete') {
      closeContextMenu();
      void deleteSelectedPath();
      return;
    }

    message.info(`${action.label}\u5f85\u63a5\u5165\uff1a${targetLabel}`);
    closeContextMenu();
  };

  const handleWindowClick = (event: MouseEvent): void => {
    const target = event.target;

    if (contextMenu.open) {
      if (target instanceof Element && target.closest('.linear-context-menu-root') !== null) {
        return;
      }
      closeContextMenu();
    }
  };

  const handleWindowContextMenu = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      closeContextMenu();
      return;
    }
    if (!target.closest('.ssh-file-item')) {
      closeContextMenu();
    }
  };

  const handleWindowKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      closeContextMenu();
      closeRenameDialog();
      closeDeleteDialog();
      closeCreateDirectoryDialog();
    }
  };

  const resetSessionState = (): void => {
    remoteDirectoryRequestVersion.value += 1;
    previewRequestVersion.value += 1;
    isRemoteDirectoryLoading.value = false;
    isPathMutating.value = false;
    isPreviewLoading.value = false;
    isPreviewSaving.value = false;
    resetRenameDialog(true);
    resetDeleteDialog(true);
    resetCreateDirectoryDialog(true);
    closePreviewDialog();
    closeContextMenu();
  };

  useEventListener(window, 'click', handleWindowClick);
  useEventListener(window, 'contextmenu', handleWindowContextMenu);
  useEventListener(window, 'keydown', handleWindowKeydown);

  return {
    isRemoteDirectoryLoading,
    isUploading,
    isDownloading,
    isPathMutating,
    selectedFile,
    sshBreadcrumbItems,
    previewFileItem,
    previewPayload,
    isPreviewLoading,
    isPreviewSaving,
    pendingRenameItem,
    pendingDeleteItem,
    isCreateDirectoryDialogOpen,
    renameInputValue,
    createDirectoryName,
    renameInputRef,
    createDirectoryInputRef,
    canConfirmRename,
    canConfirmCreateDirectory,
    contextMenu,
    closeContextMenu,
    loadRemoteDirectorySnapshot,
    loadRemoteDirectory,
    handlePathSegmentClick,
    refreshCurrentRemoteDirectory,
    handleSelectFile,
    handleOpenFile,
    handleFileContextMenu,
    handleContextMenuSelect,
    closePreviewDialog,
    reloadPreviewFile,
    downloadPreviewFile,
    savePreviewFile,
    closeRenameDialog,
    confirmRenamePath,
    closeDeleteDialog,
    confirmDeletePath,
    closeCreateDirectoryDialog,
    confirmCreateDirectory,
    resetSessionState,
  };
};
