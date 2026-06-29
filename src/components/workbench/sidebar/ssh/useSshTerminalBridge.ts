import { type ComputedRef, computed } from 'vue';
import { useMessage } from '@/composables/useMessage';
import { useIntegratedTerminalControls } from '@/domains/terminal/composables/useIntegratedTerminal';
import type { SshConnectionFormValues } from '@/types/ssh/connection.schema';
import {
  DEFAULT_SSH_PORT,
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
      if (connectionForm.authMode === 'password') {
        message.info(
          'SSH 终端已打开。为避免密码误输入到本地 shell，请在终端提示出现后手动输入密码。',
        );
      }
    } catch {
      message.info('文件连接已建立，终端会话暂未打开。');
    }
  };

  return { sshCommandPreview, openTerminalSessionBestEffort };
};
