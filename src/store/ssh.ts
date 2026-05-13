import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'

import type {
  ISshConnectionForm,
  ISshFileItem,
  ISshRecentConnection,
  ISshTransferItem,
  TSshAuthMode,
  TSshContentTab,
} from '@/types/ssh'

const MAX_RECENT_SSH_CONNECTIONS = 8
const DEFAULT_SSH_PORT = '22'
const MANUAL_CONNECTION_ID = 'manual'

const formatRelativeLastUsed = (timestamp: string | null): string => {
  if (!timestamp) {
    return 'SSH config'
  }

  const parsedTime = Date.parse(timestamp)
  if (Number.isNaN(parsedTime)) {
    return '最近'
  }

  const elapsedMs = Date.now() - parsedTime
  if (elapsedMs < 60_000) {
    return '刚刚'
  }

  const elapsedMinutes = Math.floor(elapsedMs / 60_000)
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} 分钟前`
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) {
    return `${elapsedHours} 小时前`
  }

  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 30) {
    return `${elapsedDays} 天前`
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(parsedTime))
}

const normalizeProfileKey = (profile: Pick<ISshRecentConnection, 'host' | 'port' | 'username'>): string =>
  `${profile.username.trim()}@${profile.host.trim()}:${profile.port.trim() || DEFAULT_SSH_PORT}`

const createManualConnectionId = (profile: Pick<ISshRecentConnection, 'host' | 'port' | 'username'>): string =>
  `manual-${normalizeProfileKey(profile).replace(/[^a-zA-Z0-9._:-]/g, '-')}`

export const useSshStore = defineStore('ssh', () => {
  const activeContentTab = ref<TSshContentTab>('explorer')
  const isConnectFormVisible = ref(false)
  const isConnected = ref(false)
  const currentConnectionId = ref<string | null>(null)
  const selectedFileId = ref('')
  const recentConnections = ref<ISshRecentConnection[]>([])
  const sshFileItems = ref<ISshFileItem[]>([])
  const transferItems = ref<ISshTransferItem[]>([])
  const currentRemotePath = ref('.')
  const connectionForm = reactive<ISshConnectionForm>({
    host: '',
    port: DEFAULT_SSH_PORT,
    username: '',
    authMode: 'password',
    identityPath: '',
    password: '',
  })

  const normalizedRecentConnections = computed<ISshRecentConnection[]>(() =>
    recentConnections.value.map((connection) => ({
      ...connection,
      lastUsedLabel: formatRelativeLastUsed(connection.lastUsedAt),
    })),
  )

  const clearRemoteSnapshot = (): void => {
    currentRemotePath.value = '.'
    sshFileItems.value = []
    selectedFileId.value = ''
  }

  const applyConnectionState = (connectionId: string | null): void => {
    currentConnectionId.value = connectionId
    isConnected.value = true
    isConnectFormVisible.value = false
    activeContentTab.value = 'explorer'
  }

  const applyPasswordTerminalState = (connectionId: string | null): void => {
    applyConnectionState(connectionId)
    clearRemoteSnapshot()
  }

  const clearConnectionState = (): void => {
    isConnected.value = false
    currentConnectionId.value = null
    isConnectFormVisible.value = false
    activeContentTab.value = 'explorer'
    clearRemoteSnapshot()
  }

  const setConnectionFormFromProfile = (connection: ISshRecentConnection): void => {
    connectionForm.host = connection.host
    connectionForm.port = connection.port
    connectionForm.username = connection.username
    connectionForm.authMode = connection.authMode
    connectionForm.identityPath = connection.identityPath
    connectionForm.password = ''
  }

  const setRecentConnections = (connections: ISshRecentConnection[]): void => {
    const seen = new Set<string>()
    recentConnections.value = connections.filter((connection) => {
      const key = normalizeProfileKey(connection)
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    }).slice(0, MAX_RECENT_SSH_CONNECTIONS)
  }

  const rememberCurrentConnection = (connectionId = MANUAL_CONNECTION_ID): string => {
    const port = connectionForm.port.trim() || DEFAULT_SSH_PORT
    const profile: ISshRecentConnection = {
      id: connectionId === MANUAL_CONNECTION_ID
        ? createManualConnectionId({
          host: connectionForm.host,
          port,
          username: connectionForm.username,
        })
        : connectionId,
      name: connectionForm.host.trim(),
      username: connectionForm.username.trim(),
      host: connectionForm.host.trim(),
      port,
      authMode: connectionForm.authMode,
      identityPath: connectionForm.authMode === 'key' ? connectionForm.identityPath.trim() : '',
      lastUsedLabel: '刚刚',
      lastUsedAt: new Date().toISOString(),
    }
    const profileKey = normalizeProfileKey(profile)
    recentConnections.value = [
      profile,
      ...recentConnections.value.filter((connection) => normalizeProfileKey(connection) !== profileKey),
    ].slice(0, MAX_RECENT_SSH_CONNECTIONS)

    return profile.id
  }

  const replacePassword = (value: string): void => {
    connectionForm.password = value
  }

  const setAuthMode = (authMode: TSshAuthMode): void => {
    connectionForm.authMode = authMode
  }

  return {
    activeContentTab,
    isConnectFormVisible,
    isConnected,
    currentConnectionId,
    selectedFileId,
    recentConnections,
    normalizedRecentConnections,
    sshFileItems,
    transferItems,
    currentRemotePath,
    connectionForm,
    applyConnectionState,
    applyPasswordTerminalState,
    clearConnectionState,
    clearRemoteSnapshot,
    setConnectionFormFromProfile,
    setRecentConnections,
    rememberCurrentConnection,
    replacePassword,
    setAuthMode,
  }
}, {
  persist: {
    key: 'shell-ide.ssh',
    pick: ['recentConnections'],
  },
})
