<script setup lang="ts">
import FieldError from '@/components/common/FieldError.vue'
import LinearContextMenu from '@/components/common/LinearContextMenu.vue'
import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types'
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import DropdownMenu from '@/components/ui/dropdown-menu/DropdownMenu.vue'
import DropdownMenuContent from '@/components/ui/dropdown-menu/DropdownMenuContent.vue'
import DropdownMenuItem from '@/components/ui/dropdown-menu/DropdownMenuItem.vue'
import DropdownMenuTrigger from '@/components/ui/dropdown-menu/DropdownMenuTrigger.vue'
import { useIntegratedTerminalControls } from '@/composables/useIntegratedTerminal'
import { useMessage } from '@/composables/useMessage'
import { tauriService } from '@/services/tauri'
import { useSshStore } from '@/store/ssh'
import type {
  ISshAuthOption,
  ISshFileItem,
  ISshPathSegment,
  ISshRecentConnection,
  ISshTransferItem,
  TSshAuthMode,
  TSshContentTab,
  TSshFileKind,
  TSshFooterAction,
  TSshPanelTab,
  TSshTransferDirection,
} from '@/types/ssh'
import { RefreshCw, Server, Unplug } from 'lucide-vue-next'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

const CONTEXT_MENU_WIDTH = 172
const CONTEXT_MENU_HEIGHT = 252
const SSH_BREADCRUMB_COLLAPSE_THRESHOLD = 4
const SSH_BREADCRUMB_TAIL_COUNT = 2
const DEFAULT_SELECTED_FILE_ID = 'ssh-client'
const MANUAL_CONNECTION_ID = 'manual'
const DEFAULT_SSH_PORT = '22'
const TERMINAL_OPEN_DELAY_MS = 120
const SSH_PASSWORD_SEND_DELAY_MS = 180
const HOST_PATTERN = /^[a-zA-Z0-9._:-]+$/
const USER_PATTERN = /^[a-zA-Z0-9._-]+$/
const SAFE_PATH_PATTERN = /^[^\r\n]+$/

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
    items: [
      { key: 'delete', label: '删除', icon: 'trash', variant: 'destructive' },
    ],
  },
]

const SSH_AUTH_OPTIONS: ISshAuthOption[] = [
  {
    value: 'key',
    label: '密钥认证',
  },
  {
    value: 'password',
    label: '密码认证',
  },
]

type TSshBreadcrumbItem =
  | (ISshPathSegment & { type: 'segment' })
  | { id: 'ssh-path-ellipsis'; type: 'ellipsis'; segments: ISshPathSegment[] }
type TSshConnectionField = 'host' | 'port' | 'username' | 'identityPath' | 'password'

const FALLBACK_SELECTED_FILE: ISshFileItem = {
  id: DEFAULT_SELECTED_FILE_ID,
  name: 'ssh_client.rs',
  kind: 'rust',
  metaLabel: '8.7 KB',
  path: 'ssh_client.rs',
  isDirectory: false,
}

const emit = defineEmits<{
  'open-terminal': []
}>()

const message = useMessage()
const terminalControls = useIntegratedTerminalControls()
const sshStore = useSshStore()
const {
  activeContentTab,
  isConnectFormVisible,
  isConnected,
  selectedFileId,
  normalizedRecentConnections,
  sshFileItems,
  transferItems,
  currentRemotePath,
} = storeToRefs(sshStore)
const connectionForm = sshStore.connectionForm
const authSelectRef = ref<HTMLElement | null>(null)
const renameInputRef = ref<HTMLInputElement | null>(null)
const createDirectoryInputRef = ref<HTMLInputElement | null>(null)
const isConnecting = ref(false)
const connectionStatusText = ref('')
const connectionErrorText = ref('')
const isAuthSelectOpen = ref(false)
const isRemoteDirectoryLoading = ref(false)
const isUploading = ref(false)
const isDownloading = ref(false)
const isPathMutating = ref(false)
const pendingRenameItem = ref<ISshFileItem | null>(null)
const pendingDeleteItem = ref<ISshFileItem | null>(null)
const previewFileItem = ref<ISshFileItem | null>(null)
const previewContent = ref('')
const isPreviewLoading = ref(false)
const isCreateDirectoryDialogOpen = ref(false)
const renameInputValue = ref('')
const createDirectoryName = ref('')
const remoteDirectoryRequestVersion = ref(0)
const activeSshConnectionRequest = ref<ReturnType<typeof createSshConnectionTestRequest> | null>(
  null,
)
const contextMenu = reactive({
  open: false,
  x: 0,
  y: 0,
})
const connectionFieldErrors = reactive<Record<TSshConnectionField, string>>({
  host: '',
  port: '',
  username: '',
  identityPath: '',
  password: '',
})
const isExplorerActive = computed(() => activeContentTab.value === 'explorer')
const isTransferActive = computed(() => activeContentTab.value === 'transfer')
const isDisconnected = computed(() => !isConnected.value)
const selectedFile = computed<ISshFileItem>(
  () => sshFileItems.value.find((item) => item.id === selectedFileId.value) ?? FALLBACK_SELECTED_FILE,
)
const sshCommandPreview = computed(() => buildSshCommand())
const sshPathSegments = computed<ISshPathSegment[]>(() => buildRemotePathSegments(currentRemotePath.value))
const sshBreadcrumbItems = computed<TSshBreadcrumbItem[]>(() => {
  const segments = sshPathSegments.value
  if (segments.length <= SSH_BREADCRUMB_COLLAPSE_THRESHOLD) {
    return segments.map((segment) => ({ ...segment, type: 'segment' as const }))
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
  ]
})
const selectedAuthOption = computed(
  () =>
    SSH_AUTH_OPTIONS.find((option) => option.value === connectionForm.authMode) ??
    SSH_AUTH_OPTIONS[0],
)
const isTransferBusy = computed(() => isUploading.value || isDownloading.value)
const normalizedRenameInput = computed(() => renameInputValue.value.trim())
const normalizedCreateDirectoryName = computed(() => createDirectoryName.value.trim())
const canConfirmRename = computed(() => {
  const item = pendingRenameItem.value
  const nextName = normalizedRenameInput.value
  return Boolean(item && nextName && nextName !== item.name && !nextName.includes('/') && !nextName.includes('\\'))
})
const canConfirmCreateDirectory = computed(() => {
  const nextName = normalizedCreateDirectoryName.value
  return Boolean(nextName && nextName !== '.' && nextName !== '..' && !nextName.includes('/') && !nextName.includes('\\'))
})

const isTabActive = (tab: TSshPanelTab): boolean => {
  if (tab === 'connect') {
    return !isConnected.value || isConnectFormVisible.value
  }

  return isConnected.value && !isConnectFormVisible.value && activeContentTab.value === tab
}

const closeContextMenu = (): void => {
  contextMenu.open = false
}

const closeAuthSelect = (): void => {
  isAuthSelectOpen.value = false
}

const toggleAuthSelect = (): void => {
  isAuthSelectOpen.value = !isAuthSelectOpen.value
  closeContextMenu()
}

const selectAuthMode = (authMode: TSshAuthMode): void => {
  connectionForm.authMode = authMode
  connectionFieldErrors.identityPath = ''
  connectionFieldErrors.password = ''
  closeAuthSelect()
}

const clearConnectionFieldError = (field: TSshConnectionField): void => {
  connectionFieldErrors[field] = ''
  connectionErrorText.value = ''
}

const clearConnectionFieldErrors = (): void => {
  for (const field of Object.keys(connectionFieldErrors) as TSshConnectionField[]) {
    connectionFieldErrors[field] = ''
  }
}

const setContentTab = (tab: TSshContentTab): void => {
  if (!isConnected.value) {
    return
  }

  activeContentTab.value = tab
  isConnectFormVisible.value = false
  closeContextMenu()
  closeAuthSelect()
}

const openConnectForm = (): void => {
  isConnectFormVisible.value = true
  closeContextMenu()
  closeAuthSelect()
}

const toggleConnectForm = (): void => {
  isConnectFormVisible.value = !isConnectFormVisible.value

  if (isConnected.value && !isConnectFormVisible.value) {
    activeContentTab.value = 'explorer'
  }

  closeContextMenu()
  closeAuthSelect()
}

const handleCancelConnect = (): void => {
  isConnectFormVisible.value = false
  closeAuthSelect()

  if (isConnected.value) {
    activeContentTab.value = 'explorer'
  }
}

const applyConnectionState = (connectionId: string | null): void => {
  sshStore.applyConnectionState(connectionId)
  activeContentTab.value = 'explorer'
  closeContextMenu()
}

const quoteShellArg = (value: string): string => {
  const normalizedValue = value.trim()
  if (/^[a-zA-Z0-9_@%+=:,./~-]+$/.test(normalizedValue)) {
    return normalizedValue
  }

  return "'" + normalizedValue.replace(/'/g, "'\\''") + "'"
}

const formatRemoteFileSize = (size: number): string => {
  if (size < 1024) {
    return `${size} B`
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

const resolveFileKind = (name: string, isDirectory: boolean): TSshFileKind => {
  if (isDirectory) {
    return 'folder'
  }

  if (name.endsWith('.rs')) {
    return 'rust'
  }

  if (name.endsWith('.toml')) {
    return 'toml'
  }

  if (name.endsWith('.md')) {
    return 'markdown'
  }

  if (name.toLowerCase().endsWith('lock')) {
    return 'lock'
  }

  return 'file'
}

const buildRemotePathSegments = (path: string): ISshPathSegment[] => {
  const normalizedPath = path.trim() || '.'
  if (normalizedPath === '.') {
    return [{ id: '.', label: '.', path: '.' }]
  }

  const segments: ISshPathSegment[] = []
  const isAbsolutePath = normalizedPath.startsWith('/')
  const parts = normalizedPath.split('/').filter(Boolean)
  let cursor = isAbsolutePath ? '' : ''

  if (isAbsolutePath) {
    segments.push({ id: '/', label: '/', path: '/' })
  }

  for (const part of parts) {
    cursor = cursor ? `${cursor}/${part}` : isAbsolutePath ? `/${part}` : part
    segments.push({ id: cursor, label: part, path: cursor })
  }

  return segments.length > 0 ? segments : [{ id: '.', label: '.', path: '.' }]
}

const createSshConnectionTestRequest = () => ({
  host: connectionForm.host.trim(),
  port: Number.parseInt(connectionForm.port.trim(), 10),
  username: connectionForm.username.trim(),
  authMode: connectionForm.authMode,
  identityPath:
    connectionForm.authMode === 'key' ? connectionForm.identityPath.trim() || null : null,
  password: connectionForm.authMode === 'password' ? connectionForm.password : null,
})

const createSshConnectionRequest = (): ReturnType<typeof createSshConnectionTestRequest> =>
  activeSshConnectionRequest.value ?? createSshConnectionTestRequest()

const createSshDirectoryRequest = (path: string) => ({
  ...createSshConnectionRequest(),
  path,
})

const createSshFileTransferRequest = (remotePath: string, localPath: string) => ({
  ...createSshConnectionRequest(),
  remotePath,
  localPath,
})

const createSshFileUploadRequest = (localPath: string, remoteDirectory: string) => ({
  ...createSshConnectionRequest(),
  localPath,
  remoteDirectory,
})

const createSshPathDeleteRequest = (remotePath: string) => ({
  ...createSshConnectionRequest(),
  remotePath,
})

const createSshPathRenameRequest = (remotePath: string, newName: string) => ({
  ...createSshConnectionRequest(),
  remotePath,
  newName,
})

const createSshDirectoryCreateRequest = (remoteDirectory: string, name: string) => ({
  ...createSshConnectionRequest(),
  remoteDirectory,
  name,
})

const createSshFileReadRequest = (remotePath: string) => ({
  ...createSshConnectionRequest(),
  remotePath,
})

const createSshPasswordIdentityRequest = () => ({
  host: connectionForm.host.trim(),
  port: Number.parseInt(connectionForm.port.trim(), 10),
  username: connectionForm.username.trim(),
})

const saveCurrentSshPassword = async (): Promise<void> => {
  if (connectionForm.authMode !== 'password') {
    return
  }

  await tauriService.saveSshPassword({
    ...createSshPasswordIdentityRequest(),
    password: connectionForm.password,
  })
}

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
})

const updateTransferItem = (
  transferId: string,
  patch: Partial<Omit<ISshTransferItem, 'id'>>,
): void => {
  const target = transferItems.value.find((item) => item.id === transferId)
  if (!target) {
    return
  }

  Object.assign(target, patch)
}

const loadRemoteDirectorySnapshot = async (path: string): Promise<void> => {
  const requestVersion = remoteDirectoryRequestVersion.value + 1
  remoteDirectoryRequestVersion.value = requestVersion
  isRemoteDirectoryLoading.value = true

  try {
    const result = await tauriService.listSshDirectory(createSshDirectoryRequest(path))
    if (requestVersion !== remoteDirectoryRequestVersion.value) {
      return
    }
    currentRemotePath.value = result.path
    sshFileItems.value = result.entries.map((entry) => {
      const isDirectory = entry.kind === 'directory'
      return {
        id: entry.path,
        name: entry.name,
        kind: resolveFileKind(entry.name, isDirectory),
        metaLabel: isDirectory ? '目录' : formatRemoteFileSize(entry.size),
        path: entry.path,
        isDirectory,
      }
    })
    selectedFileId.value = sshFileItems.value[0]?.id ?? ''
  } finally {
    if (requestVersion === remoteDirectoryRequestVersion.value) {
      isRemoteDirectoryLoading.value = false
    }
  }
}

const loadRemoteDirectory = async (path: string): Promise<void> => {
  try {
    await loadRemoteDirectorySnapshot(path)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '读取远端目录失败。'
    message.error(errorMessage)
  }
}

const downloadSelectedFile = async (): Promise<void> => {
  if (!isConnected.value || isDownloading.value) {
    return
  }

  const fileItem = selectedFile.value
  if (fileItem.isDirectory) {
    message.info('暂不支持下载目录，请选择一个文件。')
    return
  }

  const savePath = await tauriService.pickSavePath(fileItem.name)
  if (!savePath) {
    return
  }

  const transferItem = createTransferItem('download', fileItem.name, '下载中…')
  transferItems.value.unshift(transferItem)
  isDownloading.value = true

  try {
    const result = await tauriService.downloadSshFile(
      createSshFileTransferRequest(fileItem.path, savePath),
    )
    updateTransferItem(transferItem.id, {
      sizeLabel: formatRemoteFileSize(result.byteSize),
      progressLabel: '已完成',
      progress: 100,
      status: 'done',
    })
    message.success(`已下载 ${fileItem.name}，共 ${formatRemoteFileSize(result.byteSize)}。`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '下载远端文件失败。'
    updateTransferItem(transferItem.id, {
      progressLabel: errorMessage,
      progress: 100,
      status: 'failed',
    })
    message.error(errorMessage)
  } finally {
    isDownloading.value = false
  }
}

const uploadFileToCurrentDirectory = async (): Promise<void> => {
  if (!isConnected.value || isUploading.value) {
    return
  }

  const localPath = await tauriService.pickAnyOpenPath()
  if (!localPath) {
    return
  }

  const selectedItem = sshFileItems.value.find((item) => item.id === selectedFileId.value)
  const remoteDirectory = selectedItem?.isDirectory ? selectedItem.path : currentRemotePath.value
  const transferItem = createTransferItem('upload', localPath.split(/[\\/]/).pop() ?? localPath, '上传中…')
  transferItems.value.unshift(transferItem)
  isUploading.value = true

  try {
    const result = await tauriService.uploadSshFile(
      createSshFileUploadRequest(localPath, remoteDirectory),
    )
    await loadRemoteDirectory(currentRemotePath.value)
    updateTransferItem(transferItem.id, {
      sizeLabel: formatRemoteFileSize(result.byteSize),
      progressLabel: '已完成',
      progress: 100,
      status: 'done',
    })
    message.success(`已上传到 ${result.remotePath}，共 ${formatRemoteFileSize(result.byteSize)}。`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '上传本地文件失败。'
    updateTransferItem(transferItem.id, {
      progressLabel: errorMessage,
      progress: 100,
      status: 'failed',
    })
    message.error(errorMessage)
  } finally {
    isUploading.value = false
  }
}

const copySelectedPath = async (): Promise<void> => {
  const fileItem = selectedFile.value
  try {
    await navigator.clipboard.writeText(fileItem.path)
    message.success('已复制远端路径。')
  } catch {
    message.error('复制远端路径失败。')
  }
}

const closePreviewDialog = (): void => {
  if (isPreviewLoading.value) {
    return
  }
  previewFileItem.value = null
  previewContent.value = ''
}

const previewRemoteFile = async (fileItem: ISshFileItem): Promise<void> => {
  if (isPreviewLoading.value) {
    return
  }
  previewFileItem.value = fileItem
  previewContent.value = ''
  isPreviewLoading.value = true
  try {
    const result = await tauriService.readSshFile(createSshFileReadRequest(fileItem.path))
    previewContent.value = result.content
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '读取远端文件失败。'
    message.error(errorMessage)
    previewFileItem.value = null
  } finally {
    isPreviewLoading.value = false
  }
}

const resetRenameDialog = (force = false): void => {
  if (isPathMutating.value && !force) {
    return
  }

  pendingRenameItem.value = null
  renameInputValue.value = ''
}

const closeRenameDialog = (): void => {
  resetRenameDialog(false)
}

const resetDeleteDialog = (force = false): void => {
  if (isPathMutating.value && !force) {
    return
  }

  pendingDeleteItem.value = null
}

const closeDeleteDialog = (): void => {
  resetDeleteDialog(false)
}

const resetCreateDirectoryDialog = (force = false): void => {
  if (isPathMutating.value && !force) {
    return
  }

  isCreateDirectoryDialogOpen.value = false
  createDirectoryName.value = ''
}

const closeCreateDirectoryDialog = (): void => {
  resetCreateDirectoryDialog(false)
}

const focusRenameInput = async (): Promise<void> => {
  await nextTick()
  renameInputRef.value?.focus()
  renameInputRef.value?.select()
}

const focusCreateDirectoryInput = async (): Promise<void> => {
  await nextTick()
  createDirectoryInputRef.value?.focus()
}

const renameSelectedPath = async (): Promise<void> => {
  const fileItem = selectedFile.value
  pendingRenameItem.value = fileItem
  renameInputValue.value = fileItem.name
  await focusRenameInput()
}

const openCreateDirectoryDialog = async (): Promise<void> => {
  if (!isConnected.value || isPathMutating.value) {
    return
  }

  createDirectoryName.value = ''
  isCreateDirectoryDialogOpen.value = true
  await focusCreateDirectoryInput()
}

const confirmRenamePath = async (): Promise<void> => {
  const fileItem = pendingRenameItem.value
  const newName = normalizedRenameInput.value
  if (!fileItem || !newName || newName === fileItem.name) {
    resetRenameDialog(true)
    return
  }

  if (!canConfirmRename.value) {
    message.error('新名称不能包含路径分隔符。')
    return
  }

  isPathMutating.value = true
  try {
    await tauriService.renameSshPath(createSshPathRenameRequest(fileItem.path, newName))
    closeRenameDialog()
    await loadRemoteDirectory(currentRemotePath.value)
    message.success('远端路径已重命名。')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '重命名远端路径失败。'
    message.error(errorMessage)
  } finally {
    isPathMutating.value = false
  }
}

const deleteSelectedPath = (): void => {
  pendingDeleteItem.value = selectedFile.value
}

const confirmCreateDirectory = async (): Promise<void> => {
  const directoryName = normalizedCreateDirectoryName.value
  if (!canConfirmCreateDirectory.value) {
    message.error('目录名称不能为空，且不能包含路径分隔符。')
    return
  }

  isPathMutating.value = true
  try {
    const result = await tauriService.createSshDirectory(
      createSshDirectoryCreateRequest(currentRemotePath.value, directoryName),
    )
    resetCreateDirectoryDialog(true)
    await loadRemoteDirectory(currentRemotePath.value)
    selectedFileId.value = result.remotePath
    message.success('远端目录已创建。')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '创建远端目录失败。'
    message.error(errorMessage)
  } finally {
    isPathMutating.value = false
  }
}

const confirmDeletePath = async (): Promise<void> => {
  const fileItem = pendingDeleteItem.value
  if (!fileItem) {
    return
  }

  isPathMutating.value = true
  try {
    await tauriService.deleteSshPath(createSshPathDeleteRequest(fileItem.path))
    resetDeleteDialog(true)
    await loadRemoteDirectory(currentRemotePath.value)
    message.success('远端路径已删除。')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '删除远端路径失败。'
    message.error(errorMessage)
  } finally {
    isPathMutating.value = false
  }
}

const setConnectionFieldError = (field: TSshConnectionField, message: string): false => {
  connectionFieldErrors[field] = message
  return false
}

const validateConnectionForm = (): boolean => {
  clearConnectionFieldErrors()
  const host = connectionForm.host.trim()
  const username = connectionForm.username.trim()
  const port = Number.parseInt(connectionForm.port.trim(), 10)
  const identityPath = connectionForm.identityPath.trim()

  if (!host) {
    return setConnectionFieldError('host', '请填写主机地址。')
  }

  if (!HOST_PATTERN.test(host)) {
    return setConnectionFieldError('host', '主机地址只能包含字母、数字、点、短横线、下划线或冒号。')
  }

  if (!username) {
    return setConnectionFieldError('username', '请填写用户名。')
  }

  if (!USER_PATTERN.test(username)) {
    return setConnectionFieldError('username', '用户名只能包含字母、数字、点、短横线或下划线。')
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return setConnectionFieldError('port', '端口必须是 1 到 65535 之间的整数。')
  }

  if (connectionForm.authMode === 'password' && !connectionForm.password) {
    return setConnectionFieldError('password', '请填写登录密码。')
  }

  if (identityPath && !SAFE_PATH_PATTERN.test(identityPath)) {
    return setConnectionFieldError('identityPath', '私钥路径不能包含换行符。')
  }

  if (connectionForm.authMode === 'password' && !SAFE_PATH_PATTERN.test(connectionForm.password)) {
    return setConnectionFieldError('password', '登录密码不能包含换行符。')
  }

  return true
}

const buildSshCommand = (): string => {
  const host = connectionForm.host.trim()
  const username = connectionForm.username.trim()
  const port = connectionForm.port.trim() || DEFAULT_SSH_PORT
  const parts = ['ssh', '-p', quoteShellArg(port)]

  if (connectionForm.authMode === 'key' && connectionForm.identityPath.trim()) {
    parts.push('-i', quoteShellArg(connectionForm.identityPath))
  }

  if (connectionForm.authMode === 'password') {
    parts.push(
      '-o',
      'PreferredAuthentications=password',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'NumberOfPasswordPrompts=1',
      '-o',
      'StrictHostKeyChecking=accept-new',
    )
  }

  if (username && host) {
    parts.push(username + '@' + host)
  }

  return parts.join(' ')
}

const openTerminalSessionBestEffort = async (): Promise<void> => {
  try {
    emit('open-terminal')
    await new Promise((resolve) => window.setTimeout(resolve, TERMINAL_OPEN_DELAY_MS))
    await terminalControls.sendCommand(sshCommandPreview.value)
    if (connectionForm.authMode === 'password') {
      await new Promise((resolve) => window.setTimeout(resolve, SSH_PASSWORD_SEND_DELAY_MS))
      await terminalControls.sendInput(`${connectionForm.password}\n`)
    }
  } catch {
    message.info('文件连接已建立，终端会话暂未打开。')
  }
}

const handleConnect = async (connectionId = MANUAL_CONNECTION_ID): Promise<void> => {
  connectionErrorText.value = ''
  connectionStatusText.value = ''
  if (!validateConnectionForm()) {
    return
  }

  isConnecting.value = true
  connectionStatusText.value = '正在验证 SSH 连接…'

  try {
    const connectionRequest = createSshConnectionTestRequest()
    const testResult = await tauriService.testSshConnection(connectionRequest)

    if (!testResult.ok) {
      connectionErrorText.value = testResult.message
      message.error(testResult.message)
      return
    }

    connectionStatusText.value = '正在读取远端目录…'
    activeSshConnectionRequest.value = connectionRequest
    await loadRemoteDirectorySnapshot('.')
    try {
      await saveCurrentSshPassword()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '保存 SSH 密码失败。'
      message.error(`连接已成功，但保存密码失败：${errorMessage}`)
    }
    const rememberedConnectionId = sshStore.rememberCurrentConnection(connectionId)
    applyConnectionState(rememberedConnectionId)
    message.success('SSH 连接验证成功，已打开远端会话。')
    void openTerminalSessionBestEffort()
  } catch (error) {
    activeSshConnectionRequest.value = null
    const errorMessage = error instanceof Error ? error.message : 'SSH 连接失败。'
    connectionErrorText.value = errorMessage
    message.error(errorMessage)
  } finally {
    isConnecting.value = false
    connectionStatusText.value = ''
  }
}

const handleConnectSubmit = (): void => {
  if (isConnecting.value) {
    return
  }
  void handleConnect()
}

const handleImportConfig = async (): Promise<void> => {
  try {
    const hosts = await tauriService.listSshConfigHosts()
    if (hosts.length === 0) {
      message.info('未在本机 SSH 配置中发现可导入主机。')
      return
    }

    const importedConnections = hosts.map((host) => ({
      id: host.id,
      name: host.name,
      username: host.username,
      host: host.host,
      port: String(host.port),
      authMode: 'key',
      identityPath: host.identityPath ?? '',
      lastUsedLabel: host.lastUsedLabel,
      lastUsedAt: null,
    }))
    sshStore.setRecentConnections([...importedConnections, ...sshStore.recentConnections])
    message.success(`已导入 ${hosts.length} 个 SSH 配置主机。`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'SSH 配置导入失败。'
    message.error(errorMessage)
  }
}

const handleSelectRecentConnection = async (connection: ISshRecentConnection): Promise<void> => {
  sshStore.setConnectionFormFromProfile(connection)
  if (connection.authMode === 'password') {
    try {
      const savedCredential = await tauriService.getSshPassword(createSshPasswordIdentityRequest())
      connectionForm.password = savedCredential.password
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未找到已保存的 SSH 密码。'
      isConnectFormVisible.value = true
      message.info(errorMessage)
      return
    }
    await handleConnect(connection.id)
    return
  }

  await handleConnect(connection.id)
}

const handlePathSegmentClick = (segment: ISshPathSegment): void => {
  if (segment.path === currentRemotePath.value || isRemoteDirectoryLoading.value) {
    return
  }

  void loadRemoteDirectory(segment.path)
}

const refreshCurrentRemoteDirectory = (): void => {
  if (!isConnected.value || isRemoteDirectoryLoading.value) {
    return
  }

  void loadRemoteDirectory(currentRemotePath.value)
}

const disconnectSshSession = (): void => {
  remoteDirectoryRequestVersion.value += 1
  isRemoteDirectoryLoading.value = false
  isPathMutating.value = false
  activeSshConnectionRequest.value = null
  resetRenameDialog(true)
  resetDeleteDialog(true)
  resetCreateDirectoryDialog(true)
  closeContextMenu()
  closeAuthSelect()
  sshStore.clearConnectionState()
  message.info('已断开 SSH 文件会话。')
}

const handleSelectFile = (fileId: string): void => {
  selectedFileId.value = fileId
  closeContextMenu()

  const fileItem = sshFileItems.value.find((item) => item.id === fileId)
  if (fileItem?.isDirectory && !isRemoteDirectoryLoading.value) {
    void loadRemoteDirectory(fileItem.path)
    return
  }
  if (fileItem && !fileItem.isDirectory) {
    void previewRemoteFile(fileItem)
  }
}

const handleFileContextMenu = (event: MouseEvent, fileId: string): void => {
  selectedFileId.value = fileId

  const maxX = Math.max(12, window.innerWidth - CONTEXT_MENU_WIDTH - 12)
  const maxY = Math.max(12, window.innerHeight - CONTEXT_MENU_HEIGHT - 12)

  contextMenu.x = Math.min(event.clientX, maxX)
  contextMenu.y = Math.min(event.clientY, maxY)
  contextMenu.open = true
}

const handleContextMenuSelect = (action: ILinearContextMenuItem): void => {
  if (isPathMutating.value || isRemoteDirectoryLoading.value) {
    closeContextMenu()
    return
  }

  const targetLabel = selectedFile.value.name
  if (action.key === 'new-folder') {
    closeContextMenu()
    void openCreateDirectoryDialog()
    return
  }
  if (action.key === 'download') {
    closeContextMenu()
    void downloadSelectedFile()
    return
  }
  if (action.key === 'upload') {
    closeContextMenu()
    void uploadFileToCurrentDirectory()
    return
  }
  if (action.key === 'copy-path') {
    closeContextMenu()
    void copySelectedPath()
    return
  }
  if (action.key === 'rename') {
    closeContextMenu()
    void renameSelectedPath()
    return
  }
  if (action.key === 'delete') {
    closeContextMenu()
    void deleteSelectedPath()
    return
  }

  message.info(`${action.label}待接入：${targetLabel}`)
  closeContextMenu()
}

const handleFooterAction = (action: TSshFooterAction): void => {
  if (!isConnected.value) {
    return
  }

  if (action === 'new-folder') {
    void openCreateDirectoryDialog()
    return
  }

  if (action === 'download') {
    void downloadSelectedFile()
    return
  }

  void uploadFileToCurrentDirectory()
}

const handleWindowClick = (event: MouseEvent): void => {
  const target = event.target

  if (contextMenu.open) {
    if (target instanceof Element && target.closest('.linear-context-menu-root') !== null) {
      return
    }

    closeContextMenu()
  }

  if (target instanceof Node && authSelectRef.value?.contains(target)) {
    return
  }

  closeAuthSelect()
}

const handleWindowContextMenu = (event: MouseEvent): void => {
  const target = event.target
  if (!(target instanceof Element)) {
    closeContextMenu()
    return
  }

  if (!target.closest('.ssh-file-item')) {
    closeContextMenu()
  }
}

const handleWindowKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') {
    closeContextMenu()
    closeAuthSelect()
    closeRenameDialog()
    closeDeleteDialog()
    closeCreateDirectoryDialog()
  }
}

onMounted(() => {
  window.addEventListener('click', handleWindowClick)
  window.addEventListener('contextmenu', handleWindowContextMenu)
  window.addEventListener('keydown', handleWindowKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', handleWindowClick)
  window.removeEventListener('contextmenu', handleWindowContextMenu)
  window.removeEventListener('keydown', handleWindowKeydown)
})
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
        <div class="ssh-form-row">
          <label class="ssh-form-group">
            <span>主机地址</span>
            <input
              v-model="connectionForm.host"
              type="text"
              placeholder="192.168.1.100"
              autocomplete="off"
              :aria-invalid="Boolean(connectionFieldErrors.host)"
              @input="clearConnectionFieldError('host')"
            />
            <FieldError v-if="connectionFieldErrors.host" :message="connectionFieldErrors.host" />
          </label>

          <label class="ssh-form-group is-compact">
            <span>端口</span>
            <input
              v-model="connectionForm.port"
              type="text"
              placeholder="22"
              inputmode="numeric"
              autocomplete="off"
              :aria-invalid="Boolean(connectionFieldErrors.port)"
              @input="clearConnectionFieldError('port')"
            />
            <FieldError v-if="connectionFieldErrors.port" :message="connectionFieldErrors.port" />
          </label>
        </div>

        <label class="ssh-form-group">
          <span>用户名</span>
          <input
            v-model="connectionForm.username"
            type="text"
            placeholder="root"
            autocomplete="off"
            :aria-invalid="Boolean(connectionFieldErrors.username)"
            @input="clearConnectionFieldError('username')"
          />
          <FieldError v-if="connectionFieldErrors.username" :message="connectionFieldErrors.username" />
        </label>

        <div ref="authSelectRef" class="ssh-form-group ssh-auth-field">
          <span>认证方式</span>
          <button type="button" class="ssh-auth-select-trigger" :class="{ 'is-open': isAuthSelectOpen }"
            :aria-expanded="isAuthSelectOpen" aria-haspopup="listbox" @click.stop="toggleAuthSelect">
            <span class="ssh-auth-select-leading" aria-hidden="true">
              <svg v-if="connectionForm.authMode === 'key'" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <circle cx="7.5" cy="15.5" r="3.5" />
                <path d="M10 13l8-8" />
                <path d="M16 7l2 2" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <rect x="4" y="10" width="16" height="10" rx="2" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" />
              </svg>
            </span>
            <span class="ssh-auth-select-copy">
              <span class="ssh-auth-select-label">{{ selectedAuthOption.label }}</span>
            </span>
            <svg class="ssh-auth-select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          <div v-if="isAuthSelectOpen" class="ssh-auth-select-menu" role="listbox">
            <div class="ssh-auth-select-group">认证方式</div>
            <button v-for="option in SSH_AUTH_OPTIONS" :key="option.value" type="button" class="ssh-auth-option"
              :class="{ 'is-selected': connectionForm.authMode === option.value }" role="option"
              :aria-selected="connectionForm.authMode === option.value" @click.stop="selectAuthMode(option.value)">
              <span class="ssh-auth-option-copy">
                <span class="ssh-auth-option-label">{{ option.label }}</span>
              </span>
              <svg v-if="connectionForm.authMode === option.value" class="ssh-auth-option-check" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
          </div>
        </div>

        <label v-if="connectionForm.authMode === 'key'" class="ssh-form-group">
          <span>私钥路径</span>
          <input
            v-model="connectionForm.identityPath"
            type="text"
            placeholder="~/.ssh/id_rsa"
            autocomplete="off"
            :aria-invalid="Boolean(connectionFieldErrors.identityPath)"
            @input="clearConnectionFieldError('identityPath')"
          />
          <FieldError
            v-if="connectionFieldErrors.identityPath"
            :message="connectionFieldErrors.identityPath"
          />
        </label>
        <label v-else class="ssh-form-group">
          <span>登录密码</span>
          <input
            v-model="connectionForm.password"
            type="password"
            placeholder="输入 SSH 登录密码"
            autocomplete="current-password"
            :aria-invalid="Boolean(connectionFieldErrors.password)"
            @input="clearConnectionFieldError('password')"
          />
          <FieldError v-if="connectionFieldErrors.password" :message="connectionFieldErrors.password" />
        </label>

        <div class="ssh-form-actions">
          <button type="submit" class="ssh-button ssh-button--primary" :disabled="isConnecting"
            @click.prevent="handleConnectSubmit">
            {{ isConnecting ? '连接中…' : '连接' }}
          </button>
          <button type="button" class="ssh-button ssh-button--ghost" :disabled="isConnecting"
            @click="handleCancelConnect">取消</button>
        </div>

        <div v-if="connectionStatusText || connectionErrorText" class="ssh-connect-feedback"
          :class="{ 'is-error': Boolean(connectionErrorText) }" aria-live="polite">
          {{ connectionErrorText || connectionStatusText }}
        </div>
      </form>

      <section v-else-if="isDisconnected" class="ssh-empty-state ssh-empty-state--disconnected" aria-label="SSH 未连接状态">
        <Server class="ssh-empty-icon" aria-hidden="true" />

        <div class="ssh-empty-copy">
          <div class="ssh-empty-title ssh-empty-title--disconnected">尚未连接到远程主机</div>
          <div class="ssh-empty-desc ssh-empty-desc--disconnected">
            连接一台 SSH 服务器后，即可在此浏览文件、上传下载以及管理远程资源。
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

          <button type="button" class="ssh-button ssh-button--ghost ssh-button--stacked ssh-button--disconnected-ghost"
            @click="handleImportConfig">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
              stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            导入配置
          </button>
        </div>

        <section class="ssh-recent-section ssh-recent-section--disconnected" aria-label="最近使用 SSH 连接">
          <div class="ssh-recent-title ssh-recent-title--disconnected">最近使用</div>

          <div v-if="normalizedRecentConnections.length === 0" class="ssh-recent-empty">
            暂无真实连接记录，可新建连接或导入本机 SSH 配置。
          </div>

          <button v-for="connection in normalizedRecentConnections" :key="connection.id" type="button"
            class="ssh-recent-item ssh-recent-item--disconnected" @click="handleSelectRecentConnection(connection)">
            <span class="ssh-recent-icon ssh-recent-icon--disconnected" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <line x1="6" y1="8" x2="6.01" y2="8" />
              </svg>
            </span>

            <span class="ssh-recent-info">
              <span class="ssh-recent-name ssh-recent-name--disconnected">{{ connection.name }}</span>
              <span class="ssh-recent-host ssh-recent-host--disconnected">{{ connection.username }}@{{ connection.host
                }}</span>
            </span>

            <span class="ssh-recent-time ssh-recent-time--disconnected">{{ connection.lastUsedLabel }}</span>
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
                      <button
                        type="button"
                        class="ssh-path-ellipsis"
                        :disabled="isRemoteDirectoryLoading"
                        aria-label="展开中间路径"
                      >
                        <BreadcrumbEllipsis class="ssh-path-ellipsis-icon" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" class="ssh-path-menu">
                      <DropdownMenuItem
                        v-for="segment in item.segments"
                        :key="segment.id"
                        class="ssh-path-menu-item"
                        :disabled="isRemoteDirectoryLoading"
                        @select="handlePathSegmentClick(segment)"
                      >
                        {{ segment.label }}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </BreadcrumbItem>
                <BreadcrumbItem v-else>
                  <BreadcrumbPage
                    v-if="item.path === currentRemotePath"
                    class="ssh-path-segment is-current"
                  >
                    {{ item.label }}
                  </BreadcrumbPage>
                  <BreadcrumbLink v-else as-child>
                    <button
                      type="button"
                      class="ssh-path-segment"
                      :disabled="isRemoteDirectoryLoading"
                      @click="handlePathSegmentClick(item)"
                    >
                      {{ item.label }}
                    </button>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator
                  v-if="index < sshBreadcrumbItems.length - 1"
                  class="ssh-path-separator"
                />
              </template>
            </BreadcrumbList>
          </Breadcrumb>
          <div class="ssh-path-actions">
            <button
              type="button"
              class="ssh-path-action"
              aria-label="断开 SSH 连接"
              title="断开连接"
              @click="disconnectSshSession"
            >
              <Unplug aria-hidden="true" />
            </button>
            <button
              type="button"
              class="ssh-path-action"
              :disabled="isRemoteDirectoryLoading"
              aria-label="刷新远端目录"
              title="刷新远端目录"
              @click="refreshCurrentRemoteDirectory"
            >
              <RefreshCw aria-hidden="true" />
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
              @contextmenu.prevent="handleFileContextMenu($event, item.id)">
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

              <span class="ssh-file-name">{{ item.name }}</span>
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
                {{ item.status === 'done' ? '✓' : item.status === 'failed' ? '失败' : '进行中' }}
              </span>
            </div>
          </article>
        </div>
      </template>
    </div>

    <footer class="ssh-sidebar-footer" :class="{ 'ssh-sidebar-footer--disconnected': isDisconnected }">
      <button type="button" class="ssh-footer-button" :class="{
        'ssh-footer-button--disconnected': isDisconnected,
        'is-disabled': isDisconnected || isPathMutating,
      }" :disabled="isDisconnected || isPathMutating" title="连接后可用"
        @click="handleFooterAction('new-folder')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        新建
      </button>

      <button type="button" class="ssh-footer-button" :class="{
        'ssh-footer-button--disconnected': isDisconnected,
        'is-disabled': isDisconnected || isTransferBusy || isPathMutating,
      }" :disabled="isDisconnected || isTransferBusy || isPathMutating" title="连接后可用"
        @click="handleFooterAction('upload')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        上传
      </button>

      <button type="button" class="ssh-footer-button" :class="{
        'ssh-footer-button--disconnected': isDisconnected,
        'is-disabled': isDisconnected || isTransferBusy || isPathMutating,
      }" :disabled="isDisconnected || isTransferBusy || isPathMutating" title="连接后可用"
        @click="handleFooterAction('download')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        下载
      </button>
    </footer>
  </section>

  <LinearContextMenu :open="isConnected && contextMenu.open" :x="contextMenu.x" :y="contextMenu.y"
    :groups="SSH_CONTEXT_MENU_GROUPS" theme="dark" submenu-direction="right" @select="handleContextMenuSelect" />

  <Teleport to="body">
    <div v-if="previewFileItem" class="ssh-modal-backdrop" @click.self="closePreviewDialog">
      <section class="ssh-modal ssh-preview-modal" role="dialog" aria-modal="true">
        <div class="ssh-modal-copy">
          <h3>{{ previewFileItem.name }}</h3>
          <p>{{ previewFileItem.path }}</p>
        </div>
        <div class="ssh-preview-body" aria-live="polite">
          <div v-if="isPreviewLoading" class="ssh-file-list-state">正在读取远端文件…</div>
          <pre v-else>{{ previewContent }}</pre>
        </div>
        <div class="ssh-modal-actions">
          <button type="button" class="ssh-modal-button" :disabled="isPreviewLoading" @click="closePreviewDialog">
            关闭
          </button>
        </div>
      </section>
    </div>
  </Teleport>

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

<style scoped>
.ssh-sidebar-panel {
  --ssh-sidebar-bg: #fafafa;
  --ssh-sidebar-border: var(--border-subtle);
  --ssh-sidebar-text-primary: var(--text-primary);
  --ssh-sidebar-text-secondary: var(--text-secondary);
  --ssh-sidebar-text-muted: var(--text-tertiary);
  --ssh-sidebar-text-faint: var(--text-quaternary);
  --ssh-sidebar-text-disabled: color-mix(in srgb, var(--text-quaternary) 72%, transparent);
  --ssh-sidebar-accent: #6366f1;
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  background: var(--ssh-sidebar-bg);
  color: var(--ssh-sidebar-text-primary);
  user-select: none;
}

.ssh-sidebar-header {
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--shell-divider);
}

.ssh-sidebar-header h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.ssh-connection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.25;
  color: var(--text-tertiary);
}

.ssh-connection-status--disconnected {
  color: var(--ssh-sidebar-text-muted);
}

.ssh-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--success);
  box-shadow: 0 0 10px color-mix(in srgb, var(--success) 48%, transparent);
  position: relative;
}

.ssh-status-dot.is-offline {
  background: #555;
  box-shadow: none;
}

.ssh-status-dot.is-offline::after {
  position: absolute;
  inset: -3px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 96%, transparent);
  border-radius: 999px;
  animation: ssh-status-pulse 2s ease-in-out infinite;
  content: '';
}

@keyframes ssh-status-pulse {

  0%,
  100% {
    opacity: 0.4;
    transform: scale(1);
  }

  50% {
    opacity: 0.12;
    transform: scale(1.4);
  }
}

.ssh-tabs {
  display: flex;
  gap: 2px;
  padding: 8px 12px 0;
}

.ssh-tabs--disconnected {
  padding: 8px 12px 0;
}

.ssh-panel-body {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}

.ssh-panel-body--disconnected {
  min-height: 0;
}

.ssh-panel-body--connected {
  min-height: 0;
}

.ssh-tab,
.ssh-button,
.ssh-footer-button,
.ssh-file-item,
.ssh-path-segment {
  appearance: none;
  border: 0;
  outline: none;
  font: inherit;
}

.ssh-tab {
  flex: 1;
  border-radius: 6px;
  padding: 6px 0;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
  cursor: pointer;
}

.ssh-tab:hover {
  background: var(--surface-soft);
  color: var(--text-secondary);
}

.ssh-tab.is-active {
  background: var(--surface-soft-strong);
  color: var(--text-primary);
}

.ssh-tab--disconnected {
  color: var(--ssh-sidebar-text-muted);
}

.ssh-tab--disconnected:hover {
  background: var(--surface-soft);
  color: var(--ssh-sidebar-text-secondary);
}

.ssh-tab--disconnected.is-active {
  background: #fafafa;
  color: var(--ssh-sidebar-text-primary);
}

.ssh-tab.is-disabled {
  color: color-mix(in srgb, var(--text-quaternary) 56%, transparent);
  cursor: default;
}

.ssh-tab.is-disabled:hover {
  background: transparent;
  color: color-mix(in srgb, var(--text-quaternary) 56%, transparent);
}

.ssh-tab--disconnected.is-disabled,
.ssh-tab--disconnected.is-disabled:hover {
  background: transparent;
  color: #4b4b56;
}

.ssh-empty-state {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 20px;
  gap: 14px;
  text-align: center;
}

.ssh-empty-state--disconnected {
  padding: 24px 20px;
}

.ssh-empty-icon {
  width: 28px;
  height: 28px;
  color: inherit;
}

.ssh-empty-copy {
  display: grid;
  gap: 6px;
}

.ssh-empty-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

.ssh-empty-title--disconnected {
  color: var(--ssh-sidebar-text-primary);
}

.ssh-empty-desc {
  max-width: 220px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-tertiary);
}

.ssh-empty-desc--disconnected {
  color: var(--ssh-sidebar-text-muted);
}

.ssh-empty-actions {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}

.ssh-empty-actions--disconnected {
  max-width: none;
}

.ssh-button--stacked {
  width: 100%;
  padding: 7px 0;
  justify-content: center;
  gap: 6px;
}

.ssh-button--stacked svg {
  width: 13px;
  height: 13px;
}

.ssh-button--disconnected-primary {
  background: var(--ssh-sidebar-accent);
  color: #fff;
}

.ssh-button--disconnected-primary:hover {
  background: #7577f5;
}

.ssh-button--disconnected-ghost {
  background: transparent;
  color: #6b6b76;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.ssh-button--disconnected-ghost:hover {
  background: rgba(255, 255, 255, 0.04);
  color: #b0b0bc;
}

.ssh-recent-section {
  width: 100%;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px dashed color-mix(in srgb, var(--shell-divider) 80%, transparent);
}

.ssh-recent-section--disconnected {
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
}

.ssh-recent-title {
  margin-bottom: 8px;
  text-align: left;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--text-quaternary) 68%, transparent);
}

.ssh-recent-title--disconnected {
  color: var(--ssh-sidebar-text-faint);
}

.ssh-recent-empty {
  padding: 6px 8px;
  text-align: left;
  font-size: 11px;
  line-height: 1.6;
  color: var(--ssh-sidebar-text-muted);
}

.ssh-recent-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  border-radius: 6px;
  background: transparent;
  padding: 6px 8px;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.12s ease;
}

.ssh-recent-item:hover {
  background: color-mix(in srgb, var(--surface-soft) 96%, transparent);
}

.ssh-recent-item--disconnected:hover {
  background: rgba(255, 255, 255, 0.04);
}

.ssh-recent-icon {
  display: inline-flex;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 92%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--surface-soft) 92%, transparent);
  color: var(--text-tertiary);
}

.ssh-recent-icon--disconnected {
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.03);
  color: var(--ssh-sidebar-text-muted);
}

.ssh-recent-icon svg {
  width: 12px;
  height: 12px;
}

.ssh-recent-info {
  display: grid;
  min-width: 0;
  flex: 1;
}

.ssh-recent-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 500;
  color: color-mix(in srgb, var(--text-primary) 90%, transparent);
}

.ssh-recent-name--disconnected {
  color: #efeff7;
}

.ssh-recent-host {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: color-mix(in srgb, var(--text-quaternary) 72%, transparent);
}

.ssh-recent-host--disconnected {
  color: #4a4a54;
}

.ssh-recent-time {
  flex-shrink: 0;
  font-size: 10px;
  color: color-mix(in srgb, var(--text-quaternary) 58%, transparent);
}

.ssh-recent-time--disconnected {
  color: #3a3a44;
}

.ssh-connect-form {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--shell-divider);
}

.ssh-connect-form--disconnected {
  padding: 16px 12px 12px;
  border-bottom: 0;
}

.ssh-form-row {
  display: flex;
  gap: 6px;
}

.ssh-form-group {
  display: grid;
  flex: 1;
  gap: 4px;
}

.ssh-form-group.is-compact {
  flex: 0 0 70px;
}

.ssh-auth-field {
  position: relative;
}

.ssh-auth-select-trigger {
  display: flex;
  width: 100%;
  min-height: 32px;
  align-items: center;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-soft) 100%, transparent);
  padding: 0 8px;
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  outline: none;
  transition:
    border-color 120ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 120ms cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 120ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 120ms cubic-bezier(0.16, 1, 0.3, 1);
}

.ssh-auth-select-trigger:hover {
  border-color: color-mix(in srgb, var(--shell-divider) 70%, var(--text-quaternary));
  background: color-mix(in srgb, var(--surface-soft-strong) 100%, transparent);
}

.ssh-auth-select-trigger:active {
  transform: scale(0.99);
}

.ssh-auth-select-trigger:focus-visible,
.ssh-auth-select-trigger.is-open {
  border-color: color-mix(in srgb, var(--accent-strong) 72%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-strong) 30%, transparent);
}

.ssh-auth-select-leading {
  display: inline-flex;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}

.ssh-auth-select-leading svg {
  width: 14px;
  height: 14px;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.75;
}

.ssh-auth-select-copy,
.ssh-auth-option-copy {
  min-width: 0;
  flex: 1;
}

.ssh-auth-select-label,
.ssh-auth-option-label {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-auth-select-chevron {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--text-tertiary);
  stroke-width: 2;
  transition: transform 150ms cubic-bezier(0.16, 1, 0.3, 1), color 150ms cubic-bezier(0.16, 1, 0.3, 1);
}

.ssh-auth-select-trigger.is-open .ssh-auth-select-chevron {
  color: var(--text-secondary);
  transform: rotate(180deg);
}

.ssh-auth-select-menu {
  position: absolute;
  z-index: 30;
  top: calc(100% + 6px);
  right: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 76%, var(--text-quaternary));
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel-bg) 94%, var(--sidebar-bg));
  padding: 5px;
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.36),
    0 0 0 0.5px color-mix(in srgb, var(--text-primary) 6%, transparent),
    inset 0 1px 0 color-mix(in srgb, var(--text-primary) 4%, transparent);
  transform-origin: top center;
}

.ssh-auth-select-group {
  padding: 5px 8px 6px;
  color: var(--text-quaternary);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
}

.ssh-auth-option {
  display: flex;
  width: 100%;
  min-height: 28px;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 5px 8px;
  color: var(--text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  outline: none;
  transition:
    background-color 80ms cubic-bezier(0, 0, 0.2, 1),
    color 80ms cubic-bezier(0, 0, 0.2, 1);
}

.ssh-auth-option:hover,
.ssh-auth-option:focus-visible {
  background: color-mix(in srgb, var(--text-primary) 5%, transparent);
  color: var(--text-primary);
}

.ssh-auth-option.is-selected {
  background: color-mix(in srgb, var(--accent-strong) 10%, transparent);
  color: var(--text-primary);
}

.ssh-auth-option-check {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--accent-strong);
  stroke-width: 2.2;
}

.ssh-form-group>span {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-tertiary);
}

.ssh-form-group input,
.ssh-form-group select {
  width: 100%;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface-soft) 100%, transparent);
  padding: 6px 8px;
  color: var(--text-primary);
  font-size: 12px;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.ssh-form-group input::placeholder {
  color: color-mix(in srgb, var(--text-quaternary) 82%, transparent);
}

.ssh-form-group input:focus,
.ssh-form-group select:focus {
  border-color: color-mix(in srgb, var(--accent-strong) 72%, transparent);
  background: color-mix(in srgb, var(--surface-soft-strong) 100%, transparent);
}

.ssh-command-preview {
  display: grid;
  gap: 4px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface-soft) 100%, transparent);
  padding: 6px 8px;
}

.ssh-command-preview span {
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 500;
}

.ssh-command-preview code {
  overflow-wrap: anywhere;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.45;
}

.ssh-form-actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}

.ssh-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 8px;
  padding: 9px 14px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease,
    border-color 0.15s ease;
}

.ssh-button svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  display: block;
}

.ssh-button--primary {
  flex: 1;
  background: var(--accent-strong);
  color: #fff;
}

.ssh-button--primary:hover {
  background: color-mix(in srgb, var(--accent-strong) 88%, white);
}

.ssh-button--ghost {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  background: transparent;
  color: var(--text-tertiary);
}

.ssh-button--ghost:hover {
  background: var(--surface-soft);
  color: var(--text-secondary);
}

.ssh-button:disabled {
  cursor: default;
  opacity: 0.62;
}

.ssh-connect-feedback {
  border: 1px solid color-mix(in srgb, var(--accent-strong) 28%, var(--shell-divider));
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent-strong) 8%, transparent);
  padding: 7px 8px;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
}

.ssh-connect-feedback.is-error {
  border-color: color-mix(in srgb, var(--danger) 38%, var(--shell-divider));
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  color: var(--danger);
}

.ssh-path-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--shell-divider);
  font-size: 11px;
  color: var(--text-tertiary);
}

.ssh-path-breadcrumb {
  min-width: 0;
  flex: 1;
}

.ssh-path-list {
  min-width: 0;
  flex-wrap: nowrap;
  gap: 3px;
  overflow: hidden;
  font-size: 11px;
}

.ssh-path-segment {
  display: inline-flex;
  max-width: 96px;
  min-width: 0;
  align-items: center;
  background: transparent;
  padding: 0;
  color: inherit;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.15s ease;
}

.ssh-path-segment:hover:not(:disabled) {
  color: var(--text-secondary);
}

.ssh-path-segment.is-current {
  color: var(--text-primary);
  font-weight: 500;
  cursor: default;
}

.ssh-path-segment:disabled {
  cursor: default;
  opacity: 0.58;
}

.ssh-path-separator {
  opacity: 0.32;
  color: var(--text-quaternary);
}

.ssh-path-ellipsis {
  display: inline-grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 4px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
}

.ssh-path-ellipsis:hover:not(:disabled) {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ssh-path-ellipsis:disabled {
  cursor: default;
  opacity: 0.58;
}

.ssh-path-ellipsis-icon {
  width: 16px;
  height: 16px;
}

.ssh-path-menu {
  max-width: 180px;
}

.ssh-path-menu-item {
  max-width: 172px;
  font-size: 12px;
}

.ssh-path-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.ssh-path-action {
  display: inline-grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 5px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
}

.ssh-path-action:hover:not(:disabled) {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ssh-path-action:disabled {
  cursor: default;
  opacity: 0.48;
}

.ssh-path-action svg {
  width: 13px;
  height: 13px;
  stroke-width: 2;
}

.ssh-file-list,
.ssh-transfer-panel {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
}

.ssh-file-list {
  padding: 4px 0;
}

.ssh-file-list-state {
  padding: 18px 12px;
  color: var(--text-quaternary);
  font-size: 12px;
  text-align: center;
}

.ssh-file-list::-webkit-scrollbar,
.ssh-transfer-panel::-webkit-scrollbar {
  width: 4px;
}

.ssh-file-list::-webkit-scrollbar-thumb,
.ssh-transfer-panel::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--shell-divider) 100%, transparent);
}

.ssh-file-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.ssh-file-item:hover {
  background: var(--surface-soft);
}

.ssh-file-item.is-selected {
  background: color-mix(in srgb, var(--accent-strong) 14%, transparent);
}

.ssh-file-icon {
  display: inline-flex;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 13px;
}

.ssh-file-icon.is-folder {
  color: var(--accent-strong);
}

.ssh-file-icon.is-rust {
  color: #e57c52;
}

.ssh-file-icon.is-toml {
  color: var(--success);
}

.ssh-file-icon.is-markdown {
  color: #60a5fa;
}

.ssh-file-icon.is-lock,
.ssh-file-icon.is-file {
  color: var(--text-tertiary);
}

.ssh-file-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in srgb, var(--text-primary) 88%, var(--text-secondary));
  font-size: 12.5px;
}

.ssh-file-item.is-folder .ssh-file-name {
  font-weight: 500;
  color: var(--text-primary);
}

.ssh-file-meta,
.ssh-transfer-meta {
  flex-shrink: 0;
  color: var(--text-quaternary);
  font-variant-numeric: tabular-nums;
}

.ssh-file-meta {
  font-size: 10.5px;
}

.ssh-transfer-panel {
  padding: 8px 12px;
}

.ssh-transfer-empty {
  padding: 18px 10px;
  color: var(--text-quaternary);
  font-size: 11.5px;
  text-align: center;
}

.ssh-transfer-item {
  margin-bottom: 6px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 92%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-soft) 92%, transparent);
  padding: 10px;
}

.ssh-transfer-header,
.ssh-transfer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ssh-transfer-header {
  margin-bottom: 6px;
}

.ssh-transfer-footer {
  margin-top: 4px;
}

.ssh-transfer-name {
  display: flex;
  align-items: center;
  gap: 6px;
  color: color-mix(in srgb, var(--text-primary) 88%, var(--text-secondary));
  font-size: 12px;
  font-weight: 500;
}

.ssh-transfer-direction {
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 10px;
  font-weight: 600;
}

.ssh-transfer-direction.is-upload {
  background: color-mix(in srgb, var(--accent-strong) 18%, transparent);
  color: color-mix(in srgb, var(--accent-strong) 82%, white);
}

.ssh-transfer-direction.is-download {
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: color-mix(in srgb, var(--success) 86%, white);
}

.ssh-transfer-meta {
  font-size: 10.5px;
}

.ssh-transfer-meta.is-success {
  color: var(--success);
}

.ssh-transfer-meta.is-failed {
  color: var(--danger);
}

.ssh-progress-bar {
  height: 3px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--shell-divider) 88%, transparent);
}

.ssh-progress-fill {
  height: 100%;
  border-radius: inherit;
  transition: width 0.3s ease;
}

.ssh-progress-fill.is-uploading {
  width: 42% !important;
  background: linear-gradient(90deg, var(--accent-strong), color-mix(in srgb, var(--accent-strong) 72%, white));
  animation: ssh-transfer-indeterminate 1.2s cubic-bezier(0.16, 1, 0.3, 1) infinite;
}

.ssh-progress-fill.is-downloading {
  width: 42% !important;
  background: linear-gradient(90deg, #059669, var(--success));
  animation: ssh-transfer-indeterminate 1.2s cubic-bezier(0.16, 1, 0.3, 1) infinite;
}

.ssh-progress-fill.is-done {
  background: var(--success);
}

.ssh-progress-fill.is-failed {
  background: var(--danger);
}

@keyframes ssh-transfer-indeterminate {

  0% {
    transform: translateX(-120%);
  }

  100% {
    transform: translateX(260%);
  }
}

.ssh-sidebar-footer {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--shell-divider);
}

.ssh-sidebar-footer--disconnected {
  gap: 6px;
  padding: 10px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.ssh-footer-button {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface-soft) 100%, transparent);
  padding: 7px 0;
  color: var(--text-secondary);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.ssh-footer-button:hover {
  background: var(--surface-soft-strong);
  color: var(--text-primary);
}

.ssh-footer-button--disconnected {
  color: #b0b0bc;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.ssh-footer-button:disabled,
.ssh-footer-button.is-disabled,
.ssh-footer-button:disabled:hover,
.ssh-footer-button.is-disabled:hover {
  color: #3a3a44;
  background: rgba(255, 255, 255, 0.04);
  cursor: default;
  opacity: 0.6;
}

.ssh-footer-button svg {
  width: 14px;
  height: 14px;
}

.ssh-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1300;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.28);
}

.ssh-modal {
  display: grid;
  width: min(360px, calc(100vw - 32px));
  gap: 12px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 100%, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  background: color-mix(in srgb, var(--panel-bg) 96%, var(--sidebar-bg));
  box-shadow:
    0 14px 36px rgba(0, 0, 0, 0.46),
    inset 0 1px 0 color-mix(in srgb, var(--text-primary) 5%, transparent);
  padding: 16px;
}

.ssh-modal.is-danger {
  border-color: color-mix(in srgb, var(--danger) 34%, var(--shell-divider));
}

.ssh-preview-modal {
  width: min(760px, calc(100vw - 32px));
  max-height: min(720px, calc(100vh - 48px));
}

.ssh-preview-body {
  min-height: 220px;
  max-height: 520px;
  overflow: auto;
  border: 1px solid var(--shell-divider);
  border-radius: 6px;
  background: var(--panel-bg);
}

.ssh-preview-body pre {
  margin: 0;
  padding: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-primary);
}

.ssh-modal-copy {
  display: grid;
  gap: 4px;
}

.ssh-modal-copy h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.ssh-modal-copy p {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.55;
}

.ssh-modal-field {
  display: grid;
  gap: 6px;
}

.ssh-modal-field span {
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 500;
}

.ssh-modal-field input {
  height: 30px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface-soft) 100%, transparent);
  padding: 0 9px;
  color: var(--text-primary);
  font: inherit;
  outline: none;
}

.ssh-modal-field input:focus {
  border-color: color-mix(in srgb, var(--accent-strong) 72%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-strong) 24%, transparent);
}

.ssh-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.ssh-modal-button {
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 0 11px;
  color: var(--text-tertiary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.ssh-modal-button:hover:not(:disabled) {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ssh-modal-button.is-primary {
  background: var(--accent-strong);
  color: #fff;
}

.ssh-modal-button.is-danger {
  background: var(--danger);
  color: #fff;
}

.ssh-modal-button:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}
</style>
