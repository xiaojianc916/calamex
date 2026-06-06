<script setup lang="ts">
import '@/assets/css/ssh-sidebar.css';
import { toTypedSchema } from '@vee-validate/zod';
import { storeToRefs } from 'pinia';
import { useForm } from 'vee-validate';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import FieldError from '@/components/common/FieldError.vue';
import LinearContextMenu from '@/components/common/LinearContextMenu.vue';
import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types';
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import DropdownMenu from '@/components/ui/dropdown-menu/DropdownMenu.vue';
import DropdownMenuContent from '@/components/ui/dropdown-menu/DropdownMenuContent.vue';
import DropdownMenuItem from '@/components/ui/dropdown-menu/DropdownMenuItem.vue';
import DropdownMenuTrigger from '@/components/ui/dropdown-menu/DropdownMenuTrigger.vue';
import { Field, FieldGroup, FieldLabel, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import SshFilePreviewDialog from '@/components/workbench/SshFilePreviewDialog.vue';
import { useIntegratedTerminalControls } from '@/composables/useIntegratedTerminal';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import { useSshStore } from '@/store/ssh';
import type {
  ISshAuthOption,
  ISshFileItem,
  ISshPathSegment,
  ISshRecentConnection,
  ISshTransferItem,
  TSshContentTab,
  TSshFileKind,
  TSshPanelTab,
  TSshTransferDirection,
} from '@/types/ssh';
import {
  type SshAuthMode,
  type SshConnectionFormValues,
  type SshConnectionPayload,
  sshConnectionSchema,
  toSshConnectionPayload,
} from '@/types/ssh/connection.schema';
import type { ISshFileReadPayload, ISshFileWriteRequest } from '@/types/tauri';

const CONTEXT_MENU_WIDTH = 172;
const CONTEXT_MENU_HEIGHT = 252;
const SSH_BREADCRUMB_COLLAPSE_THRESHOLD = 4;
const SSH_BREADCRUMB_TAIL_COUNT = 2;
const DEFAULT_SELECTED_FILE_ID = 'ssh-client';
const MANUAL_CONNECTION_ID = 'manual';
const DEFAULT_SSH_PORT = '22';
const TERMINAL_OPEN_DELAY_MS = 120;
const SSH_PASSWORD_SEND_DELAY_MS = 180;
const SSH_TERMINAL_HOST_KEY_POLICY = 'accept-new';

const SSH_CONTEXT_MENU_GROUPS: ILinearContextMenuGroup[] = [
  {
    key: 'file-actions',
    title: '',
    items: [
      { key: 'new-folder', label: '新建文件夹', icon: 'plus' },
      { key: 'rename', label: '重命名', icon: 'rename' },
      { key: 'copy-path', label: '复制路径', icon: 'copy' },
      { key: 'download', label: '下载到本地', icon: 'download' },
      { key: 'upload', label: '上传到此处', icon: 'upload' },
    ],
  },
  {
    key: 'danger-actions',
    title: '',
    items: [{ key: 'delete', label: '删除', icon: 'trash', variant: 'destructive' }],
  },
];

const SSH_AUTH_OPTIONS: ISshAuthOption[] = [
  { value: 'password', label: '密码认证' },
  { value: 'key', label: '密钥认证' },
];

type TSshBreadcrumbItem =
  | (ISshPathSegment & { type: 'segment' })
  | { id: 'ssh-path-ellipsis'; type: 'ellipsis'; segments: ISshPathSegment[] };

const FALLBACK_SELECTED_FILE: ISshFileItem = {
  id: DEFAULT_SELECTED_FILE_ID,
  name: 'ssh_client.rs',
  kind: 'rust',
  metaLabel: '8.7 KB',
  path: 'ssh_client.rs',
  isDirectory: false,
};

const emit = defineEmits<{
  'open-terminal': [];
}>();

const message = useMessage();
const terminalControls = useIntegratedTerminalControls();
const sshStore = useSshStore();
const {
  activeContentTab,
  isConnectFormVisible,
  isConnected,
  selectedFileId,
  normalizedRecentConnections,
  sshFileItems,
  transferItems,
  currentRemotePath,
} = storeToRefs(sshStore);

// ── 表单状态:useForm 取代 sshStore.connectionForm 作为 UI 表单源 ─────────────────
const isAuthMode = (value: unknown): value is SshAuthMode =>
  value === 'password' || value === 'key';

const buildInitialFormValues = (): SshConnectionFormValues => {
  const stored = sshStore.connectionForm;
  return {
    host: stored?.host ?? '',
    port: stored?.port ?? DEFAULT_SSH_PORT,
    username: stored?.username ?? '',
    authMode: isAuthMode(stored?.authMode) ? stored.authMode : 'password',
    identityPath: stored?.identityPath ?? '',
    password: stored?.password ?? '',
  };
};

const {
  values: connectionForm,
  errors: connectionFieldErrors,
  defineField,
  handleSubmit: handleVeeSubmit,
  resetForm,
  setFieldValue,
  validate: validateConnection,
} = useForm<SshConnectionFormValues>({
  validationSchema: toTypedSchema(sshConnectionSchema),
  initialValues: buildInitialFormValues(),
  validateOnMount: false,
});

const [host] = defineField('host');
const [port] = defineField('port');
const [username] = defineField('username');
const [authMode] = defineField('authMode');
const [identityPath] = defineField('identityPath');
const [password] = defineField('password');

/** 把表单当前值写回 Pinia store(用于 recent 持久化) */
const syncFormToStore = (): void => {
  sshStore.connectionForm.host = connectionForm.host;
  sshStore.connectionForm.port = connectionForm.port;
  sshStore.connectionForm.username = connectionForm.username;
  sshStore.connectionForm.authMode = connectionForm.authMode;
  sshStore.connectionForm.identityPath = connectionForm.identityPath;
  sshStore.connectionForm.password = connectionForm.password;
};

const renameInputRef = ref<HTMLInputElement | null>(null);
const createDirectoryInputRef = ref<HTMLInputElement | null>(null);
const isConnecting = ref(false);
const isPasswordVisible = ref(false);
const connectionStatusText = ref('');
const connectionErrorText = ref('');
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
const activeSshConnectionRequest = ref<SshConnectionPayload | null>(null);
const contextMenu = reactive({ open: false, x: 0, y: 0 });

const isExplorerActive = computed(() => activeContentTab.value === 'explorer');
const isTransferActive = computed(() => activeContentTab.value === 'transfer');
const isDisconnected = computed(() => !isConnected.value);
const selectedFile = computed<ISshFileItem>(
  () =>
    sshFileItems.value.find((item) => item.id === selectedFileId.value) ?? FALLBACK_SELECTED_FILE,
);
const sshCommandPreview = computed(() => buildSshCommand());
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
const passwordInputType = computed(() => (isPasswordVisible.value ? 'text' : 'password'));

const isTabActive = (tab: TSshPanelTab): boolean => {
  if (tab === 'connect') {
    return !isConnected.value || isConnectFormVisible.value;
  }
  return isConnected.value && !isConnectFormVisible.value && activeContentTab.value === tab;
};

const closeContextMenu = (): void => {
  contextMenu.open = false;
};

const handleAuthModeChange = (nextMode: unknown): void => {
  if (!isAuthMode(nextMode)) return;
  setFieldValue('authMode', nextMode);
  isPasswordVisible.value = false;
  connectionErrorText.value = '';
};

const setContentTab = (tab: TSshContentTab): void => {
  if (!isConnected.value) return;
  activeContentTab.value = tab;
  isConnectFormVisible.value = false;
  closeContextMenu();
};

const openConnectForm = (): void => {
  isConnectFormVisible.value = true;
  closeContextMenu();
};

const toggleConnectForm = (): void => {
  isConnectFormVisible.value = !isConnectFormVisible.value;
  if (isConnected.value && !isConnectFormVisible.value) {
    activeContentTab.value = 'explorer';
  }
  closeContextMenu();
};

const handleCancelConnect = (): void => {
  isConnectFormVisible.value = false;
  if (isConnected.value) {
    activeContentTab.value = 'explorer';
  }
};

const applyConnectionState = (connectionId: string | null): void => {
  sshStore.applyConnectionState(connectionId);
  activeContentTab.value = 'explorer';
  closeContextMenu();
};

const quoteShellArg = (value: string): string => {
  const normalizedValue = value.trim();
  if (/^[a-zA-Z0-9_@%+=:,./~-]+$/.test(normalizedValue)) {
    return normalizedValue;
  }
  return `'${normalizedValue.replace(/'/g, "'\\''")}'`;
};

const formatRemoteFileSize = (size: number): string => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

const resolveFileKind = (name: string, isDirectory: boolean): TSshFileKind => {
  if (isDirectory) return 'folder';
  if (name.endsWith('.rs')) return 'rust';
  if (name.endsWith('.toml')) return 'toml';
  if (name.endsWith('.md')) return 'markdown';
  if (name.toLowerCase().endsWith('lock')) return 'lock';
  return 'file';
};

const buildRemotePathSegments = (path: string): ISshPathSegment[] => {
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

const createSshConnectionTestRequest = (): SshConnectionPayload =>
  toSshConnectionPayload(connectionForm);

const createSshConnectionRequest = (): SshConnectionPayload =>
  activeSshConnectionRequest.value ?? createSshConnectionTestRequest();

const createSshDirectoryRequest = (path: string) => ({
  ...createSshConnectionRequest(),
  path,
});

const createSshFileTransferRequest = (remotePath: string, localPath: string) => ({
  ...createSshConnectionRequest(),
  remotePath,
  localPath,
});

const createSshFileUploadRequest = (localPath: string, remoteDirectory: string) => ({
  ...createSshConnectionRequest(),
  localPath,
  remoteDirectory,
});

const createSshPathDeleteRequest = (remotePath: string) => ({
  ...createSshConnectionRequest(),
  remotePath,
});

const createSshPathRenameRequest = (remotePath: string, newName: string) => ({
  ...createSshConnectionRequest(),
  remotePath,
  newName,
});

const createSshDirectoryCreateRequest = (remoteDirectory: string, name: string) => ({
  ...createSshConnectionRequest(),
  remoteDirectory,
  name,
});

const createSshFileReadRequest = (remotePath: string) => ({
  ...createSshConnectionRequest(),
  remotePath,
});

const createSshFileWriteRequest = (
  remotePath: string,
  content: string,
  encoding: ISshFileWriteRequest['encoding'],
  lineEnding: ISshFileWriteRequest['lineEnding'],
) => ({
  ...createSshConnectionRequest(),
  remotePath,
  content,
  encoding,
  lineEnding,
});

const createSshPasswordIdentityRequest = () => ({
  host: connectionForm.host.trim(),
  port: Number.parseInt(connectionForm.port.trim(), 10),
  username: connectionForm.username.trim(),
});

const saveCurrentSshPassword = async (): Promise<void> => {
  if (connectionForm.authMode !== 'password') return;
  await tauriService.saveSshPassword({
    ...createSshPasswordIdentityRequest(),
    password: connectionForm.password,
  });
};

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
    const result = await tauriService.downloadSshFile(
      createSshFileTransferRequest(fileItem.path, savePath),
    );
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
    const result = await tauriService.uploadSshFile(
      createSshFileUploadRequest(localPath, remoteDirectory),
    );
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

const copySelectedPath = async (): Promise<void> => {
  const fileItem = selectedFile.value;
  try {
    await navigator.clipboard.writeText(fileItem.path);
    message.success('已复制远端路径。');
  } catch {
    message.error('复制远端路径失败。');
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
  previewFileItem.value = fileItem;
  if (!options.preservePayload) {
    previewPayload.value = null;
  }
  isPreviewLoading.value = true;
  try {
    const result = await tauriService.readSshFile(createSshFileReadRequest(fileItem.path));
    previewPayload.value = result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '读取远端文件失败。';
    message.error(errorMessage);
    previewFileItem.value = null;
    previewPayload.value = null;
  } finally {
    isPreviewLoading.value = false;
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
    message.success(`已保存 ${fileItem.name}，共 ${formatRemoteFileSize(result.byteSize)}。`);
    await previewRemoteFile(fileItem, { preservePayload: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '保存远端文件失败。';
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
    message.error('新名称不能包含路径分隔符。');
    return;
  }

  isPathMutating.value = true;
  try {
    await tauriService.renameSshPath(createSshPathRenameRequest(fileItem.path, newName));
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

const deleteSelectedPath = (): void => {
  pendingDeleteItem.value = selectedFile.value;
};

const confirmCreateDirectory = async (): Promise<void> => {
  const directoryName = normalizedCreateDirectoryName.value;
  if (!canConfirmCreateDirectory.value) {
    message.error('目录名称不能为空，且不能包含路径分隔符。');
    return;
  }

  isPathMutating.value = true;
  try {
    const result = await tauriService.createSshDirectory(
      createSshDirectoryCreateRequest(currentRemotePath.value, directoryName),
    );
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
    await tauriService.deleteSshPath(createSshPathDeleteRequest(fileItem.path));
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

const buildSshCommand = (): string => {
  const hostText = connectionForm.host.trim();
  const usernameText = connectionForm.username.trim();
  const portText = connectionForm.port.trim() || DEFAULT_SSH_PORT;
  const parts = ['ssh', '-p', quoteShellArg(portText)];
  parts.push('-o', `StrictHostKeyChecking=${SSH_TERMINAL_HOST_KEY_POLICY}`);

  if (connectionForm.authMode === 'key' && connectionForm.identityPath.trim()) {
    parts.push('-i', quoteShellArg(connectionForm.identityPath));
  }

  if (connectionForm.authMode === 'password') {
    parts.push(
      '-o',
      'PreferredAuthentications=password',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'NumberOfPasswordPrompts=1',
    );
  }

  if (usernameText && hostText) {
    parts.push(`${usernameText}@${hostText}`);
  }

  return parts.join(' ');
};

const openTerminalSessionBestEffort = async (): Promise<void> => {
  try {
    emit('open-terminal');
    await new Promise((resolve) => window.setTimeout(resolve, TERMINAL_OPEN_DELAY_MS));
    await terminalControls.sendCommand(sshCommandPreview.value);
    if (connectionForm.authMode === 'password' && connectionForm.password) {
      await new Promise((resolve) => window.setTimeout(resolve, SSH_PASSWORD_SEND_DELAY_MS));
      await terminalControls.sendInput(`${connectionForm.password}\n`);
    }
  } catch {
    message.info('文件连接已建立，终端会话暂未打开。');
  }
};

const handleConnect = async (connectionId = MANUAL_CONNECTION_ID): Promise<void> => {
  connectionErrorText.value = '';
  connectionStatusText.value = '';

  const validation = await validateConnection();
  if (!validation.valid) return;

  isConnecting.value = true;
  connectionStatusText.value = '正在验证 SSH 连接…';

  try {
    const connectionRequest = createSshConnectionTestRequest();
    const testResult = await tauriService.testSshConnection(connectionRequest);

    if (!testResult.ok) {
      connectionErrorText.value = testResult.message;
      message.error(testResult.message);
      return;
    }

    connectionStatusText.value = '正在读取远端目录…';
    activeSshConnectionRequest.value = connectionRequest;
    await loadRemoteDirectorySnapshot('.');
    try {
      await saveCurrentSshPassword();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '保存 SSH 密码失败。';
      message.error(`连接已成功，但保存密码失败：${errorMessage}`);
    }
    syncFormToStore();
    const rememberedConnectionId = sshStore.rememberCurrentConnection(connectionId);
    applyConnectionState(rememberedConnectionId);
    message.success('SSH 连接验证成功，已打开远端会话。');
    void openTerminalSessionBestEffort();
  } catch (error) {
    activeSshConnectionRequest.value = null;
    const errorMessage = error instanceof Error ? error.message : 'SSH 连接失败。';
    connectionErrorText.value = errorMessage;
    message.error(errorMessage);
  } finally {
    isConnecting.value = false;
    connectionStatusText.value = '';
  }
};

const handleConnectSubmit = handleVeeSubmit(async () => {
  if (isConnecting.value) return;
  await handleConnect();
});

const handleSelectRecentConnection = async (connection: ISshRecentConnection): Promise<void> => {
  sshStore.setConnectionFormFromProfile(connection);
  const stored = sshStore.connectionForm;
  resetForm({
    values: {
      host: stored.host ?? '',
      port: stored.port ?? DEFAULT_SSH_PORT,
      username: stored.username ?? '',
      authMode: isAuthMode(stored.authMode) ? stored.authMode : 'password',
      identityPath: stored.identityPath ?? '',
      password: '',
    },
  });

  if (connection.authMode === 'password') {
    try {
      const savedCredential = await tauriService.getSshPassword(createSshPasswordIdentityRequest());
      setFieldValue('password', savedCredential.password);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未找到已保存的 SSH 密码。';
      isConnectFormVisible.value = true;
      message.info(errorMessage);
      return;
    }
    await handleConnect(connection.id);
    return;
  }

  await handleConnect(connection.id);
};

const handlePathSegmentClick = (segment: ISshPathSegment): void => {
  if (segment.path === currentRemotePath.value || isRemoteDirectoryLoading.value) return;
  void loadRemoteDirectory(segment.path);
};

const refreshCurrentRemoteDirectory = (): void => {
  if (!isConnected.value || isRemoteDirectoryLoading.value) return;
  void loadRemoteDirectory(currentRemotePath.value);
};

const disconnectSshSession = (): void => {
  remoteDirectoryRequestVersion.value += 1;
  isRemoteDirectoryLoading.value = false;
  isPathMutating.value = false;
  isPreviewLoading.value = false;
  isPreviewSaving.value = false;
  activeSshConnectionRequest.value = null;
  resetRenameDialog(true);
  resetDeleteDialog(true);
  resetCreateDirectoryDialog(true);
  closePreviewDialog();
  closeContextMenu();
  sshStore.clearConnectionState();
  resetForm();
  sshStore.connectionForm.password = '';
  message.info('已断开 SSH 文件会话。');
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

  message.info(`${action.label}待接入：${targetLabel}`);
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

onMounted(() => {
  window.addEventListener('click', handleWindowClick);
  window.addEventListener('contextmenu', handleWindowContextMenu);
  window.addEventListener('keydown', handleWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('click', handleWindowClick);
  window.removeEventListener('contextmenu', handleWindowContextMenu);
  window.removeEventListener('keydown', handleWindowKeydown);
});
</script>

<template>
  <section class="ssh-sidebar-panel" aria-label="SSH 连接侧边栏">
    <div class="ssh-tabs" :class="{ 'ssh-tabs--disconnected': isDisconnected }" role="tablist" aria-label="SSH 侧边栏分组">
      <button type="button" class="ssh-tab" :class="{
        'ssh-tab--disconnected': isDisconnected,
        'is-active': isTabActive('explorer'),
        'is-disabled': isDisconnected,
      }" role="tab" :aria-selected="isTabActive('explorer')" :aria-disabled="isDisconnected" :disabled="isDisconnected"
        title="连接后可用" @click="setContentTab('explorer')">
        文件
      </button>
      <button type="button" class="ssh-tab" :class="{
        'ssh-tab--disconnected': isDisconnected,
        'is-active': isTabActive('transfer'),
        'is-disabled': isDisconnected,
      }" role="tab" :aria-selected="isTabActive('transfer')" :aria-disabled="isDisconnected" :disabled="isDisconnected"
        title="连接后可用" @click="setContentTab('transfer')">
        传输
      </button>
      <button type="button" class="ssh-tab" :class="{
        'ssh-tab--disconnected': isDisconnected,
        'is-active': isTabActive('connect'),
      }" role="tab" :aria-selected="isTabActive('connect')" @click="toggleConnectForm">
        连接
      </button>
    </div>

    <div class="ssh-panel-body" :class="isDisconnected ? 'ssh-panel-body--disconnected' : 'ssh-panel-body--connected'">
      <form v-if="isConnectFormVisible" class="ssh-connect-form"
        :class="{ 'ssh-connect-form--disconnected': isDisconnected }" @submit.prevent="handleConnectSubmit">
        <FieldSet class="ssh-connect-fieldset">
          <FieldGroup class="ssh-connect-fields">
            <div class="ssh-connect-grid">
              <Field class="ssh-connect-field">
                <FieldLabel for="ssh-connect-host" class="ssh-connect-label">
                  主机地址
                </FieldLabel>
                <Input id="ssh-connect-host" v-model="host" type="text" placeholder="192.168.217.129" autocomplete="off"
                  class="ssh-connect-input" :aria-invalid="Boolean(connectionFieldErrors.host)" />
                <FieldError v-if="connectionFieldErrors.host" :message="connectionFieldErrors.host" />
              </Field>

              <Field class="ssh-connect-field ssh-connect-field--port">
                <FieldLabel for="ssh-connect-port" class="ssh-connect-label">
                  端口
                </FieldLabel>
                <Input id="ssh-connect-port" v-model="port" type="text" placeholder="22" inputmode="numeric"
                  autocomplete="off" class="ssh-connect-input" :aria-invalid="Boolean(connectionFieldErrors.port)" />
                <FieldError v-if="connectionFieldErrors.port" :message="connectionFieldErrors.port" />
              </Field>
            </div>

            <Field class="ssh-connect-field">
              <FieldLabel for="ssh-connect-username" class="ssh-connect-label">
                用户名
              </FieldLabel>
              <Input id="ssh-connect-username" v-model="username" type="text" placeholder="root" autocomplete="off"
                class="ssh-connect-input" :aria-invalid="Boolean(connectionFieldErrors.username)" />
              <FieldError v-if="connectionFieldErrors.username" :message="connectionFieldErrors.username" />
            </Field>

            <Field class="ssh-connect-field">
              <FieldLabel for="ssh-connect-auth-mode" class="ssh-connect-label">
                认证方式
              </FieldLabel>
              <Select :model-value="authMode" @update:model-value="handleAuthModeChange">
                <SelectTrigger id="ssh-connect-auth-mode" aria-label="选择 SSH 认证方式" class="ssh-connect-select-trigger">
                  <SelectValue placeholder="选择认证方式" />
                </SelectTrigger>
                <SelectContent
                  class="ssh-connect-select-content data-[state=open]:animate-none data-[state=closed]:animate-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 data-[side=bottom]:slide-in-from-top-0 data-[side=left]:slide-in-from-right-0 data-[side=right]:slide-in-from-left-0 data-[side=top]:slide-in-from-bottom-0">
                  <SelectItem v-for="option in SSH_AUTH_OPTIONS" :key="option.value" :value="option.value"
                    class="ssh-connect-select-item">
                    {{ option.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field v-if="authMode === 'key'" class="ssh-connect-field">
              <FieldLabel for="ssh-connect-identity-path" class="ssh-connect-label">
                私钥路径
              </FieldLabel>
              <Input id="ssh-connect-identity-path" v-model="identityPath" type="text" placeholder="~/.ssh/id_rsa"
                autocomplete="off" class="ssh-connect-input"
                :aria-invalid="Boolean(connectionFieldErrors.identityPath)" />
              <FieldError v-if="connectionFieldErrors.identityPath" :message="connectionFieldErrors.identityPath" />
            </Field>

            <Field v-else class="ssh-connect-field">
              <FieldLabel for="ssh-connect-password" class="ssh-connect-label">
                登录密码
              </FieldLabel>
              <div class="ssh-password-input-wrap">
                <Input id="ssh-connect-password" v-model="password" :type="passwordInputType" placeholder="输入 SSH 登录密码"
                  autocomplete="current-password" class="ssh-connect-input ssh-connect-input--password"
                  :aria-invalid="Boolean(connectionFieldErrors.password)" />
                <button type="button" class="ssh-password-toggle" :aria-label="isPasswordVisible ? '隐藏密码' : '显示密码'"
                  :title="isPasswordVisible ? '隐藏密码' : '显示密码'" @click="isPasswordVisible = !isPasswordVisible">
                  <span v-if="isPasswordVisible" aria-hidden="true" class="icon-[lucide--eye]" />
                  <span v-else aria-hidden="true" class="icon-[lucide--eye-off]" />
                </button>
              </div>
              <FieldError v-if="connectionFieldErrors.password" :message="connectionFieldErrors.password" />
            </Field>
          </FieldGroup>
        </FieldSet>

        <div class="ssh-form-actions">
          <Button type="submit" class="ssh-connect-action ssh-connect-action--submit" :disabled="isConnecting">
            {{ isConnecting ? '连接中…' : '连接' }}
          </Button>
          <Button type="button" variant="outline" class="ssh-connect-action ssh-connect-action--cancel"
            :disabled="isConnecting" @click="handleCancelConnect">
            取消
          </Button>
        </div>

        <div v-if="connectionStatusText || connectionErrorText" class="ssh-connect-feedback"
          :class="{ 'is-error': Boolean(connectionErrorText) }" aria-live="polite">
          {{ connectionErrorText || connectionStatusText }}
        </div>
      </form>

      <section v-else-if="isDisconnected" class="ssh-empty-state ssh-empty-state--disconnected" aria-label="SSH 未连接状态">
        <span class="icon-[lucide--server] ssh-empty-icon" aria-hidden="true" />

        <div class="ssh-empty-copy">
          <div class="ssh-empty-title ssh-empty-title--disconnected">尚未连接到远程主机</div>
          <div class="ssh-empty-desc ssh-empty-desc--disconnected">
            连接一台 SSH 服务器后，即可在此浏览文件、上传下载以及管理远程资源
          </div>
        </div>

        <div class="ssh-empty-actions ssh-empty-actions--disconnected">
          <button type="button"
            class="ssh-button ssh-button--primary ssh-button--stacked ssh-button--disconnected-primary"
            @click="openConnectForm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
              stroke-linejoin="round" aria-hidden="true">
              <path d="M5 12h14" />
              <path d="M12 5l7 7-7 7" />
            </svg>
            新建连接
          </button>
        </div>

        <section class="ssh-recent-section ssh-recent-section--disconnected" aria-label="最近使用 SSH 连接">
          <div class="ssh-recent-title ssh-recent-title--disconnected">最近使用</div>

          <div v-if="normalizedRecentConnections.length === 0" class="ssh-recent-empty">
            暂无真实连接记录，可新建连接。
          </div>

          <button v-for="connection in normalizedRecentConnections" :key="connection.id" type="button"
            class="ssh-recent-item ssh-recent-item--disconnected" @click="handleSelectRecentConnection(connection)">
            <span class="ssh-recent-icon ssh-recent-icon--disconnected" aria-hidden="true">
              <span class="icon-[lucide--clock-3]" />
            </span>

            <span class="ssh-recent-info">
              <span class="ssh-recent-name ssh-recent-name--disconnected">
                {{ connection.username }} @ {{ connection.host }}
              </span>
            </span>

            <span class="ssh-recent-time ssh-recent-time--disconnected">
              {{ connection.lastUsedLabel }}
            </span>
          </button>
        </section>
      </section>

      <template v-else>
        <div v-if="isExplorerActive" class="ssh-path-bar">
          <Breadcrumb class="ssh-path-breadcrumb" aria-label="远端路径">
            <BreadcrumbList class="ssh-path-list">
              <template v-for="(item, index) in sshBreadcrumbItems" :key="item.id">
                <BreadcrumbItem v-if="item.type === 'ellipsis'">
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <button type="button" class="ssh-path-ellipsis" :disabled="isRemoteDirectoryLoading"
                        aria-label="展开中间路径">
                        <BreadcrumbEllipsis class="ssh-path-ellipsis-icon" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" class="ssh-path-menu">
                      <DropdownMenuItem v-for="segment in item.segments" :key="segment.id" class="ssh-path-menu-item"
                        :disabled="isRemoteDirectoryLoading" @select="handlePathSegmentClick(segment)">
                        {{ segment.label }}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </BreadcrumbItem>
                <BreadcrumbItem v-else>
                  <BreadcrumbPage v-if="item.path === currentRemotePath" class="ssh-path-segment is-current">
                    {{ item.label }}
                  </BreadcrumbPage>
                  <BreadcrumbLink v-else as-child>
                    <button type="button" class="ssh-path-segment" :disabled="isRemoteDirectoryLoading"
                      @click="handlePathSegmentClick(item)">
                      {{ item.label }}
                    </button>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator v-if="index < sshBreadcrumbItems.length - 1" class="ssh-path-separator" />
              </template>
            </BreadcrumbList>
          </Breadcrumb>
          <div class="ssh-path-actions">
            <button type="button" class="ssh-path-action" aria-label="断开 SSH 连接" title="断开连接"
              @click="disconnectSshSession">
              <span aria-hidden="true" class="icon-[lucide--unplug]" />
            </button>
            <button type="button" class="ssh-path-action" :disabled="isRemoteDirectoryLoading" aria-label="刷新远端目录"
              title="刷新远端目录" @click="refreshCurrentRemoteDirectory">
              <span aria-hidden="true" class="icon-[lucide--refresh-cw]" />
            </button>
          </div>
        </div>

        <div v-if="isExplorerActive" class="ssh-file-list" role="list" aria-label="远端文件列表">
          <div v-if="isRemoteDirectoryLoading" class="ssh-file-list-state" aria-live="polite">
            正在读取远端目录…
          </div>
          <div v-else-if="sshFileItems.length === 0" class="ssh-file-list-state">
            当前目录为空
          </div>
          <template v-else>
            <button v-for="item in sshFileItems" :key="item.id" type="button" class="ssh-file-item" :class="{
              'is-folder': item.kind === 'folder',
              'is-selected': selectedFileId === item.id,
            }" :aria-label="`${item.name}，${item.metaLabel}`" @click="handleSelectFile(item.id)"
              @dblclick="handleOpenFile(item.id)" @contextmenu.prevent="handleFileContextMenu($event, item.id)">
              <span class="ssh-file-icon" :class="`is-${item.kind}`" aria-hidden="true">
                <svg v-if="item.kind === 'folder'" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" />
                </svg>
                <span v-else-if="item.kind === 'rust'">⚙</span>
                <svg v-else-if="item.kind === 'lock'" width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </span>

              <span class="ssh-file-name"> {{ item.name }} </span>
              <span class="ssh-file-meta">{{ item.metaLabel }}</span>
            </button>
          </template>
        </div>

        <div v-else-if="isTransferActive" class="ssh-transfer-panel" aria-label="传输任务列表">
          <div v-if="transferItems.length === 0" class="ssh-transfer-empty">
            暂无传输任务
          </div>
          <article v-for="item in transferItems" :key="item.id" class="ssh-transfer-item">
            <div class="ssh-transfer-header">
              <div class="ssh-transfer-name">
                <span class="ssh-transfer-direction" :class="`is-${item.direction}`">
                  {{ item.direction === 'upload' ? '↑ 上传' : '↓ 下载' }}
                </span>
                {{ item.name }}
              </div>
              <span class="ssh-transfer-meta">{{ item.sizeLabel }}</span>
            </div>

            <div class="ssh-progress-bar" aria-hidden="true">
              <div class="ssh-progress-fill" :class="`is-${item.status}`" :style="{ width: `${item.progress}%` }" />
            </div>

            <div class="ssh-transfer-footer">
              <span class="ssh-transfer-meta">{{ item.progressLabel }}</span>
              <span class="ssh-transfer-meta"
                :class="{ 'is-success': item.status === 'done', 'is-failed': item.status === 'failed' }">
                {{ item.status === 'done' ? '完成' : item.status === 'failed' ? '失败' : '进行中' }}
              </span>
            </div>
          </article>
        </div>
      </template>
    </div>
  </section>

  <LinearContextMenu :open="isConnected && contextMenu.open" :x="contextMenu.x" :y="contextMenu.y"
    :groups="SSH_CONTEXT_MENU_GROUPS" theme="dark" submenu-direction="right" @select="handleContextMenuSelect" />

  <SshFilePreviewDialog v-if="previewFileItem" :file-item="previewFileItem" :payload="previewPayload"
    :is-loading="isPreviewLoading" :is-saving="isPreviewSaving" @close="closePreviewDialog" @reload="reloadPreviewFile"
    @download="downloadPreviewFile" @save="savePreviewFile" />

  <Teleport to="body">
    <div v-if="isCreateDirectoryDialogOpen" class="ssh-modal-backdrop" @click.self="closeCreateDirectoryDialog">
      <form class="ssh-modal" @submit.prevent="confirmCreateDirectory">
        <div class="ssh-modal-copy">
          <h3>新建远端文件夹</h3>
          <p>将在“{{ currentRemotePath }}”下创建文件夹。不会覆盖远端已有项目。</p>
        </div>
        <label class="ssh-modal-field">
          <span>文件夹名称</span>
          <input ref="createDirectoryInputRef" v-model="createDirectoryName" :disabled="isPathMutating"
            autocomplete="off" />
        </label>
        <div class="ssh-modal-actions">
          <button type="button" class="ssh-modal-button" :disabled="isPathMutating" @click="closeCreateDirectoryDialog">
            取消
          </button>
          <button type="submit" class="ssh-modal-button is-primary"
            :disabled="!canConfirmCreateDirectory || isPathMutating">
            {{ isPathMutating ? '处理中…' : '创建' }}
          </button>
        </div>
      </form>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="pendingRenameItem" class="ssh-modal-backdrop" @click.self="closeRenameDialog">
      <form class="ssh-modal" @submit.prevent="confirmRenamePath">
        <div class="ssh-modal-copy">
          <h3>重命名远端项目</h3>
          <p>为“{{ pendingRenameItem.name }}”输入新的名称。不会覆盖远端已有项目。</p>
        </div>
        <label class="ssh-modal-field">
          <span>新名称</span>
          <input ref="renameInputRef" v-model="renameInputValue" :disabled="isPathMutating" autocomplete="off" />
        </label>
        <div class="ssh-modal-actions">
          <button type="button" class="ssh-modal-button" :disabled="isPathMutating" @click="closeRenameDialog">
            取消
          </button>
          <button type="submit" class="ssh-modal-button is-primary" :disabled="!canConfirmRename || isPathMutating">
            {{ isPathMutating ? '处理中…' : '重命名' }}
          </button>
        </div>
      </form>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="pendingDeleteItem" class="ssh-modal-backdrop" @click.self="closeDeleteDialog">
      <section class="ssh-modal is-danger" role="alertdialog" aria-modal="true">
        <div class="ssh-modal-copy">
          <h3>删除远端项目？</h3>
          <p>将删除“{{ pendingDeleteItem.name }}”。此操作不可撤销，请确认这是你想要的操作。</p>
        </div>
        <div class="ssh-modal-actions">
          <button type="button" class="ssh-modal-button" :disabled="isPathMutating" @click="closeDeleteDialog">
            取消
          </button>
          <button type="button" class="ssh-modal-button is-danger" :disabled="isPathMutating"
            @click="confirmDeletePath">
            {{ isPathMutating ? '删除中…' : '删除' }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
