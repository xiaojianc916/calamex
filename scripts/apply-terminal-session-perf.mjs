#!/usr/bin/env node
// scripts/apply-terminal-session-perf.mjs
// 用法（仓库根目录执行）： node scripts/apply-terminal-session-perf.mjs
// 作用：对 src/terminal/session.ts 套用前端终端热路径微优化（Item 4 前端 / 6 / 7）。
// 特性：幂等（已套用则跳过）、fail-closed（锚点匹配数≠1 即中止且不落盘）、无备份文件。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const TARGET = path.resolve('src/terminal/session.ts');

/** @type {{ name: string, marker: string, find: string, replace: string }[]} */
const edits = [
  {
    name: 'Item4-前端：新增 scanInteractiveAltScreenSwitch（替换两个旧 helper）',
    marker: 'const scanInteractiveAltScreenSwitch = (',
    find: `const hasAltScreenSwitch = (data: string): boolean => {
  ANSI_ALT_SCREEN_SWITCH_PATTERN.lastIndex = 0;
  return ANSI_ALT_SCREEN_SWITCH_PATTERN.test(data);
};

const resolveAltScreenActiveAfterData = (current: boolean, data: string): boolean => {
  let next = current;
  ANSI_ALT_SCREEN_SWITCH_PATTERN.lastIndex = 0;
  for (
    let match = ANSI_ALT_SCREEN_SWITCH_PATTERN.exec(data);
    match !== null;
    match = ANSI_ALT_SCREEN_SWITCH_PATTERN.exec(data)
  ) {
    next = match[1] === 'h';
  }
  return next;
};`,
    replace: `/**
 * 单次扫描即可同时得出：本段数据是否含 alt-screen 切换序列（switched），
 * 以及在 current 基础上应用所有切换后的最终 alt-screen 状态（activeAfter）。
 * 将同一段数据的 alt-screen 正则扫描从两遍合并为一遍。
 */
const scanInteractiveAltScreenSwitch = (
  current: boolean,
  data: string,
): { switched: boolean; activeAfter: boolean } => {
  ANSI_ALT_SCREEN_SWITCH_PATTERN.lastIndex = 0;
  let switched = false;
  let activeAfter = current;
  for (
    let match = ANSI_ALT_SCREEN_SWITCH_PATTERN.exec(data);
    match !== null;
    match = ANSI_ALT_SCREEN_SWITCH_PATTERN.exec(data)
  ) {
    switched = true;
    activeAfter = match[1] === 'h';
  }
  return { switched, activeAfter };
};`,
  },
  {
    name: 'Item4-前端：_handleDataEvent 使用单次扫描结果',
    marker: 'const altScreen = scanInteractiveAltScreenSwitch(',
    find: `      const wasAltScreenActive = this._interactiveAltScreenActive;
      const hasAltScreenControl = hasAltScreenSwitch(event.payload.data);
      this._interactiveAltScreenActive = resolveAltScreenActiveAfterData(
        this._interactiveAltScreenActive,
        event.payload.data,
      );
      if (
        !wasAltScreenActive &&
        !hasAltScreenControl &&
        this._shouldSuppressInteractiveResizeRepaint(event.payload.data)
      ) {`,
    replace: `      const wasAltScreenActive = this._interactiveAltScreenActive;
      // 单次扫描同时得出本段是否含 alt-screen 切换与应用后的最终状态，
      // 并把 switched 直接传入抑制判定，避免对同一段数据重复扫描（原先共三遍）。
      const altScreen = scanInteractiveAltScreenSwitch(
        this._interactiveAltScreenActive,
        event.payload.data,
      );
      this._interactiveAltScreenActive = altScreen.activeAfter;
      if (
        !wasAltScreenActive &&
        !altScreen.switched &&
        this._shouldSuppressInteractiveResizeRepaint(event.payload.data, altScreen.switched)
      ) {`,
  },
  {
    name: 'Item4-前端：_shouldSuppressInteractiveResizeRepaint 新签名',
    marker: 'hasAltScreenControl: boolean,',
    find: `  private _shouldSuppressInteractiveResizeRepaint(data: string): boolean {
    if (this._interactiveAltScreenActive) return false;
    if (Date.now() > this._interactiveResizeRepaintSuppressUntilMs) return false;
    if (hasAltScreenSwitch(data)) return false;
    return isLikelyInteractiveResizeRepaintFrame(data);
  }`,
    replace: `  private _shouldSuppressInteractiveResizeRepaint(
    data: string,
    hasAltScreenControl: boolean,
  ): boolean {
    if (this._interactiveAltScreenActive) return false;
    if (Date.now() > this._interactiveResizeRepaintSuppressUntilMs) return false;
    if (hasAltScreenControl) return false;
    return isLikelyInteractiveResizeRepaintFrame(data);
  }`,
  },
  {
    name: 'Item6：新增有界扫描行数常量',
    marker: 'TERMINAL_RENDERABLE_CONTENT_SCAN_ROWS',
    find: `const TERMINAL_BELL_VISUAL_FLASH_MS = 120;`,
    replace: `const TERMINAL_BELL_VISUAL_FLASH_MS = 120;
// 初始绘制恢复时，从游标行向上有界扫描的最大行数，避免大 scrollback 下线性扫整缓冲。
const TERMINAL_RENDERABLE_CONTENT_SCAN_ROWS = 256;`,
  },
  {
    name: 'Item6：_hasTerminalRenderableContent 有界扫描',
    marker: 'const firstIndex = Math.max(0, lastIndex - TERMINAL_RENDERABLE_CONTENT_SCAN_ROWS + 1);',
    find: `  private _hasTerminalRenderableContent(): boolean {
    const terminal = this._terminalRef.value;
    if (!terminal) return false;
    const buf = terminal.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line?.translateToString(true).trim().length) return true;
    }
    return false;
  }`,
    replace: `  private _hasTerminalRenderableContent(): boolean {
    const terminal = this._terminalRef.value;
    if (!terminal) return false;
    const buf = terminal.buffer.active;
    const bufferLength = buf.length;
    if (bufferLength <= 0) return false;
    // 内容必然位于游标行及其上方，从游标行向上有界扫描固定行数即可。
    const cursorLineIndex = Math.max(0, buf.baseY + buf.cursorY);
    const lastIndex = Math.min(bufferLength - 1, cursorLineIndex);
    const firstIndex = Math.max(0, lastIndex - TERMINAL_RENDERABLE_CONTENT_SCAN_ROWS + 1);
    for (let i = lastIndex; i >= firstIndex; i -= 1) {
      const line = buf.getLine(i);
      if (line?.translateToString(true).trim().length) return true;
    }
    return false;
  }`,
  },
  {
    name: 'Item7：_recoverRunVisualSeqGap 去掉 Math.min 展开',
    marker: 'let lowestPendingSeq = Number.POSITIVE_INFINITY;',
    find: `    const lowestPendingSeq = Math.min(...transaction.pending.keys());`,
    replace: `    // pending 必非空（上方已对 size === 0 提前返回）。用线性求最小取代展开式 Math.min，
    // 避免 pending 较大时把全部键展开为实参（可能触发 RangeError）；此路径仅在罕见的
    // 乱序缺口恢复定时器触发，pending 规模小，线性扫描足矣，无需在热路径维护增量最小值。
    let lowestPendingSeq = Number.POSITIVE_INFINITY;
    for (const seq of transaction.pending.keys()) {
      if (seq < lowestPendingSeq) lowestPendingSeq = seq;
    }`,
  },
];

async function main() {
  let source;
  try {
    source = await readFile(TARGET, 'utf8');
  } catch (err) {
    console.error(`✗ 无法读取 ${TARGET}：${err.message}`);
    console.error('  请确认在仓库根目录运行此脚本。');
    process.exit(1);
  }

  let next = source;
  const applied = [];
  const skipped = [];

  for (const edit of edits) {
    if (next.includes(edit.marker)) {
      skipped.push(edit.name);
      continue;
    }
    const count = next.split(edit.find).length - 1;
    if (count !== 1) {
      console.error(`✗ [${edit.name}] 预期匹配 1 处，实际 ${count} 处。已中止，未写入任何改动。`);
      console.error('  可能原因：文件已偏离预期版本，请核对后手动套用对应片段。');
      process.exit(2);
    }
    next = next.replace(edit.find, edit.replace);
    applied.push(edit.name);
  }

  // 安全护栏：套用后不应再残留旧 helper 的“调用形式”（带左括号），否则中止不落盘。
  // 注意只匹配调用点，不匹配注释里出现的名字。
  for (const staleCall of ['hasAltScreenSwitch(', 'resolveAltScreenActiveAfterData(']) {
    if (next.includes(staleCall)) {
      console.error(`✗ 套用后仍残留旧调用 "${staleCall}…"，可能存在未覆盖的调用点。已中止，未写入。`);
      process.exit(3);
    }
  }

  if (applied.length === 0) {
    console.log('• 无需改动：所有优化均已套用。');
    return;
  }
  if (next === source) {
    console.log('• 内容无变化，跳过写入。');
    return;
  }

  await writeFile(TARGET, next, 'utf8');
  console.log(`✓ 已写入 ${TARGET}`);
  for (const name of applied) console.log(`  + ${name}`);
  if (skipped.length) {
    console.log('  跳过（已存在）：');
    for (const name of skipped) console.log(`    - ${name}`);
  }
  console.log('\n下一步本机复测：');
  console.log('  pnpm lint && pnpm typecheck && pnpm test');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});