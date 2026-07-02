/**
 * src/domains/terminal/core/session-constants.ts
 * TerminalSession 模块级常量与类型别名。
 * 从 session.ts 拆分，不含运行时逻辑。
 */

// ─── 终端尺寸默认值 ───────────────────────────────────────────────────────────

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 28;
export const MIN_RENDERABLE_TERMINAL_WIDTH = 24;
export const MIN_RENDERABLE_TERMINAL_HEIGHT = 24;

// ─── 心跳与冷启动 ─────────────────────────────────────────────────────────────

/** 前端存活心跳间隔：每个挂载中的会话周期性向后端上报存活。 */
export const TERMINAL_HEARTBEAT_INTERVAL_MS = 10_000;
/** 冷启动状态升级延迟：WSL 首次冷启动可能需十余秒，超此延迟升级文案。 */
export const TERMINAL_COLD_START_HINT_DELAY_MS = 6_000;

// ─── 布局与刷新 ───────────────────────────────────────────────────────────────

export const TERMINAL_LAYOUT_SETTLE_DELAY_MS = 72;
export const TERMINAL_OUTPUT_FLUSH_DELAY_MS = 16;
export const TERMINAL_RUN_COMPLETED_FLUSH_TIMEOUT_MS = 160;
export const TERMINAL_RUN_VISUAL_REORDER_TIMEOUT_MS = 2000;
export const TERMINAL_LAYOUT_SCROLL_GUARD_RELEASE_MS = 180;
export const TERMINAL_LIVE_RESIZE_PTY_SYNC_DELAY_MS = 96;
export const TERMINAL_LIVE_RESIZE_REFRESH_EVERY = 3;

// ─── Run 分隔符与诊断 ─────────────────────────────────────────────────────────

export const TERMINAL_RUN_SEPARATOR_PREFIX = '──── run #';
export const TERMINAL_BUFFER_DIAGNOSTIC_LINE_COUNT = 14;
export const TERMINAL_BUFFER_DIAGNOSTIC_PREVIEW_LENGTH = 160;
export const TERMINAL_BELL_VISUAL_FLASH_MS = 120;
/** 初始绘制恢复时，从游标行向上有界扫描的最大行数。 */
export const TERMINAL_RENDERABLE_CONTENT_SCAN_ROWS = 256;

// ─── 离屏写入 backlog ──────────────────────────────────────────────────────────

export const TERMINAL_HIDDEN_WRITE_BACKLOG_MAX_CHARS = 512 * 1024;
export const TERMINAL_HIDDEN_WRITE_BACKLOG_CHUNK_CHARS = 8 * 1024;
export const TERMINAL_HIDDEN_WRITE_BACKLOG_OMITTED_MARKER =
  '\r\n\x1b[90m[已省略部分离屏终端输出以保持界面流畅]\x1b[0m\r\n';

// ─── 类型别名 ─────────────────────────────────────────────────────────────────

export type TTerminalBellStyle = 'none' | 'sound' | 'visual';
export type TTerminalLayoutSyncOptions = { settle?: boolean };
