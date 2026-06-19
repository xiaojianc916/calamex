/**
 * src/terminal/session-types.ts
 * TerminalSession 的公共接口与内部类型。
 * 从 session.ts 拆分。
 */

import type { Ref } from 'vue';
import type { TTerminalConnectionState } from '@/types/terminal';
import type {
  ITerminalBufferDiagnostic,
  ITerminalDataEvent,
  ITerminalInputRoutePayload,
  ITerminalRunCompletedPayload,
  ITerminalSessionPayload,
  ITerminalStatusChangePayload,
  ITerminalVisualWritePayload,
  TTerminalInputRoute,
} from '@/types/terminal';

// ─── 可注入的 Tauri PTY 服务接口 ──────────────────────────────────────────────

export interface ITerminalTauriService {
  ensureTerminalSession(params: {
    sessionId: string;
    cwd: string | null;
    cols: number;
    rows: number;
  }): Promise<ITerminalSessionPayload>;
  writeTerminalInput(params: { sessionId: string; data: string }): Promise<void>;
  resizeTerminalSession(params: { sessionId: string; cols: number; rows: number }): Promise<void>;
  closeTerminalSession(params: { sessionId: string }): Promise<void>;
  /** 可选：上报会话存活心跳。注入完整 tauriService 时实现；测试 fake 可省略。 */
  heartbeatTerminalSession?(params: { sessionId: string }): Promise<void>;
}

// ─── 回调接口 ─────────────────────────────────────────────────────────────────

export interface ITerminalSessionCallbacks {
  onStatusChange?: (payload: ITerminalStatusChangePayload) => void;
  onRunCompleted?: (payload: ITerminalRunCompletedPayload) => void;
  onInputRoute?: (payload: ITerminalInputRoutePayload) => void;
  onTerminalData?: (payload: ITerminalDataEvent) => void;
  onVisualWrite?: (payload: ITerminalVisualWritePayload) => void;
  onBufferDiagnostic?: (payload: ITerminalBufferDiagnostic) => void;
  /** xterm 标题序列（OSC 0/2）变更。 */
  onTitleChange?: (title: string) => void;
}

// ─── 构造选项 ─────────────────────────────────────────────────────────────────

export interface ITerminalSessionOptions extends ITerminalSessionCallbacks {
  sessionId: string;
  tauriService: ITerminalTauriService;
  resetOrphanedBackendSession?: boolean;
  /** 由 registry 注入的外部 status ref。 */
  statusRef?: Ref<TTerminalConnectionState>;
  /** 由 registry 注入的外部 statusMessage ref。 */
  statusMessageRef?: Ref<string>;
}

// ─── 内部类型 ─────────────────────────────────────────────────────────────────

export interface IRunVisualTransaction {
  nextSeq: number;
  pending: Map<number, ITerminalDataEvent>;
  gapTimerId: number | null;
}
