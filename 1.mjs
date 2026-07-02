// scripts/f3-remove-resize-repaint-suppression-frontend.mjs
// F3（方案B）：彻底移除「交互 resize 重绘帧丢弃」抑制的前端半边。
// 对齐行业标杆：终端永不丢 PTY 字节，直播与回放严格同源。
// 覆盖 3 文件：session.ts / session-ansi.ts / session-constants.ts。
// 安全：逐字锚点 + 计数校验；3 文件全部改完并通过才落盘（幂等、绝不半改）。
// 含反斜杠的正则常量（\\[ / \x1b）不逐字重抄，改用「无反斜杠地标区间删除」deleteRange。
import { readFileSync, writeFileSync } from 'node:fs';

const toLF = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/\r\n/g, '\n');
const files = {
  session: 'src/domains/terminal/core/session.ts',
  ansi: 'src/domains/terminal/core/session-ansi.ts',
  constants: 'src/domains/terminal/core/session-constants.ts',
};
const buf = Object.fromEntries(
  Object.entries(files).map(([k, p]) => [k, toLF(readFileSync(p, 'utf8'))]),
);
const done = [];
const countOf = (hay, needle) => hay.split(needle).length - 1;

function once(key, label, oldStr, newStr) {
  const from = toLF(oldStr);
  const n = countOf(buf[key], from);
  if (n !== 1) throw new Error(`[${key}:${label}] 期望恰好 1 处，实际 ${n} 处。`);
  buf[key] = buf[key].replace(from, toLF(newStr));
  done.push(`${key}:${label}`);
}
// 删 [start, end)：删掉 start 本身、保留 end；两者都必须唯一。用于避开含反斜杠的正文。
function deleteRange(key, label, startAnchor, endAnchor) {
  const a = toLF(startAnchor), b = toLF(endAnchor);
  if (countOf(buf[key], a) !== 1) throw new Error(`[${key}:${label}] 起点地标不唯一。`);
  if (countOf(buf[key], b) !== 1) throw new Error(`[${key}:${label}] 终点地标不唯一。`);
  const ai = buf[key].indexOf(a), bi = buf[key].indexOf(b);
  if (bi <= ai) throw new Error(`[${key}:${label}] 终点在起点之前。`);
  buf[key] = buf[key].slice(0, ai) + buf[key].slice(bi);
  done.push(`${key}:${label}`);
}

// ── session.ts ──
once('session', 'import-ansi',
`import {
  isLikelyInteractiveResizeRepaintFrame,
  previewTerminalDiagnosticText,
  scanInteractiveAltScreenSwitch,
} from './session-ansi';`,
`import { previewTerminalDiagnosticText } from './session-ansi';`);

once('session', 'import-const',
`  TERMINAL_RENDERABLE_CONTENT_SCAN_ROWS,
  TERMINAL_RESIZE_REPAINT_SUPPRESSION_MS,
  TERMINAL_RUN_COMPLETED_FLUSH_TIMEOUT_MS,`,
`  TERMINAL_RENDERABLE_CONTENT_SCAN_ROWS,
  TERMINAL_RUN_COMPLETED_FLUSH_TIMEOUT_MS,`);

once('session', 'fields',
`  private _keepViewportAtBottomDuringLayout = false;
  private _interactiveAltScreenActive = false;
  private _interactiveResizeRepaintSuppressUntilMs = 0;

  // -- Private: run tracking ------------------------------------------------`,
`  private _keepViewportAtBottomDuringLayout = false;

  // -- Private: run tracking ------------------------------------------------`);

once('session', 'detach-reset',
`    this._keepViewportAtBottomDuringLayout = false;
    this._interactiveResizeRepaintSuppressUntilMs = 0;
    this._previousHostSize = { width: 0, height: 0 };`,
`    this._keepViewportAtBottomDuringLayout = false;
    this._previousHostSize = { width: 0, height: 0 };`);

once('session', 'syncLayout-mark',
`      this._scheduleViewportSync({ scrollToBottom: shouldKeepViewportAtBottom });
      this._markInteractiveResizeRepaintSuppression();
      this._schedulePtySizeSync(terminal.cols, terminal.rows);`,
`      this._scheduleViewportSync({ scrollToBottom: shouldKeepViewportAtBottom });
      this._schedulePtySizeSync(terminal.cols, terminal.rows);`);

once('session', 'handleData-suppress',
`    if (event.payload.source === 'interactive' || !event.payload.source) {
      const wasAltScreenActive = this._interactiveAltScreenActive;
      const altScreen = scanInteractiveAltScreenSwitch(
        this._interactiveAltScreenActive,
        event.payload.data,
      );
      this._interactiveAltScreenActive = altScreen.activeAfter;
      if (
        !wasAltScreenActive &&
        !altScreen.switched &&
        this._shouldSuppressInteractiveResizeRepaint(event.payload.data, altScreen.switched)
      ) {
        this._emitBufferDiagnostic('interactive-resize-repaint-suppressed', event.payload.data);
        return;
      }
    }

    if (this._activeRunId && (event.payload.source === 'interactive' || !event.payload.source)) {`,
`    if (this._activeRunId && (event.payload.source === 'interactive' || !event.payload.source)) {`);

once('session', 'exit-reset',
`    this.session.value = null;
    this._interactiveAltScreenActive = false;
    this._interactiveResizeRepaintSuppressUntilMs = 0;
    const message =`,
`    this.session.value = null;
    const message =`);

once('session', 'methods',
`  private _markInteractiveResizeRepaintSuppression(): void {
    this._interactiveResizeRepaintSuppressUntilMs =
      Date.now() + TERMINAL_RESIZE_REPAINT_SUPPRESSION_MS;
  }

  private _shouldSuppressInteractiveResizeRepaint(
    data: string,
    hasAltScreenControl: boolean,
  ): boolean {
    if (this._interactiveAltScreenActive) return false;
    if (Date.now() > this._interactiveResizeRepaintSuppressUntilMs) return false;
    if (hasAltScreenControl) return false;
    return isLikelyInteractiveResizeRepaintFrame(data);
  }

  private _hasTerminalRenderableContent(): boolean {`,
`  private _hasTerminalRenderableContent(): boolean {`);

once('session', 'onResize-mark',
`        if (!this._didTerminalSizeChange(cols, rows)) return;
        this._markInteractiveResizeRepaintSuppression();
        this._scheduleViewportSync({ scrollToBottom: true });`,
`        if (!this._didTerminalSizeChange(cols, rows)) return;
        this._scheduleViewportSync({ scrollToBottom: true });`);

// ── session-ansi.ts（含反斜杠正则/字符串，用地标区间删除）──
deleteRange('ansi', 'regex-consts',
  'const ANSI_CSI_HOME_CURSOR_PATTERN = new RegExp(',
  '\n// ─── 导出的 ANSI helpers');
deleteRange('ansi', 'inner-helpers',
  '// ─── 内部 ANSI helpers',
  '/** 将 ANSI 转义字符替换为可读的');

// ── session-constants.ts ──
once('constants', 'suppress-ms',
`export const TERMINAL_LAYOUT_SCROLL_GUARD_RELEASE_MS = 180;
export const TERMINAL_RESIZE_REPAINT_SUPPRESSION_MS = 240;
export const TERMINAL_LIVE_RESIZE_PTY_SYNC_DELAY_MS = 96;`,
`export const TERMINAL_LAYOUT_SCROLL_GUARD_RELEASE_MS = 180;
export const TERMINAL_LIVE_RESIZE_PTY_SYNC_DELAY_MS = 96;`);

for (const [k, p] of Object.entries(files)) writeFileSync(p, buf[k]);
console.log(`✅ 前端 3 文件已改（${done.length} 处）：\n  ` + done.join('\n  '));
console.log('▶ 守卫：pnpm typecheck && pnpm lint && pnpm test');