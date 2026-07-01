#!/usr/bin/env node
// scripts/fix-terminal-pty-resize-debounce.mjs
// 拖拽期把对 WSL 的 PTY resize IPC 去抖：xterm 视觉 fit() 每帧照常（终端实时回流不变），
// 仅 resizeTerminalSession 系统调用改为尺寸停稳后发一次终值。零 UI/行为取舍。
// 六处锚点：字段 / 常量 / 新增方法 / _syncTerminalLayout 调用点 / onResize 调用点 / detach 清理。
import { readFile, writeFile } from 'node:fs/promises';

const FILE = 'src/domains/terminal/core/session.ts';

const edits = [
  [
`  private _scrollRecoveryTimeoutId: number | null = null;
  private _layoutScrollGuardTimeoutId: number | null = null;`,
`  private _scrollRecoveryTimeoutId: number | null = null;
  private _layoutScrollGuardTimeoutId: number | null = null;
  private _ptySizeSyncTimeoutId: number | null = null;
  private _pendingPtySize: { cols: number; rows: number } | null = null;`,
    '字段声明',
  ],
  [
`const TERMINAL_MIN_ROWS = 1;
const TERMINAL_MAX_ROWS = 3000;`,
`const TERMINAL_MIN_ROWS = 1;
const TERMINAL_MAX_ROWS = 3000;

// 拖拽期把 PTY resize 系统调用去抖：xterm 视觉网格每帧照常 fit()，但对 WSL 的
// resize IPC 只在尺寸停稳后发一次终值，避免快速拖拽向 PTY 洪泛中间尺寸。
const TERMINAL_PTY_RESIZE_DEBOUNCE_MS = 120;`,
    '常量',
  ],
  [
`  private _syncPtySize(cols: number, rows: number): void {
    if (!this.session.value) return;
    void this._tauri.resizeTerminalSession({ sessionId: this.id, cols, rows }).catch((error) => {
      terminalLogger.warn('终端 PTY 尺寸同步失败', { sessionId: this.id, cols, rows, error });
    });
  }`,
`  private _syncPtySize(cols: number, rows: number): void {
    if (!this.session.value) return;
    void this._tauri.resizeTerminalSession({ sessionId: this.id, cols, rows }).catch((error) => {
      terminalLogger.warn('终端 PTY 尺寸同步失败', { sessionId: this.id, cols, rows, error });
    });
  }

  // 拖拽期去抖：视觉 fit() 每帧照常，只把对 WSL 的 resize 系统调用推迟到尺寸停稳后
  // 发一次终值（对 alt-screen 程序如 vim/htop 尤其友好，避免逐帧 SIGWINCH 重绘）。
  private _schedulePtySizeSync(cols: number, rows: number): void {
    this._pendingPtySize = { cols, rows };
    this._clearPtySizeSyncTimeout();
    this._ptySizeSyncTimeoutId = window.setTimeout(() => {
      this._ptySizeSyncTimeoutId = null;
      const pending = this._pendingPtySize;
      this._pendingPtySize = null;
      if (pending) this._syncPtySize(pending.cols, pending.rows);
    }, TERMINAL_PTY_RESIZE_DEBOUNCE_MS);
  }

  private _clearPtySizeSyncTimeout(): void {
    if (this._ptySizeSyncTimeoutId !== null) {
      window.clearTimeout(this._ptySizeSyncTimeoutId);
      this._ptySizeSyncTimeoutId = null;
    }
  }`,
    '新增去抖方法',
  ],
  [
`      this._scheduleViewportSync({ scrollToBottom: shouldKeepViewportAtBottom });
      this._markInteractiveResizeRepaintSuppression();
      this._syncPtySize(terminal.cols, terminal.rows);`,
`      this._scheduleViewportSync({ scrollToBottom: shouldKeepViewportAtBottom });
      this._markInteractiveResizeRepaintSuppression();
      this._schedulePtySizeSync(terminal.cols, terminal.rows);`,
    '_syncTerminalLayout 调用点',
  ],
  [
`      terminal.onResize(({ cols, rows }) => {
        if (!this._didTerminalSizeChange(cols, rows)) return;
        this._markInteractiveResizeRepaintSuppression();
        this._scheduleViewportSync({ scrollToBottom: true });
        this._syncPtySize(cols, rows);
      });`,
`      terminal.onResize(({ cols, rows }) => {
        if (!this._didTerminalSizeChange(cols, rows)) return;
        this._markInteractiveResizeRepaintSuppression();
        this._scheduleViewportSync({ scrollToBottom: true });
        this._schedulePtySizeSync(cols, rows);
      });`,
    'onResize 调用点',
  ],
  [
`    this._clearLayoutFrame();
    this._clearLayoutSettleTimeout();
    this._clearViewportFrame();
    this._clearProgrammaticScrollReleaseFrame();
    this._clearScrollRecoveryTimeout();
    this._clearLayoutScrollGuardTimeout();`,
`    this._clearLayoutFrame();
    this._clearLayoutSettleTimeout();
    this._clearViewportFrame();
    this._clearProgrammaticScrollReleaseFrame();
    this._clearScrollRecoveryTimeout();
    this._clearLayoutScrollGuardTimeout();
    this._clearPtySizeSyncTimeout();
    this._pendingPtySize = null;`,
    'detach 清理',
  ],
];

let src = await readFile(FILE, 'utf8');
for (const [anchor, replacement, label] of edits) {
  if (!src.includes(anchor)) {
    console.error(`[abort] 锚点未命中（${label}），文件可能已改动：${FILE}`);
    process.exit(1);
  }
  src = src.replace(anchor, replacement);
}
await writeFile(FILE, src);
console.log(`[ok] 已为拖拽期 PTY resize 加去抖：${FILE}`);