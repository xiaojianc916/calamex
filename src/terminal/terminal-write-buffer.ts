/**
 * src/terminal/terminal-write-buffer.ts
 * 终端写缓冲管理器 — 从 TerminalSession 类中提取的独立模块。
 *
 * 职责：
 *   - 批量积攒 xterm 写入数据，rAF/超时双通道 flush
 *   - 离屏期间的隐藏积压（hidden write backlog）与恢复回放
 *   - 管理 write-in-flight 状态与回调队列
 *
 * 设计说明：
 *   纯逻辑模块，不持有 xterm Terminal 实例引用。通过构造参数注入：
 *   - getTerminal(): Terminal | null — 惰性获取当前 xterm 实例
 *   - 外部状态访问器（visible、isShellWindowResizing 等）
 *   - 副作用回调（onWriteBefore、onWriteAfter、onViewportSync 等）
 */

import type { Terminal } from '@xterm/xterm';
import type { ITerminalDataEvent, ITerminalVisualWritePayload } from '@/types/terminal';
import { createHiddenWriteBacklog } from '@/utils/run/hidden-write-backlog';
import {
  normalizeTerminalAnsiForTheme,
  stripInjectedRunSeparatorForTerminalData,
} from './session-ansi';
import {
  TERMINAL_HIDDEN_WRITE_BACKLOG_CHUNK_CHARS,
  TERMINAL_HIDDEN_WRITE_BACKLOG_MAX_CHARS,
  TERMINAL_HIDDEN_WRITE_BACKLOG_OMITTED_MARKER,
  TERMINAL_OUTPUT_FLUSH_DELAY_MS,
} from './session-constants';

// ─── 外部依赖接口 ─────────────────────────────────────────────────────────────

/** 终端写缓冲所需的外部状态与回调 */
export interface ITerminalWriteBufferDeps {
  /** 惰性获取当前 xterm Terminal 实例 */
  getTerminal: () => Terminal | null;
  /** 当前会话是否可见（tab 激活） */
  isVisible: () => boolean;
  /** shell 窗口是否正在 resize */
  isShellWindowResizing: () => boolean;
  /** 当前主题模式，用于 ANSI 规范化 */
  getThemeMode: () => 'dark' | 'light';
  /** 是否显示 run 分隔符 */
  getShowRunSeparator: () => boolean;
  /** 外部布局同步触发器 */
  syncTerminalLayout: () => void;
  /** 外部视口同步触发器 */
  scheduleViewportSync: (options?: { scrollToBottom?: boolean; refresh?: boolean }) => void;
  /** 诊断事件回调 */
  emitBufferDiagnostic: (label: string, writePreview?: string | null) => void;
  /** 视觉写入事件回调 */
  emitVisualWrite: (payload: ITerminalVisualWritePayload) => void;
  /** 检查终端是否有可渲染内容（用于初始绘制恢复） */
  hasTerminalRenderableContent: () => boolean;
}

// ─── TerminalWriteBuffer ──────────────────────────────────────────────────────

export class TerminalWriteBuffer {
  private readonly _deps: ITerminalWriteBufferDeps;

  private readonly _bufferedTerminalWriteChunks: string[] = [];
  private _bufferedTerminalWriteLength = 0;
  private readonly _hiddenWriteBacklog = createHiddenWriteBacklog({
    maxChars: TERMINAL_HIDDEN_WRITE_BACKLOG_MAX_CHARS,
    maxChunkChars: TERMINAL_HIDDEN_WRITE_BACKLOG_CHUNK_CHARS,
    omittedMarker: TERMINAL_HIDDEN_WRITE_BACKLOG_OMITTED_MARKER,
  });
  private _pendingScrollToBottomAfterWrite = false;
  private _pendingHiddenScrollToBottom = false;
  private _shouldFitBeforeNextVisibleWrite = false;
  private _pendingInitialPaintRecovery = true;
  private readonly _pendingTerminalWriteCallbacks: Array<() => void> = [];
  private _isTerminalWriteInFlight = false;
  private _terminalWriteFrameId: number | null = null;
  private _terminalWriteTimeoutId: number | null = null;

  constructor(deps: ITerminalWriteBufferDeps) {
    this._deps = deps;
  }

  // ── 公共 API ───────────────────────────────────────────────────────────────

  get pendingWriteChars(): number {
    return this._bufferedTerminalWriteLength;
  }

  get hiddenBacklogChars(): number {
    return this._hiddenWriteBacklog.length;
  }

  get hiddenBacklogIsEmpty(): boolean {
    return this._hiddenWriteBacklog.isEmpty;
  }

  get hasPendingWrite(): boolean {
    return this._bufferedTerminalWriteLength > 0;
  }

  get hasPendingCallbacks(): boolean {
    return this._pendingTerminalWriteCallbacks.length > 0;
  }

  get isWriteInFlight(): boolean {
    return this._isTerminalWriteInFlight;
  }

  get pendingInitialPaintRecovery(): boolean {
    return this._pendingInitialPaintRecovery;
  }

  set pendingInitialPaintRecovery(value: boolean) {
    this._pendingInitialPaintRecovery = value;
  }

  /** 标记下次可见写入前需要强制 fit */
  requestFitBeforeNextVisibleWrite(): void {
    this._shouldFitBeforeNextVisibleWrite = true;
  }

  /** 当会话变为可见时，立即 flush 隐藏积压 */
  flushOnBecomeVisible(): void {
    if (!this._hiddenWriteBacklog.isEmpty) {
      this._shouldFitBeforeNextVisibleWrite = true;
      this.flushNow({ forceLayout: true });
    }
  }

  /** 排队写入数据（经 ANSI 规范化） */
  write(value: string, options?: { scrollToBottom?: boolean }): void {
    if (!value) return;
    const normalizedValue = normalizeTerminalAnsiForTheme(value, this._deps.getThemeMode());
    if (!this._deps.isVisible()) {
      this._hiddenWriteBacklog.append(normalizedValue);
      if (options?.scrollToBottom) this._pendingHiddenScrollToBottom = true;
      return;
    }
    this._appendBuffer(normalizedValue);
    if (options?.scrollToBottom) this._pendingScrollToBottomAfterWrite = true;
    this._scheduleFlush();
  }

  /** 写入终端数据事件（处理 run 分隔符与视觉写入） */
  writeDataPayload(payload: ITerminalDataEvent): void {
    const data =
      payload.source === 'injected_separator' && !this._deps.getShowRunSeparator()
        ? stripInjectedRunSeparatorForTerminalData(payload.data)
        : payload.data;
    if (!data) return;
    this._deps.emitVisualWrite({ ...payload, data });
    this.write(data, { scrollToBottom: true });
  }

  /** 立即 flush 缓冲区到 xterm（跳过 rAF/timeout） */
  flushNow(options?: { afterWrite?: () => void; forceLayout?: boolean }): void {
    if (options?.afterWrite) {
      this._pendingTerminalWriteCallbacks.push(options.afterWrite);
    }
    this._clearWriteFrame();
    this._clearWriteTimeout();
    const terminal = this._deps.getTerminal();
    if (!terminal) {
      if (!this._isTerminalWriteInFlight) this._drainCallbacks();
      return;
    }
    if (this._deps.isShellWindowResizing() && this._deps.isVisible()) {
      return;
    }
    if (!this._deps.isVisible()) {
      const bufferedWrite = this._drainBuffer();
      if (bufferedWrite) {
        this._hiddenWriteBacklog.append(bufferedWrite);
      }
      if (this._pendingScrollToBottomAfterWrite) {
        this._pendingHiddenScrollToBottom = true;
        this._pendingScrollToBottomAfterWrite = false;
      }
      return;
    }
    if (this._isTerminalWriteInFlight) return;
    if (!this._hiddenWriteBacklog.isEmpty) {
      this._prependBuffer(this._hiddenWriteBacklog.drain());
      if (this._pendingHiddenScrollToBottom) {
        this._pendingScrollToBottomAfterWrite = true;
        this._pendingHiddenScrollToBottom = false;
      }
    }
    if (!this.hasPendingWrite) {
      if (options?.forceLayout || this._shouldFitBeforeNextVisibleWrite) {
        this._deps.syncTerminalLayout();
        this._shouldFitBeforeNextVisibleWrite = false;
        this._deps.scheduleViewportSync({ scrollToBottom: true });
      }
      this._drainCallbacks();
      return;
    }
    if (options?.forceLayout || this._shouldFitBeforeNextVisibleWrite) {
      this._deps.syncTerminalLayout();
      this._shouldFitBeforeNextVisibleWrite = false;
    }
    const chunk = this._drainBuffer();
    const shouldScroll = this._pendingScrollToBottomAfterWrite;
    this._pendingScrollToBottomAfterWrite = false;
    this._isTerminalWriteInFlight = true;
    this._deps.emitBufferDiagnostic('xterm-write:before', chunk);
    terminal.write(chunk, () => {
      this._isTerminalWriteInFlight = false;
      this._deps.emitBufferDiagnostic('xterm-write:after', chunk);
      this._deps.scheduleViewportSync({ scrollToBottom: shouldScroll });
      if (this._pendingInitialPaintRecovery && this._deps.hasTerminalRenderableContent()) {
        this._pendingInitialPaintRecovery = false;
        this._deps.emitBufferDiagnostic('initial-paint-recovery:before-layout');
        this._deps.syncTerminalLayout();
        this._deps.emitBufferDiagnostic('initial-paint-recovery:after-layout');
        this._deps.scheduleViewportSync({ refresh: true, scrollToBottom: true });
      }
      if (this.hasPendingWrite) {
        this.flushNow();
        return;
      }
      this._drainCallbacks();
    });
  }

  /** 调度 rAF/timeout 双通道 flush */
  scheduleFlush(): void {
    this._scheduleFlush();
  }

  /** 重置所有缓冲状态（detach 时调用） */
  reset(): void {
    this._clearBuffer();
    this._hiddenWriteBacklog.clear();
    this._pendingTerminalWriteCallbacks.length = 0;
    this._isTerminalWriteInFlight = false;
    this._pendingScrollToBottomAfterWrite = false;
    this._pendingHiddenScrollToBottom = false;
    this._shouldFitBeforeNextVisibleWrite = false;
    this._pendingInitialPaintRecovery = true;
    this._clearWriteFrame();
    this._clearWriteTimeout();
  }

  // ── 私有方法 ────────────────────────────────────────────────────────────────

  private _appendBuffer(value: string): void {
    if (!value) return;
    this._bufferedTerminalWriteChunks.push(value);
    this._bufferedTerminalWriteLength += value.length;
  }

  private _prependBuffer(value: string): void {
    if (!value) return;
    this._bufferedTerminalWriteChunks.unshift(value);
    this._bufferedTerminalWriteLength += value.length;
  }

  private _drainBuffer(): string {
    if (this._bufferedTerminalWriteLength === 0) return '';
    if (this._bufferedTerminalWriteChunks.length === 1) {
      const value = this._bufferedTerminalWriteChunks[0] ?? '';
      this._clearBuffer();
      return value;
    }
    const value = this._bufferedTerminalWriteChunks.join('');
    this._clearBuffer();
    return value;
  }

  private _clearBuffer(): void {
    this._bufferedTerminalWriteChunks.length = 0;
    this._bufferedTerminalWriteLength = 0;
  }

  private _drainCallbacks(): void {
    if (this._pendingTerminalWriteCallbacks.length === 0) return;
    const cbs = this._pendingTerminalWriteCallbacks.splice(
      0,
      this._pendingTerminalWriteCallbacks.length,
    );
    for (const cb of cbs) {
      cb();
    }
  }

  private _scheduleFlush(): void {
    if (this._deps.isShellWindowResizing() && this._deps.isVisible()) return;
    if (this._terminalWriteFrameId === null) {
      this._terminalWriteFrameId = requestAnimationFrame(() => {
        this._terminalWriteFrameId = null;
        this.flushNow();
      });
    }
    if (this._terminalWriteTimeoutId !== null) return;
    this._terminalWriteTimeoutId = window.setTimeout(() => {
      this._terminalWriteTimeoutId = null;
      this.flushNow();
    }, TERMINAL_OUTPUT_FLUSH_DELAY_MS);
  }

  private _clearWriteFrame(): void {
    if (this._terminalWriteFrameId !== null) {
      cancelAnimationFrame(this._terminalWriteFrameId);
      this._terminalWriteFrameId = null;
    }
  }

  private _clearWriteTimeout(): void {
    if (this._terminalWriteTimeoutId !== null) {
      window.clearTimeout(this._terminalWriteTimeoutId);
      this._terminalWriteTimeoutId = null;
    }
  }
}
