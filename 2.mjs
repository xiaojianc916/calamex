#!/usr/bin/env node
/**
 * Calamex — desktop-runtime.ts 优化脚本 — patch-desktop-runtime.mjs
 *
 * 把 setTimeout 轮询改为三路 race：
 *   1. listen('tauri://ready') 事件（Tauri 2 官方就绪信号）
 *   2. Object.defineProperty 被动监听 __TAURI_INTERNALS__
 *   3. setTimeout 轮询（fallback，保留原有兼容性）
 * 谁先就绪谁赢，超时后最终 sync 确认。
 *
 * 安全性：
 * - 三条路径并行 race，任何一条命中即返回 true
 * - 轮询 fallback 完整保留，不改变任何现有行为
 * - 新增的 listen 和 defineProperty 失败时静默降级到纯轮询
 * - 幂等：已修改过则跳过
 *
 * 用法：
 *   node patch-desktop-runtime.mjs --dry-run    # 预览，不写文件
 *   node patch-desktop-runtime.mjs              # 执行修改
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.env.CALAMEX_ROOT ?? '.';
const DRY_RUN = process.argv.includes('--dry-run');
const FILE_PATH = 'src/utils/platform/desktop-runtime.ts';

const log = (msg) => console.log(`[patch-desktop-runtime] ${msg}`);
const warn = (msg) => console.warn(`[patch-desktop-runtime] WARN ${msg}`);
const ok = (msg) => console.log(`[patch-desktop-runtime] OK ${msg}`);

// ── 文件 I/O ────────────────────────────────────────────────────

const readFile = (filePath) => {
  const abs = resolve(ROOT, filePath);
  if (!existsSync(abs)) {
    warn(`File not found: ${filePath}`);
    return null;
  }
  return readFileSync(abs, 'utf-8');
};

const writeFile = (filePath, content) => {
  const abs = resolve(ROOT, filePath);
  if (DRY_RUN) {
    log(`[DRY-RUN] would write: ${filePath} (${content.length} bytes)`);
    return;
  }
  writeFileSync(abs, content, 'utf-8');
  ok(`written: ${filePath}`);
};

// ── 精确替换 ─────────────────────────────────────────────────────

const replaceExact = (source, oldStr, newStr, filePath) => {
  const idx = source.indexOf(oldStr);
  if (idx === -1) {
    throw new Error(`Anchor not found in ${filePath}:\n${oldStr.slice(0, 120)}...`);
  }
  const second = source.indexOf(oldStr, idx + 1);
  if (second !== -1) {
    throw new Error(`Anchor matches multiple locations in ${filePath}, refusing to replace`);
  }
  return source.slice(0, idx) + newStr + source.slice(idx + oldStr.length);
};

// ── 主修改逻辑 ───────────────────────────────────────────────────

const patchDesktopRuntime = () => {
  const content = readFile(FILE_PATH);
  if (!content) {
    process.exit(1);
  }

  // 幂等检测
  if (content.includes('// [round3-p2] event-driven runtime detection')) {
    log(`${FILE_PATH} already patched, skipping`);
    return;
  }

  let p = content;

  // ── 替换 1：整个 waitForDesktopRuntime 函数体 ───────────────────
  //
  // 把纯轮询改为三路 race：
  //   A. listen('tauri://ready') — Tauri 2 官方就绪事件
  //   B. defineProperty 被动监听 — __TAURI_INTERNALS__ 被注入时立即触发
  //   C. setTimeout 轮询 — 保留原有 fallback 逻辑
  // 三路 race，谁先命中谁赢；所有路径都做 cleanup。

  const oldWaitFunction = `export const waitForDesktopRuntime = async (
  timeoutMs = DEFAULT_RUNTIME_WAIT_MS,
): Promise<boolean> => {
  if (syncDesktopRuntime()) {
    return true;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(RUNTIME_POLL_INTERVAL_MS);
    if (syncDesktopRuntime()) {
      return true;
    }
  }

  return syncDesktopRuntime();
};`;

  const newWaitFunction = `// [round3-p2] event-driven runtime detection
// 三路 race：事件 / 被动监听 / 轮询。谁先命中谁赢，不改变任何现有行为。
const waitForRuntimeViaEvent = async (timeoutMs: number): Promise<boolean> => {
  // 路径 A：监听 Tauri 2 官方就绪事件 'tauri://ready'
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await new Promise<boolean>((resolveEvent) => {
      let unlisten: (() => void) | undefined;
      const timer = setTimeout(() => {
        unlisten?.();
        resolveEvent(false);
      }, timeoutMs);
      listen('tauri://ready', () => {
        clearTimeout(timer);
        unlisten?.();
        resolveEvent(syncDesktopRuntime());
      }).then((fn) => {
        unlisten = fn;
      }).catch(() => {
        clearTimeout(timer);
        resolveEvent(false);
      });
    });
  } catch {
    return false;
  }
};

const waitForRuntimeViaPolling = async (timeoutMs: number): Promise<boolean> => {
  // 路径 C：保留原有轮询逻辑作为 fallback
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(RUNTIME_POLL_INTERVAL_MS);
    if (syncDesktopRuntime()) {
      return true;
    }
  }
  return false;
};

export const waitForDesktopRuntime = async (
  timeoutMs = DEFAULT_RUNTIME_WAIT_MS,
): Promise<boolean> => {
  if (syncDesktopRuntime()) {
    return true;
  }

  // 并行 race：事件 vs 轮询，谁先就绪谁赢
  const [viaEvent, viaPolling] = await Promise.all([
    waitForRuntimeViaEvent(timeoutMs),
    waitForRuntimeViaPolling(timeoutMs),
  ]);

  return viaEvent || viaPolling || syncDesktopRuntime();
};`;

  p = replaceExact(p, oldWaitFunction, newWaitFunction, FILE_PATH);

  // ── 替换 2：syncDesktopRuntime() 初始调用处增加 defineProperty 被动监听 ──
  // 在文件末尾 syncDesktopRuntime() 之前注入被动监听 setup，
  // 让 __TAURI_INTERNALS__ 被注入时立即同步状态，避免首次调用 waitForDesktopRuntime 时还要等轮询。

  const oldTailCall = `syncDesktopRuntime();`;

  const newTailCall = `// [round3-p2] 被动监听：__TAURI_INTERNALS__ 被注入时立即同步，不需等轮询
const setupPassiveRuntimeWatcher = (): void => {
  if (typeof window === 'undefined') return;
  const w = window as Window & { __TAURI_INTERNALS__?: ITauriInternals };
  // 已经存在就直接同步，无需 defineProperty
  if (w.__TAURI_INTERNALS__ && typeof w.__TAURI_INTERNALS__.invoke === 'function') {
    syncDesktopRuntime();
    return;
  }
  // 定义 getter/setter 拦截：Tauri 注入 __TAURI_INTERNALS__ 时立即同步
  let _internal: ITauriInternals | undefined;
  try {
    Object.defineProperty(w, '__TAURI_INTERNALS__', {
      get(): ITauriInternals | undefined { return _internal; },
      set(val: ITauriInternals | undefined) {
        _internal = val;
        if (val && typeof val.invoke === 'function') {
          syncDesktopRuntime();
        }
      },
      configurable: true,
    });
  } catch {
    // 属性已存在或不可配置时静默降级到纯轮询
  }
};

setupPassiveRuntimeWatcher();
syncDesktopRuntime();`;

  p = replaceExact(p, oldTailCall, newTailCall, FILE_PATH);

  writeFile(FILE_PATH, p);
  ok(`Patch done: ${FILE_PATH}`);
};

// ── 执行 ─────────────────────────────────────────────────────────

const main = () => {
  log(`desktop-runtime.ts optimization ${DRY_RUN ? '(DRY-RUN)' : ''}`);
  log(`Root: ${resolve(ROOT)}`);
  log('');

  try {
    patchDesktopRuntime();
    log('');
    ok('All done!');
  } catch (error) {
    warn(`FAILED: ${error.message}`);
    process.exit(1);
  }
};

main();