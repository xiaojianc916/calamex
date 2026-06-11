import { computed, ref, type Ref } from 'vue';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import type { ISshFileItem, ISshPathSegment, TSshFileKind } from '@/types/ssh';
import type { SshConnectionPayload } from '@/types/ssh/connection.schema';

const SSH_BREADCRUMB_COLLAPSE_THRESHOLD = 4;
const SSH_BREADCRUMB_TAIL_COUNT = 2;

export type TSshBreadcrumbItem =
  | (ISshPathSegment & { type: 'segment' })
  | { id: 'ssh-path-ellipsis'; type: 'ellipsis'; segments: ISshPathSegment[] };

export const formatRemoteFileSize = (size: number): string => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

export const resolveFileKind = (name: string, isDirectory: boolean): TSshFileKind => {
  if (isDirectory) return 'folder';
  if (name.endsWith('.rs')) return 'rust';
  if (name.endsWith('.toml')) return 'toml';
  if (name.endsWith('.md')) return 'markdown';
  if (name.toLowerCase().endsWith('lock')) return 'lock';
  return 'file';
};

export const buildRemotePathSegments = (path: string): ISshPathSegment[] => {
  const normalizedPath = path.trim() || '.';
  if (normalizedPath === '.') {
    return [{ id: '.', label: '.', path: '.' }];
  }

  const segments: ISshPathSegment[] = [];
  const isAbsolutePath = normalizedPath.startsWith('/');
  const parts = normalizedPath.split('/').filter(Boolean);
  let cursor = '';

  if (isAbsolutePath) {
    segments.push({ id: '/', label: '/', path: '/' });
  }

  for (const part of parts) {
    cursor = cursor ? `${cursor}/${part}` : isAbsolutePath ? `/${part}` : part;
    segments.push({ id: cursor, label: part, path: cursor });
  }

  return segments.length > 0 ? segments : [{ id: '.', label: '.', path: '.' }];
};

export interface IUseSshRemoteDirectoryOptions {
  isConnected: Ref<boolean>;
  currentRemotePath: Ref<string>;
  sshFileItems: Ref<ISshFileItem[]>;
  selectedFileId: Ref<string>;
  getConnectionRequest: () => SshConnectionPayload;
}

export const useSshRemoteDirectory = (options: IUseSshRemoteDirectoryOptions) => {
  const { isConnected, currentRemotePath, sshFileItems, selectedFileId, getConnectionRequest } =
    options;
  const message = useMessage();
  const isRemoteDirectoryLoading = ref(false);
  const remoteDirectoryRequestVersion = ref(0);

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

  const loadRemoteDirectorySnapshot = async (path: string): Promise<void> => {
    const requestVersion = remoteDirectoryRequestVersion.value + 1;
    remoteDirectoryRequestVersion.value = requestVersion;
    isRemoteDirectoryLoading.value = true;

    try {
      const result = await tauriService.listSshDirectory({ ...getConnectionRequest(), path });
      if (requestVersion !== remoteDirectoryRequestVersion.value) return;
      currentRemotePath.value = result.path;
      sshFileItems.value = result.entries.map((entry) => {
        const isDirectory = entry.kind === 'directory';
        return {
          id: entry.path,
          name: entry.name,
          kind: resolveFileKind(entry.name, isDirectory),
          metaLabel: isDirectory ? '目录' : formatRemoteFileSize(entry.size),
          path: entry.path,
          isDirectory,
        };
      });
      selectedFileId.value = sshFileItems.value[0]?.id ?? '';
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
      const errorMessage = error instanceof Error ? error.message : '读取远端目录失败。';
      message.error(errorMessage);
    }
  };

  const refreshCurrentRemoteDirectory = (): void => {
    if (!isConnected.value || isRemoteDirectoryLoading.value) return;
    void loadRemoteDirectory(currentRemotePath.value);
  };

  const handlePathSegmentClick = (segment: ISshPathSegment): void => {
    if (segment.path === currentRemotePath.value || isRemoteDirectoryLoading.value) return;
    void loadRemoteDirectory(segment.path);
  };

  return {
    isRemoteDirectoryLoading,
    remoteDirectoryRequestVersion,
    sshPathSegments,
    sshBreadcrumbItems,
    loadRemoteDirectorySnapshot,
    loadRemoteDirectory,
    refreshCurrentRemoteDirectory,
    handlePathSegmentClick,
  };
};
