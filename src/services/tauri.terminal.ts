import { commands } from '@/bindings/tauri';
import type { ITauriService } from '@/types/tauri';
import { type ICommandMeta, runCommand } from './tauri.ipc-define';
import { measureScriptContentInput } from './tauri.ipc-metrics';

// 终端冷启动 IPC 预算：ensure_terminal_session 在 WSL 冷启动（首次 / Windows 重启后发行版 VM 冷）
// 时可能阻塞十余秒等待 wsl.exe 拉起发行版，远超通用命令的 10s 默认超时。给它单独的宽裕预算，
// 避免冷启动被误判为超时失败；WSL 未安装 / 损坏等会 fast-fail，不受此上限影响。
const TERMINAL_COLD_START_TIMEOUT_MS = 30_000;

type TTerminalTauriService = Pick<
  ITauriService,
  | 'ensureTerminalSession'
  | 'dispatchScriptToTerminal'
  | 'writeTerminalInput'
  | 'resizeTerminalSession'
  | 'closeTerminalSession'
  | 'heartbeatTerminalSession'
  | 'cancelTerminalRun'
>;

const TERMINAL_COMMAND_META = {
  ensureTerminalSession: {
    command: 'ensure_terminal_session',
    guardHint: '连接 WSL2 终端',
    timeoutMs: TERMINAL_COLD_START_TIMEOUT_MS,
  },
  dispatchScriptToTerminal: {
    command: 'dispatch_script_to_terminal',
    guardHint: '在终端中执行脚本',
    measureInput: measureScriptContentInput,
  },
  writeTerminalInput: {
    command: 'write_terminal_input',
    guardHint: '写入终端输入',
    audit: 'none',
  },
  resizeTerminalSession: {
    command: 'resize_terminal_session',
    guardHint: '同步终端尺寸',
    audit: 'none',
  },
  closeTerminalSession: {
    command: 'close_terminal_session',
    guardHint: '关闭终端会话',
    audit: 'sensitive',
  },
  heartbeatTerminalSession: {
    command: 'heartbeat_terminal_session',
    guardHint: '上报终端会话存活心跳',
    audit: 'none',
  },
  cancelTerminalRun: {
    command: 'cancel_terminal_run',
    guardHint: '取消终端脚本运行',
    audit: 'sensitive',
  },
} satisfies Record<string, ICommandMeta>;

export const terminalTauriService: TTerminalTauriService = {
  ensureTerminalSession(payload) {
    return runCommand(TERMINAL_COMMAND_META.ensureTerminalSession, payload, undefined, () =>
      commands.ensureTerminalSession(payload),
    );
  },

  dispatchScriptToTerminal(payload) {
    return runCommand(TERMINAL_COMMAND_META.dispatchScriptToTerminal, payload, undefined, () =>
      commands.dispatchScriptToTerminal(payload),
    );
  },

  writeTerminalInput(payload) {
    return runCommand<void>(
      TERMINAL_COMMAND_META.writeTerminalInput,
      payload,
      undefined,
      async () => {
        await commands.writeTerminalInput(payload);
      },
    );
  },

  resizeTerminalSession(payload) {
    return runCommand<void>(
      TERMINAL_COMMAND_META.resizeTerminalSession,
      payload,
      undefined,
      async () => {
        await commands.resizeTerminalSession(payload);
      },
    );
  },

  closeTerminalSession(payload) {
    return runCommand<void>(
      TERMINAL_COMMAND_META.closeTerminalSession,
      payload,
      undefined,
      async () => {
        await commands.closeTerminalSession(payload);
      },
    );
  },

  heartbeatTerminalSession(payload) {
    return runCommand<void>(
      TERMINAL_COMMAND_META.heartbeatTerminalSession,
      payload,
      undefined,
      async () => {
        await commands.heartbeatTerminalSession(payload);
      },
    );
  },

  cancelTerminalRun(payload) {
    return runCommand<void>(
      TERMINAL_COMMAND_META.cancelTerminalRun,
      payload,
      undefined,
      async () => {
        await commands.cancelTerminalRun({ runId: payload.runId });
      },
    );
  },
};
