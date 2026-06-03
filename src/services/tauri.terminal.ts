import { commands } from '@/bindings/tauri';
import type { ITauriService } from '@/types/tauri';
import { measureScriptContentInput } from './tauri.ipc-metrics';
import { callSpectaCommand } from './tauri.ipc-runtime';

type TTerminalTauriService = Pick<
  ITauriService,
  | 'ensureTerminalSession'
  | 'dispatchScriptToTerminal'
  | 'writeTerminalInput'
  | 'resizeTerminalSession'
  | 'closeTerminalSession'
  | 'cancelTerminalRun'
>;

export const terminalTauriService: TTerminalTauriService = {
  ensureTerminalSession(payload) {
    return callSpectaCommand(
      {
        command: 'ensure_terminal_session',
        guardHint: '连接 WSL2 终端',
        input: payload,
      },
      () => commands.ensureTerminalSession(payload),
    );
  },

  dispatchScriptToTerminal(payload) {
    return callSpectaCommand(
      {
        command: 'dispatch_script_to_terminal',
        guardHint: '在终端中执行脚本',
        input: payload,
        measureInput: measureScriptContentInput,
      },
      () => commands.dispatchScriptToTerminal(payload),
    );
  },

  writeTerminalInput(payload) {
    return callSpectaCommand<void>(
      {
        command: 'write_terminal_input',
        guardHint: '写入终端输入',
        audit: 'none',
        input: payload,
      },
      async () => {
        await commands.writeTerminalInput(payload);
      },
    );
  },

  resizeTerminalSession(payload) {
    return callSpectaCommand<void>(
      {
        command: 'resize_terminal_session',
        guardHint: '同步终端尺寸',
        audit: 'none',
        input: payload,
      },
      async () => {
        await commands.resizeTerminalSession(payload);
      },
    );
  },

  closeTerminalSession(payload) {
    return callSpectaCommand<void>(
      {
        command: 'close_terminal_session',
        guardHint: '关闭终端会话',
        audit: 'sensitive',
        input: payload,
      },
      async () => {
        await commands.closeTerminalSession(payload);
      },
    );
  },

  cancelTerminalRun(payload) {
    return callSpectaCommand<void>(
      {
        command: 'cancel_terminal_run',
        guardHint: '取消终端脚本运行',
        audit: 'sensitive',
        input: payload,
      },
      async () => {
        await commands.cancelTerminalRun({ runId: payload.runId, mode: payload.mode ?? null });
      },
    );
  },
};
