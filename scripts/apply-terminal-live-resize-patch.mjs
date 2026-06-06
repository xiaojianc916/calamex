#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const target = resolve(root, 'src/terminal/session.ts');

let source = readFileSync(target, 'utf8');
const original = source;

const fail = (label) => {
  throw new Error(`[terminal-live-resize-patch] 未找到补丁锚点：${label}`);
};

const replaceOnce = (label, oldText, newText) => {
  if (!source.includes(oldText)) fail(label);
  source = source.replace(oldText, newText);
};

const replaceRegex = (label, regex, replacer) => {
  if (!regex.test(source)) fail(label);
  source = source.replace(regex, replacer);
};

const findMatchingParen = (text, openParenIndex) => {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openParenIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const replaceTerminalOnResizeBlock = () => {
  if (source.includes('this._scheduleLiveResizePtySizeSync(cols, rows);')) {
    return;
  }

  const anchor = 'terminal.onResize(';
  const start = source.indexOf(anchor);
  if (start < 0) fail('terminal onResize throttles during shell resize');

  const openParenIndex = source.indexOf('(', start);
  const closeParenIndex = findMatchingParen(source, openParenIndex);
  if (closeParenIndex < 0) fail('terminal onResize closing paren');

  let statementEnd = closeParenIndex + 1;
  while (source[statementEnd] === ' ' || source[statementEnd] === '\t' || source[statementEnd] === '\r' || source[statementEnd] === '\n') {
    statementEnd += 1;
  }
  if (source[statementEnd] !== ';') fail('terminal onResize statement end');
  statementEnd += 1;

  const replacement = `terminal.onResize(({ cols, rows }) => {
      if (!this._didTerminalSizeChange(cols, rows)) return;
      this._markInteractiveResizeRepaintSuppression();
      if (this._isShellWindowResizing) {
        this._scheduleViewportSync({
          forceDuringResize: true,
          refresh: this._liveResizeFrameCounter % TERMINAL_LIVE_RESIZE_REFRESH_EVERY === 0,
          scrollToBottom: true,
        });
        this._scheduleLiveResizePtySizeSync(cols, rows);
        return;
      }
      this._scheduleViewportSync({ scrollToBottom: true });
      this._syncPtySize(cols, rows);
    });`;

  source = `${source.slice(0, start)}${replacement}${source.slice(statementEnd)}`;
};

if (source.includes('_syncTerminalLayoutDuringShellWindowResize')) {
  console.log('[terminal-live-resize-patch] 已应用过，无需重复执行。');
  process.exit(0);
}

// 1) 接入 shell live resize frame 事件。
replaceRegex(
  'window-resize-events import',
  /import \{\n([\s\S]*?)\} from '@\/utils\/window-resize-events';/,
  (match, imports) => {
    if (imports.includes('SHELL_WINDOW_RESIZE_FRAME_EVENT')) return match;
    const lines = imports
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const insertAt = lines.findIndex((line) => line.includes('SHELL_WINDOW_RESIZE_SETTLED_EVENT'));
    const nextLines = [...lines];
    nextLines.splice(Math.max(0, insertAt), 0, 'SHELL_WINDOW_RESIZE_FRAME_EVENT,');
    return `import {\n  ${nextLines.join('\n  ')}\n} from '@/utils/window-resize-events';`;
  },
);

// 2) 终端 live resize 时，PTY 尺寸同步不能每帧打到后端：前端 fit 每帧走，后端 resize 节流走。
replaceOnce(
  'terminal resize constants',
  "const TERMINAL_RESIZE_REPAINT_SUPPRESSION_MS = 240;\n",
  "const TERMINAL_RESIZE_REPAINT_SUPPRESSION_MS = 240;\nconst TERMINAL_LIVE_RESIZE_PTY_SYNC_DELAY_MS = 96;\nconst TERMINAL_LIVE_RESIZE_REFRESH_EVERY = 3;\n",
);

// 3) 增加 live resize 期间的轻量状态。
replaceOnce(
  'terminal live resize fields',
  "  private _layoutScrollGuardTimeoutId: number | null = null;\n",
  "  private _layoutScrollGuardTimeoutId: number | null = null;\n  private _liveResizePtySyncTimeoutId: number | null = null;\n  private _liveResizeFrameCounter = 0;\n  private _pendingLiveResizePtySize: { cols: number; rows: number } | null = null;\n",
);

// 4) detach 时必须释放节流 timer，避免组件销毁后回调触发。
replaceOnce(
  'detach clears live resize timer',
  "    this._clearLayoutScrollGuardTimeout();\n",
  "    this._clearLayoutScrollGuardTimeout();\n    this._clearLiveResizePtySyncTimeout();\n",
);

replaceOnce(
  'detach resets live resize state',
  "    this._interactiveResizeRepaintSuppressUntilMs = 0;\n    this._previousHostSize = { width: 0, height: 0 };\n",
  "    this._interactiveResizeRepaintSuppressUntilMs = 0;\n    this._liveResizeFrameCounter = 0;\n    this._pendingLiveResizePtySize = null;\n    this._previousHostSize = { width: 0, height: 0 };\n",
);

// 5) 新增 timer 清理函数。
replaceRegex(
  'insert live resize timer cleanup',
  /  private _clearLayoutScrollGuardTimeout\(\): void \{\n    if \(this\._layoutScrollGuardTimeoutId !== null\) \{\n      window\.clearTimeout\(this\._layoutScrollGuardTimeoutId\);\n      this\._layoutScrollGuardTimeoutId = null;\n    \}\n  \}\n/,
  (match) => `${match}  private _clearLiveResizePtySyncTimeout(): void {\n    if (this._liveResizePtySyncTimeoutId !== null) {\n      window.clearTimeout(this._liveResizePtySyncTimeoutId);\n      this._liveResizePtySyncTimeoutId = null;\n    }\n  }\n`,
);

// 6) resize start/frame/settled：拖拽中允许 xterm 前端轻量 fit，settled 后 flush 后端尺寸。
replaceOnce(
  'resize start live state reset',
  "  private _handleShellWindowResizeStart(): void {\n    this._isShellWindowResizing = true;\n    this._pendingLayoutAfterShellWindowResize = false;\n",
  "  private _handleShellWindowResizeStart(): void {\n    this._isShellWindowResizing = true;\n    this._pendingLayoutAfterShellWindowResize = false;\n    this._liveResizeFrameCounter = 0;\n    this._pendingLiveResizePtySize = null;\n    this._clearLiveResizePtySyncTimeout();\n",
);

replaceRegex(
  'insert live resize handlers',
  /  private _handleShellWindowResizeEnd\(\): void \{\n    const shouldRelayout = this\._pendingLayoutAfterShellWindowResize \|\| this\._hostEl !== null;\n    this\._pendingLayoutAfterShellWindowResize = shouldRelayout;\n  \}\n/,
  (match) => `${match}\n  private _handleShellWindowResizeFrame(): void {\n    if (!this._visible) return;\n    const hostEl = this._hostEl;\n    if (!hostEl) return;\n    if (!this._didHostSizeChange(hostEl.clientWidth, hostEl.clientHeight)) return;\n    this._pendingLayoutAfterShellWindowResize = true;\n    this._scheduleLiveResizeLayoutSync();\n  }\n\n  private _scheduleLiveResizeLayoutSync(): void {\n    if (this._layoutFrameId !== null) return;\n    this._layoutFrameId = requestAnimationFrame(() => {\n      this._layoutFrameId = null;\n      this._syncTerminalLayoutDuringShellWindowResize();\n    });\n  }\n\n  private _syncTerminalLayoutDuringShellWindowResize(): void {\n    const terminal = this._terminalRef.value;\n    const fitAddon = this._fitAddonRef.value;\n    const hostEl = this._hostEl;\n    if (!terminal || !fitAddon || !hostEl || !this._visible) return;\n    if (\n      hostEl.clientWidth < MIN_RENDERABLE_TERMINAL_WIDTH ||\n      hostEl.clientHeight < MIN_RENDERABLE_TERMINAL_HEIGHT\n    ) {\n      return;\n    }\n\n    try {\n      const prevCols = terminal.cols;\n      const prevRows = terminal.rows;\n      const shouldKeepViewportAtBottom =\n        this._visible && (this._isAutoFollowEnabled || this._isViewportNearBottom(terminal));\n      this._beginLayoutScrollGuard(shouldKeepViewportAtBottom);\n      this._runWithProgrammaticScrollLock(() => {\n        fitAddon.fit();\n      });\n\n      this._liveResizeFrameCounter += 1;\n      const shouldRefresh =\n        terminal.cols !== prevCols ||\n        terminal.rows !== prevRows ||\n        this._liveResizeFrameCounter % TERMINAL_LIVE_RESIZE_REFRESH_EVERY === 0;\n\n      this._scheduleViewportSync({\n        forceDuringResize: true,\n        refresh: shouldRefresh,\n        scrollToBottom: shouldKeepViewportAtBottom,\n      });\n    } catch (error) {\n      console.warn('终端 live resize 尺寸同步失败', error);\n    } finally {\n      this._endLayoutScrollGuardSoon();\n    }\n  }\n\n  private _scheduleLiveResizePtySizeSync(cols: number, rows: number): void {\n    this._pendingLiveResizePtySize = { cols, rows };\n    if (this._liveResizePtySyncTimeoutId !== null) return;\n    this._liveResizePtySyncTimeoutId = window.setTimeout(() => {\n      this._liveResizePtySyncTimeoutId = null;\n      this._flushPendingLiveResizePtySize();\n    }, TERMINAL_LIVE_RESIZE_PTY_SYNC_DELAY_MS);\n  }\n\n  private _flushPendingLiveResizePtySize(): void {\n    this._clearLiveResizePtySyncTimeout();\n    const size = this._pendingLiveResizePtySize;\n    this._pendingLiveResizePtySize = null;\n    if (!size) return;\n    this._syncPtySize(size.cols, size.rows);\n  }\n`,
);

replaceOnce(
  'settled flushes live pty size',
  "  private _handleShellWindowResizeSettled(): void {\n    this._isShellWindowResizing = false;\n    if (!this._visible) return;\n\n    const shouldRelayout = this._pendingLayoutAfterShellWindowResize || this._hostEl !== null;\n",
  "  private _handleShellWindowResizeSettled(): void {\n    this._isShellWindowResizing = false;\n    this._flushPendingLiveResizePtySize();\n    if (!this._visible) return;\n\n    const shouldRelayout = this._pendingLayoutAfterShellWindowResize || this._hostEl !== null;\n",
);

// 7) viewport sync 默认仍避免 resize 高频刷新，但 live resize 显式 force 时可以按帧轻量刷新。
replaceOnce(
  'viewport sync option type',
  "    scrollToBottom?: boolean;\n  }): void {\n",
  "    scrollToBottom?: boolean;\n    forceDuringResize?: boolean;\n  }): void {\n",
);
replaceOnce(
  'viewport sync force during resize',
  "    if (this._isShellWindowResizing) return;\n",
  "    if (this._isShellWindowResizing && !options?.forceDuringResize) return;\n",
);

// 8) shell resize 事件监听补 frame。
replaceOnce(
  'shell resize frame listener declaration',
  "      const handleShellWindowResizeEnd = (): void => {\n        this._handleShellWindowResizeEnd();\n      };\n      const handleShellWindowResizeSettled = (): void => {\n",
  "      const handleShellWindowResizeEnd = (): void => {\n        this._handleShellWindowResizeEnd();\n      };\n      const handleShellWindowResizeFrame = (): void => {\n        this._handleShellWindowResizeFrame();\n      };\n      const handleShellWindowResizeSettled = (): void => {\n",
);
replaceOnce(
  'shell resize frame listener bind',
  "      window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);\n      window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);\n      window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);\n",
  "      window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);\n      window.addEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrame);\n      window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);\n      window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);\n",
);
replaceOnce(
  'shell resize frame listener cleanup',
  "        window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);\n        window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);\n        window.removeEventListener(\n",
  "        window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);\n        window.removeEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrame);\n        window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);\n        window.removeEventListener(\n",
);

// 9) 原 xterm onResize 事件在 shell live resize 中不直接打后端 PTY，改为节流同步。
replaceTerminalOnResizeBlock();

if (source === original) {
  console.log('[terminal-live-resize-patch] 没有变更。');
  process.exit(0);
}

writeFileSync(target, source, 'utf8');
console.log('[terminal-live-resize-patch] 已更新 src/terminal/session.ts');
console.log('[terminal-live-resize-patch] 建议继续运行：pnpm typecheck && pnpm test');
