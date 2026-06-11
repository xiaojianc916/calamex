import { ref, type ComputedRef, type Ref } from 'vue';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import type { ISshFileItem, ISshTransferItem, TSshTransferDirection } from '@/types/ssh';
import type { SshConnectionPayload } from '@/types/ssh/connection.schema';
import { formatRemoteFileSize } from './useSshRemoteDirectory';

export interface IUseSshTransfersOptions {
  isConnected: Ref<boolean>;
  currentRemotePath: Ref<string>;
  sshFileItems: Ref<ISshFileItem[]>;
  selectedFileId: Ref<string>;
  selectedFile: ComputedRef<ISshFileItem>;
  transferItems: Ref<ISshTransferItem[]>;
  getConnectionRequest: () => SshConnectionPayload;
  loadRemoteDirectory: (path: string) => Promise<void>;
}

export const useSshTransfers = (options: IUseSshTransfersOptions) => {
  const {
    isConnected,
    currentRemotePath,
    sshFileItems,
    selectedFileId,
    selectedFile,
    transferItems,
    getConnectionRequest,
    loadRemoteDirectory,
  } = options;
  const message = useMessage();
  const isUploading = ref(false);
  const isDownloading = ref(false);

  const createTransferItem = (
    direction: TSshTransferDirection,
    name: string,
    progressLabel: string,
  ): ISshTransferItem => ({
    id: `${direction}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    direction,
    sizeLabel: '—',
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

  const downloadRemoteFile = async (fileItem: ISshFileItem): Promise<void> => {
    if (!isConnected.value || isDownloading.value) return;
    if (fileItem.isDirectory) {
      message.info('暂不支持下载目录，请选择一个文件。');
      return;
    }

    const savePath = await tauriService.pickAnySavePath(fileItem.name);
    if (!savePath) return;

    const transferItem = createTransferItem('download', fileItem.name, '下载中…');
    transferItems.value.unshift(transferItem);
    isDownloading.value = true;

    try {
      const result = await tauriService.downloadSshFile({
        ...getConnectionRequest(),
        remotePath: fileItem.path,
        localPath: savePath,
      });
      updateTransferItem(transferItem.id, {
        sizeLabel: formatRemoteFileSize(result.byteSize),
        progressLabel: '已完成',
        progress: 100,
        status: 'done',
      });
      message.success(`已下载 ${fileItem.name}，共 ${formatRemoteFileSize(result.byteSize)}。`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '下载远端文件失败。';
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
      '上传中…',
    );
    transferItems.value.unshift(transferItem);
    isUploading.value = true;

    try {
      const result = await tauriService.uploadSshFile({
        ...getConnectionRequest(),
        localPath,
        remoteDirectory,
      });
      await loadRemoteDirectory(currentRemotePath.value);
      updateTransferItem(transferItem.id, {
        sizeLabel: formatRemoteFileSize(result.byteSize),
        progressLabel: '已完成',
        progress: 100,
        status: 'done',
      });
      message.success(`已上传到 ${result.remotePath}，共 ${formatRemoteFileSize(result.byteSize)}。`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '上传本地文件失败。';
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

  return {
    isUploading,
    isDownloading,
    createTransferItem,
    updateTransferItem,
    downloadRemoteFile,
    downloadSelectedFile,
    uploadFileToCurrentDirectory,
  };
};
