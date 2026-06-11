import { storeToRefs } from 'pinia';
import { ref } from 'vue';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import { useSshStore } from '@/store/ssh';
import type { ISshRecentConnection, TSshContentTab, TSshPanelTab } from '@/types/ssh';
import { DEFAULT_SSH_PORT, MANUAL_CONNECTION_ID } from './ssh-sidebar.constants';
import type { useSshConnectionForm } from './useSshConnectionForm';
import type { useSshRemoteSession } from './useSshRemoteSession';
import type { IUseSshTerminalBridge } from './useSshTerminalBridge';

interface IUseSshConnectionOptions {
  form: ReturnType<typeof useSshConnectionForm>;
  session: ReturnType<typeof useSshRemoteSession>;
  terminal: IUseSshTerminalBridge;
}

export const useSshConnection = (options: IUseSshConnectionOptions) => {
  const { form, session, terminal } = options;

  const message = useMessage();
  const sshStore = useSshStore();
  const { activeContentTab, isConnectFormVisible, isConnected } = storeToRefs(sshStore);

  const isConnecting = ref(false);
  const connectionStatusText = ref('');
  const connectionErrorText = ref('');

  const isTabActive = (tab: TSshPanelTab): boolean => {
    if (tab === 'connect') {
      return !isConnected.value || isConnectFormVisible.value;
    }
    return isConnected.value && !isConnectFormVisible.value && activeContentTab.value === tab;
  };

  const handleAuthModeChange = (nextMode: unknown): void => {
    if (!form.isAuthMode(nextMode)) return;
    form.setFieldValue('authMode', nextMode);
    form.isPasswordVisible.value = false;
    connectionErrorText.value = '';
  };

  const setContentTab = (tab: TSshContentTab): void => {
    if (!isConnected.value) return;
    activeContentTab.value = tab;
    isConnectFormVisible.value = false;
    session.closeContextMenu();
  };

  const openConnectForm = (): void => {
    isConnectFormVisible.value = true;
    session.closeContextMenu();
  };

  const toggleConnectForm = (): void => {
    isConnectFormVisible.value = !isConnectFormVisible.value;
    if (isConnected.value && !isConnectFormVisible.value) {
      activeContentTab.value = 'explorer';
    }
    session.closeContextMenu();
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
    session.closeContextMenu();
  };

  const handleConnect = async (connectionId = MANUAL_CONNECTION_ID): Promise<void> => {
    connectionErrorText.value = '';
    connectionStatusText.value = '';

    const validation = await form.validateConnection();
    if (!validation.valid) return;

    isConnecting.value = true;
    connectionStatusText.value = '正在验证 SSH 连接…';

    try {
      const connectionRequest = form.createSshConnectionTestRequest();
      const testResult = await tauriService.testSshConnection(connectionRequest);

      if (!testResult.ok) {
        connectionErrorText.value = testResult.message;
        message.error(testResult.message);
        return;
      }

      connectionStatusText.value = '正在读取远端目录…';
      form.activeSshConnectionRequest.value = connectionRequest;
      await session.loadRemoteDirectorySnapshot('.');
      try {
        await form.saveCurrentSshPassword();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '保存 SSH 密码失败。';
        message.error(`连接已成功，但保存密码失败：${errorMessage}`);
      }
      form.syncFormToStore();
      const rememberedConnectionId = sshStore.rememberCurrentConnection(connectionId);
      applyConnectionState(rememberedConnectionId);
      message.success('SSH 连接验证成功，已打开远端会话。');
      void terminal.openTerminalSessionBestEffort();
    } catch (error) {
      form.activeSshConnectionRequest.value = null;
      const errorMessage = error instanceof Error ? error.message : 'SSH 连接失败。';
      connectionErrorText.value = errorMessage;
      message.error(errorMessage);
    } finally {
      isConnecting.value = false;
      connectionStatusText.value = '';
    }
  };

  const handleConnectSubmit = form.handleVeeSubmit(async () => {
    if (isConnecting.value) return;
    await handleConnect();
  });

  const handleSelectRecentConnection = async (
    connection: ISshRecentConnection,
  ): Promise<void> => {
    sshStore.setConnectionFormFromProfile(connection);
    const stored = sshStore.connectionForm;
    form.resetForm({
      values: {
        host: stored.host ?? '',
        port: stored.port ?? DEFAULT_SSH_PORT,
        username: stored.username ?? '',
        authMode: form.isAuthMode(stored.authMode) ? stored.authMode : 'password',
        identityPath: stored.identityPath ?? '',
        password: '',
      },
    });

    if (connection.authMode === 'password') {
      try {
        const savedCredential = await tauriService.getSshPassword(
          form.createSshPasswordIdentityRequest(),
        );
        form.setFieldValue('password', savedCredential.password);
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

  const disconnectSshSession = (): void => {
    session.resetSessionState();
    form.activeSshConnectionRequest.value = null;
    sshStore.clearConnectionState();
    form.resetForm();
    sshStore.connectionForm.password = '';
    message.info('已断开 SSH 文件会话。');
  };

  return {
    isConnecting,
    connectionStatusText,
    connectionErrorText,
    isTabActive,
    handleAuthModeChange,
    setContentTab,
    openConnectForm,
    toggleConnectForm,
    handleCancelConnect,
    applyConnectionState,
    handleConnect,
    handleConnectSubmit,
    handleSelectRecentConnection,
    disconnectSshSession,
  };
};
