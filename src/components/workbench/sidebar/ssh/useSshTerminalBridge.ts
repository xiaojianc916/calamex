import { type ComputedRef, computed } from 'vue';
import { useIntegratedTerminalControls } from '@/composables/useIntegratedTerminal';
import { useMessage } from '@/composables/useMessage';
import type { SshConnectionFormValues } from '@/types/ssh/connection.schema';
import {
  DEFAULT_SSH_PORT,
  SSH_PASSWORD_SEND_DELAY_MS,
  SSH_TERMINAL_HOST_KEY_POLICY,
  TERMINAL_OPEN_DELAY_MS,
} from './ssh-sidebar.constants';
import { quoteShellArg } from './ssh-sidebar-text';

export interface IUseSshTerminalBridgeOptions {
  connectionForm: SshConnectionFormValues;
  emitOpenTerminal: () => void;
}

export interface IUseSshTerminalBridge {
  sshCommandPreview: ComputedRef<string>;
  openTerminalSessionBestEffort: () => Promise<void>;
}

export const useSshTerminalBridge = (
  options: IUseSshTerminalBridgeOptions,
): IUseSshTerminalBridge => {
  const { connectionForm, emitOpenTerminal } = options;
  const message = useMessage();
  const terminalControls = useIntegratedTerminalControls();

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

  const sshCommandPreview = computed(() => buildSshCommand());

  const openTerminalSessionBestEffort = async (): Promise<void> => {
    try {
      emitOpenTerminal();
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

  return { sshCommandPreview, openTerminalSessionBestEffort };
};
