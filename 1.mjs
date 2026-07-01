// fix-terminal-orphaned-resize-events.mjs
// 清除 Phase B 遗留：session.ts / terminal-write-buffer.ts 中对已删除
// @/utils/window/window-resize-events 的孤儿依赖（事件派发端早已移除，此为死代码）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const p = (rel) => resolve(root, rel);
const readLF = (rel) => {
  const abs = p(rel);
  if (!existsSync(abs)) throw new Error(`[缺失] ${rel} 不存在（是否在仓库根目录运行？）`);
  return readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
};

const SESSION = "src/domains/terminal/core/session.ts";
const WBUFFER = "src/domains/terminal/core/terminal-write-buffer.ts";

const patches = [
  {
    file: SESSION,
    edits: [
      // S1: 删除对已删模块的 import
      {
        old:
`import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window/window-resize-events';
import { RunVisualSequencer } from './run-visual-sequencer';`,
        new: `import { RunVisualSequencer } from './run-visual-sequencer';`,
      },
      // S-const: 删除仅被 live-resize 用到的两个常量导入
      {
        old:
`  TERMINAL_LAYOUT_SETTLE_DELAY_MS,
  TERMINAL_LIVE_RESIZE_PTY_SYNC_DELAY_MS,
  TERMINAL_LIVE_RESIZE_REFRESH_EVERY,
  TERMINAL_RENDERABLE_CONTENT_SCAN_ROWS,`,
        new:
`  TERMINAL_LAYOUT_SETTLE_DELAY_MS,
  TERMINAL_RENDERABLE_CONTENT_SCAN_ROWS,`,
      },
      // S2: 写缓冲依赖去掉 isShellWindowResizing
      {
        old:
`      isVisible: () => this._visible,
      isShellWindowResizing: () => this._isShellWindowResizing,
      getThemeMode: () => this._theme,`,
        new:
`      isVisible: () => this._visible,
      getThemeMode: () => this._theme,`,
      },
      // S3a: 字段 _shellWindowResizeCleanup
      {
        old:
`  private _windowResizeCleanup: (() => void) | null = null;
  private _shellWindowResizeCleanup: (() => void) | null = null;
  private _resizeObserver: ResizeObserver | null = null;`,
        new:
`  private _windowResizeCleanup: (() => void) | null = null;
  private _resizeObserver: ResizeObserver | null = null;`,
      },
      // S3b: 字段 live-resize 三件套
      {
        old:
`  private _layoutScrollGuardTimeoutId: number | null = null;
  private _liveResizePtySyncTimeoutId: number | null = null;
  private _liveResizeFrameCounter = 0;
  private _pendingLiveResizePtySize: { cols: number; rows: number } | null = null;`,
        new:
`  private _layoutScrollGuardTimeoutId: number | null = null;`,
      },
      // S3c: 字段 _isShellWindowResizing / _pendingLayoutAfterShellWindowResize
      {
        old:
`  private _pendingLayoutSettleSync = false;
  private _isShellWindowResizing = false;
  private _pendingLayoutAfterShellWindowResize = false;`,
        new:
`  private _pendingLayoutSettleSync = false;`,
      },
      // S4a: detach 去掉 shellWindowResizeCleanup 调用
      {
        old:
`    this._windowResizeCleanup?.();
    this._shellWindowResizeCleanup?.();
    this._windowFocusCleanup?.();`,
        new:
`    this._windowResizeCleanup?.();
    this._windowFocusCleanup?.();`,
      },
      // S4b: detach 去掉 _clearLiveResizePtySyncTimeout 调用
      {
        old:
`    this._clearLayoutScrollGuardTimeout();
    this._clearLiveResizePtySyncTimeout();

    this._writeBuffer.reset();`,
        new:
`    this._clearLayoutScrollGuardTimeout();

    this._writeBuffer.reset();`,
      },
      // S4c: detach 去掉 live-resize 状态复位
      {
        old:
`    this._keepViewportAtBottomDuringLayout = false;
    this._interactiveResizeRepaintSuppressUntilMs = 0;
    this._liveResizeFrameCounter = 0;
    this._pendingLiveResizePtySize = null;
    this._previousHostSize = { width: 0, height: 0 };`,
        new:
`    this._keepViewportAtBottomDuringLayout = false;
    this._interactiveResizeRepaintSuppressUntilMs = 0;
    this._previousHostSize = { width: 0, height: 0 };`,
      },
      // S5: 删除 _clearLiveResizePtySyncTimeout 方法
      {
        old:
`  private _clearLiveResizePtySyncTimeout(): void {
    if (this._liveResizePtySyncTimeoutId !== null) {
      window.clearTimeout(this._liveResizePtySyncTimeoutId);
      this._liveResizePtySyncTimeoutId = null;
    }
  }
  private _clearProgrammaticScrollReleaseFrame(): void {`,
        new:
`  private _clearProgrammaticScrollReleaseFrame(): void {`,
      },
      // S6: 删除全部 shell-window-resize 处理方法（保留分区注释）
      {
        old:
`  private _handleShellWindowResizeStart(): void {
    this._isShellWindowResizing = true;
    this._pendingLayoutAfterShellWindowResize = false;
    this._liveResizeFrameCounter = 0;
    this._pendingLiveResizePtySize = null;
    this._clearLiveResizePtySyncTimeout();
    this._clearLayoutFrame();
    this._clearLayoutSettleTimeout();
    this._clearViewportFrame();
  }

  private _handleShellWindowResizeEnd(): void {
    const shouldRelayout = this._pendingLayoutAfterShellWindowResize || this._hostEl !== null;
    this._pendingLayoutAfterShellWindowResize = shouldRelayout;
  }

  private _handleShellWindowResizeFrame(): void {
    if (!this._visible) return;
    const hostEl = this._hostEl;
    if (!hostEl) return;
    if (!this._didHostSizeChange(hostEl.clientWidth, hostEl.clientHeight)) return;
    this._pendingLayoutAfterShellWindowResize = true;
    this._scheduleLiveResizeLayoutSync();
  }

  private _scheduleLiveResizeLayoutSync(): void {
    if (this._layoutFrameId !== null) return;
    this._layoutFrameId = requestAnimationFrame(() => {
      this._layoutFrameId = null;
      this._syncTerminalLayoutDuringShellWindowResize();
    });
  }

  private _syncTerminalLayoutDuringShellWindowResize(): void {
    const terminal = this._terminalRef.value;
    const fitAddon = this._fitAddonRef.value;
    const hostEl = this._hostEl;
    if (!terminal || !fitAddon || !hostEl || !this._visible) return;
    if (
      hostEl.clientWidth < MIN_RENDERABLE_TERMINAL_WIDTH ||
      hostEl.clientHeight < MIN_RENDERABLE_TERMINAL_HEIGHT
    )
      return;

    try {
      const prevCols = terminal.cols;
      const prevRows = terminal.rows;
      const shouldKeepViewportAtBottom =
        this._visible && (this._isAutoFollowEnabled || this._isViewportNearBottom(terminal));
      this._beginLayoutScrollGuard(shouldKeepViewportAtBottom);
      this._runWithProgrammaticScrollLock(() => fitAddon.fit());

      this._liveResizeFrameCounter += 1;
      const shouldRefresh =
        terminal.cols !== prevCols ||
        terminal.rows !== prevRows ||
        this._liveResizeFrameCounter % TERMINAL_LIVE_RESIZE_REFRESH_EVERY === 0;

      this._scheduleViewportSync({
        forceDuringResize: true,
        refresh: shouldRefresh,
        scrollToBottom: shouldKeepViewportAtBottom,
      });
    } catch (error) {
      terminalLogger.warn('终端 live resize 尺寸同步失败', error);
    } finally {
      this._endLayoutScrollGuardSoon();
    }
  }

  private _scheduleLiveResizePtySizeSync(cols: number, rows: number): void {
    this._pendingLiveResizePtySize = { cols, rows };
    if (this._liveResizePtySyncTimeoutId !== null) return;
    this._liveResizePtySyncTimeoutId = window.setTimeout(() => {
      this._liveResizePtySyncTimeoutId = null;
      this._flushPendingLiveResizePtySize();
    }, TERMINAL_LIVE_RESIZE_PTY_SYNC_DELAY_MS);
  }

  private _flushPendingLiveResizePtySize(): void {
    this._clearLiveResizePtySyncTimeout();
    const size = this._pendingLiveResizePtySize;
    this._pendingLiveResizePtySize = null;
    if (!size) return;
    this._syncPtySize(size.cols, size.rows);
  }

  private _handleShellWindowResizeSettled(): void {
    this._isShellWindowResizing = false;
    this._flushPendingLiveResizePtySize();
    if (!this._visible) return;

    const shouldRelayout = this._pendingLayoutAfterShellWindowResize || this._hostEl !== null;
    this._pendingLayoutAfterShellWindowResize = false;

    if (shouldRelayout) {
      this._scheduleLayoutSync({ settle: true });
      this._scheduleViewportSync({ refresh: true, scrollToBottom: true });
    }

    if (this._writeBuffer.hasPendingWrite || this._writeBuffer.hasPendingCallbacks) {
      this._writeBuffer.scheduleFlush();
    }
  }

  private _scheduleLayoutSync(options?: TTerminalLayoutSyncOptions): void {`,
        new:
`  private _scheduleLayoutSync(options?: TTerminalLayoutSyncOptions): void {`,
      },
      // S7: _scheduleLayoutSync 去掉 resize 守卫
      {
        old:
`    if (options?.settle) this._pendingLayoutSettleSync = true;
    this._clearLayoutSettleTimeout();
    if (this._isShellWindowResizing) {
      this._pendingLayoutAfterShellWindowResize = true;
      return;
    }
    if (this._layoutFrameId !== null) return;`,
        new:
`    if (options?.settle) this._pendingLayoutSettleSync = true;
    this._clearLayoutSettleTimeout();
    if (this._layoutFrameId !== null) return;`,
      },
      // S8: _syncTerminalLayout 去掉顶部 resize 守卫
      {
        old:
`  private _syncTerminalLayout(): void {
    if (this._isShellWindowResizing) {
      this._pendingLayoutAfterShellWindowResize = true;
      return;
    }

    const terminal = this._terminalRef.value;`,
        new:
`  private _syncTerminalLayout(): void {
    const terminal = this._terminalRef.value;`,
      },
      // S9: _scheduleViewportSync 去掉 forceDuringResize 选项与 resize 守卫
      {
        old:
`  private _scheduleViewportSync(options?: {
    clearTextureAtlas?: boolean;
    refresh?: boolean;
    scrollToBottom?: boolean;
    forceDuringResize?: boolean;
  }): void {
    if (options?.clearTextureAtlas) this._shouldClearTextureAtlasOnViewportSync = true;
    if (options?.refresh) this._shouldRefreshViewportOnViewportSync = true;
    if (options?.scrollToBottom) this._shouldScrollToBottomOnViewportSync = true;
    if (this._isShellWindowResizing && !options?.forceDuringResize) return;
    this._clearViewportFrame();`,
        new:
`  private _scheduleViewportSync(options?: {
    clearTextureAtlas?: boolean;
    refresh?: boolean;
    scrollToBottom?: boolean;
  }): void {
    if (options?.clearTextureAtlas) this._shouldClearTextureAtlasOnViewportSync = true;
    if (options?.refresh) this._shouldRefreshViewportOnViewportSync = true;
    if (options?.scrollToBottom) this._shouldScrollToBottomOnViewportSync = true;
    this._clearViewportFrame();`,
      },
      // S10: onResize 去掉 _isShellWindowResizing 分支
      {
        old:
`        this._markInteractiveResizeRepaintSuppression();
        if (this._isShellWindowResizing) {
          this._scheduleViewportSync({
            forceDuringResize: true,
            refresh: this._liveResizeFrameCounter % TERMINAL_LIVE_RESIZE_REFRESH_EVERY === 0,
            scrollToBottom: true,
          });
          this._scheduleLiveResizePtySizeSync(cols, rows);
          return;
        }
        this._scheduleViewportSync({ scrollToBottom: true });`,
        new:
`        this._markInteractiveResizeRepaintSuppression();
        this._scheduleViewportSync({ scrollToBottom: true });`,
      },
      // S11: _bindResizeObserver 移除 shell-window-resize 事件注册，简化观察者
      {
        old:
`    this._resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !this._didHostSizeChange(entry.contentRect.width, entry.contentRect.height))
        return;
      if (this._visible) {
        if (this._isShellWindowResizing) {
          this._pendingLayoutAfterShellWindowResize = true;
          return;
        }
        this._scheduleLayoutSync();
      }
    });
    this._resizeObserver.observe(this._hostEl);

    if (!this._shellWindowResizeCleanup) {
      const handleShellWindowResizeStart = (): void => this._handleShellWindowResizeStart();
      const handleShellWindowResizeEnd = (): void => this._handleShellWindowResizeEnd();
      const handleShellWindowResizeFrame = (): void => this._handleShellWindowResizeFrame();
      const handleShellWindowResizeSettled = (): void => this._handleShellWindowResizeSettled();
      window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
      window.addEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrame);
      window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
      window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);
      this._shellWindowResizeCleanup = () => {
        window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
        window.removeEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrame);
        window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
        window.removeEventListener(
          SHELL_WINDOW_RESIZE_SETTLED_EVENT,
          handleShellWindowResizeSettled,
        );
        this._shellWindowResizeCleanup = null;
      };
    }

    if (this._windowResizeCleanup) return;
    const handleWindowResize = (): void => {
      if (!this._visible) return;
      if (this._isShellWindowResizing) {
        this._pendingLayoutAfterShellWindowResize = true;
        return;
      }
      const el = this._hostEl;
      if (!el || !this._didHostSizeChange(el.clientWidth, el.clientHeight)) return;
      this._scheduleLayoutSync();
    };`,
        new:
`    this._resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !this._didHostSizeChange(entry.contentRect.width, entry.contentRect.height))
        return;
      if (this._visible) this._scheduleLayoutSync();
    });
    this._resizeObserver.observe(this._hostEl);

    if (this._windowResizeCleanup) return;
    const handleWindowResize = (): void => {
      if (!this._visible) return;
      const el = this._hostEl;
      if (!el || !this._didHostSizeChange(el.clientWidth, el.clientHeight)) return;
      this._scheduleLayoutSync();
    };`,
      },
    ],
  },
  {
    file: WBUFFER,
    edits: [
      // W4: 头部文档去掉对已删依赖的提及
      {
        old: ` *   - 外部状态访问器（visible、isShellWindowResizing 等）`,
        new: `     *   - 外部状态访问器（visible 等）`,
      },
      // W1: 接口成员移除
      {
        old:
`  /** 当前会话是否可见（tab 激活） */
  isVisible: () => boolean;
  /** shell 窗口是否正在 resize */
  isShellWindowResizing: () => boolean;
  /** 当前主题模式，用于 ANSI 规范化 */`,
        new:
`  /** 当前会话是否可见（tab 激活） */
  isVisible: () => boolean;
  /** 当前主题模式，用于 ANSI 规范化 */`,
      },
      // W2: flushNow 去掉 resize 守卫
      {
        old:
`    if (this._deps.isShellWindowResizing() && this._deps.isVisible()) {
      return;
    }
    if (!this._deps.isVisible()) {`,
        new:
`    if (!this._deps.isVisible()) {`,
      },
      // W3: _scheduleFlush 去掉 resize 守卫
      {
        old:
`  private _scheduleFlush(): void {
    if (this._deps.isShellWindowResizing() && this._deps.isVisible()) return;
    if (this._terminalWriteFrameId === null) {`,
        new:
`  private _scheduleFlush(): void {
    if (this._terminalWriteFrameId === null) {`,
      },
    ],
  },
];

// ---- 执行：先全量校验，任一锚点不为 1 次即整体中止 ----
function countOnce(content, old, label) {
  const n = content.split(old).length - 1;
  if (n !== 1) throw new Error(`[校验失败] ${label} 锚点出现 ${n} 次（应为 1）`);
}
for (const { file, edits } of patches) {
  let c = readLF(file);
  edits.forEach((e, i) => {
    countOnce(c, e.old, `${file} #${i + 1}`);
    c = c.replace(e.old, e.new); // 顺序校验，避免前一处改动影响后一处计数
  });
}
// ---- 应用 ----
const changed = [];
for (const { file, edits } of patches) {
  let c = readLF(file);
  for (const e of edits) c = c.replace(e.old, e.new);
  writeFileSync(p(file), c, "utf8");
  changed.push(file);
}
console.log("✅ 已清除终端孤儿 resize 事件依赖：");
for (const f of changed) console.log("  - " + f);
console.log("\n下一步： pnpm vue-tsc --noEmit && pnpm test  然后重启 pnpm tauri dev");