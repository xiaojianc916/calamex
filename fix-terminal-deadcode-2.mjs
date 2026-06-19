#!/usr/bin/env node
// fix-terminal-deadcode-2.mjs
// 清理 script-1 之后的 16 处残留：
//   #2/#11  facade.spec.ts  旧测试 → per-session 断言（emitSessionStateChanged + getSessionState）
//   #11     session.ts      删除已死的 terminal:state-changed 监听 / 句柄 / 字段 / 方法
//   #2 type types/index.ts  删除全局 ITerminalStateChangedPayload（已无引用）
//
// 安全前提：Batch A 已从 src-tauri 移除 emit_terminal_state_changed，后端不再发射
// terminal:state-changed，故 session.ts 的该监听为确认死代码（#11）。
//
// 用法：  node fix-terminal-deadcode-2.mjs           # 试运行（只报告，不写）
//         node fix-terminal-deadcode-2.mjs --write   # 实际写入
//
// 每个文件 all-or-nothing：任一 find 的出现次数 ≠ 预期 → 该文件整体跳过、不写、报错。

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const WRITE = process.argv.includes('--write');
const ROOT = process.cwd();

const L = (...lines) => lines.join('\n');
const occurrences = (hay, needle) => {
  if (!needle) return 0;
  let n = 0, i = hay.indexOf(needle);
  while (i !== -1) { n += 1; i = hay.indexOf(needle, i + needle.length); }
  return n;
};

// ── 文件 + 编辑定义 ──────────────────────────────────────────────────────────
const FILES = [
  {
    rel: 'src/services/terminal/facade.spec.ts',
    label: '#2/#11 旧测试改 per-session 断言',
    // 三个符号全无 → 已处理过，跳过（幂等）
    skipIf: (s) =>
      !s.includes('ITerminalStateChangedPayload') &&
      !s.includes('emitStateChanged') &&
      !s.includes('onStateChanged'),
    edits: [
      // 1) 移除类型 import 成员
      {
        id: 'import',
        count: 1,
        find: L(
          "  ITerminalSessionStateChangedPayload,",
          "  ITerminalStateChangedPayload,",
          "} from '@/types/terminal';",
        ),
        replace: L(
          "  ITerminalSessionStateChangedPayload,",
          "} from '@/types/terminal';",
        ),
      },
      // 2) Fake 去掉 stateChangedHandlers 集合
      {
        id: 'fake-set',
        count: 1,
        find: L(
          "  private readonly stateChangedHandlers = new Set<",
          "    (payload: ITerminalStateChangedPayload) => void",
          "  >();",
          "  private readonly sessionStateChangedHandlers = new Set<",
        ),
        replace: "  private readonly sessionStateChangedHandlers = new Set<",
      },
      // 3) Fake 去掉 onStateChanged 方法
      {
        id: 'fake-onStateChanged',
        count: 1,
        find: L(
          "  onStateChanged(handler: (payload: ITerminalStateChangedPayload) => void): UnlistenFn {",
          "    this.stateChangedHandlers.add(handler);",
          "    return () => {",
          "      this.stateChangedHandlers.delete(handler);",
          "    };",
          "  }",
          "",
          "  onSessionStateChanged(",
        ),
        replace: "  onSessionStateChanged(",
      },
      // 4) Fake 去掉 emitStateChanged 方法
      {
        id: 'fake-emitStateChanged',
        count: 1,
        find: L(
          "  emitStateChanged(payload: ITerminalStateChangedPayload): void {",
          "    for (const handler of this.stateChangedHandlers) {",
          "      handler(payload);",
          "    }",
          "  }",
          "",
          "  emitSessionStateChanged(payload: ITerminalSessionStateChangedPayload): void {",
        ),
        replace: "  emitSessionStateChanged(payload: ITerminalSessionStateChangedPayload): void {",
      },
      // 5) 全部调用点：emitStateChanged → emitSessionStateChanged + 注入 sessionId
      {
        id: 'emit→session-emit',
        count: 11,
        find: L(
          "    eventBus.emitStateChanged({",
          "      from:",
        ),
        replace: L(
          "    eventBus.emitSessionStateChanged({",
          "      sessionId: 'main-terminal',",
          "      from:",
        ),
      },
      // 6) case 1 注入 runtimeStore
      {
        id: 'case1-runtimeStore',
        count: 1,
        find: L(
          "    await facade.ensureView();",
          "    const handle = await facade.dispatchScript({",
        ),
        replace: L(
          "    await facade.ensureView();",
          "    const runtimeStore = useTerminalRuntimeStore();",
          "    const handle = await facade.dispatchScript({",
        ),
      },
      // 7) case 3 注入 runtimeStore
      {
        id: 'case3-runtimeStore',
        count: 1,
        find: L(
          "    await facade.ensureView();",
          "    await facade.dispatchScript({",
        ),
        replace: L(
          "    await facade.ensureView();",
          "    const runtimeStore = useTerminalRuntimeStore();",
          "    await facade.dispatchScript({",
        ),
      },
      // 8) case 4 注入 runtimeStore
      {
        id: 'case4-runtimeStore',
        count: 1,
        find: L(
          "    await facade.ensureView();",
          "    const dispatchPromise = facade.dispatchScript({",
        ),
        replace: L(
          "    await facade.ensureView();",
          "    const runtimeStore = useTerminalRuntimeStore();",
          "    const dispatchPromise = facade.dispatchScript({",
        ),
      },
      // 9) state 断言：running
      {
        id: 'assert-running',
        count: 1,
        find: "    expect(facade.state.value).toBe('running');",
        replace: "    expect(runtimeStore.getSessionState('main-terminal')).toBe('running');",
      },
      // 10) state 断言：idle_interactive（case 3 + case 4）
      {
        id: 'assert-idle',
        count: 2,
        find: "    expect(facade.state.value).toBe('idle_interactive');",
        replace:
          "    expect(runtimeStore.getSessionState('main-terminal')).toBe('idle_interactive');",
      },
      // 11) case 9 删除 stateChangedHandler 声明
      {
        id: 'case9-const',
        count: 1,
        find: L(
          "    const runStartedHandler = vi.fn();",
          "    const stateChangedHandler = vi.fn();",
          "    const interactiveReadyHandler = vi.fn();",
        ),
        replace: L(
          "    const runStartedHandler = vi.fn();",
          "    const interactiveReadyHandler = vi.fn();",
        ),
      },
      // 12) case 9 删除 onStateChanged 注册
      {
        id: 'case9-register',
        count: 1,
        find: L(
          "    eventBus.onRunStarted(runStartedHandler);",
          "    eventBus.onStateChanged(stateChangedHandler);",
          "    eventBus.onInteractiveReady(interactiveReadyHandler);",
        ),
        replace: L(
          "    eventBus.onRunStarted(runStartedHandler);",
          "    eventBus.onInteractiveReady(interactiveReadyHandler);",
        ),
      },
      // 13) case 9 删除 terminal:state-changed 派发
      {
        id: 'case9-dispatch',
        count: 1,
        find: L(
          "    handlers.get('terminal:state-changed')?.({",
          "      event: 'terminal:state-changed',",
          "      id: 3,",
          "      payload: {",
          "        from: 'switching_to_run',",
          "        to: 'running',",
          "        atMs: 1777104000001,",
          "      },",
          "    });",
          "    handlers.get('terminal:interactive-ready')?.({",
        ),
        replace: "    handlers.get('terminal:interactive-ready')?.({",
      },
      // 14) case 9 删除 stateChangedHandler 断言
      {
        id: 'case9-assert',
        count: 1,
        find: L(
          "    expect(stateChangedHandler).toHaveBeenCalledWith({",
          "      from: 'switching_to_run',",
          "      to: 'running',",
          "      atMs: 1777104000001,",
          "    });",
          "    expect(interactiveReadyHandler).toHaveBeenCalledOnce();",
        ),
        replace: "    expect(interactiveReadyHandler).toHaveBeenCalledOnce();",
      },
    ],
  },

  {
    rel: 'src/terminal/session.ts',
    label: '#11 删除死的 terminal:state-changed 监听链',
    skipIf: (s) =>
      !s.includes('ITerminalStateChangedPayload') &&
      !s.includes('_stateChangedUnlisten') &&
      !s.includes('_handleStateChangedEvent'),
    edits: [
      // import 成员
      {
        id: 'import',
        count: 1,
        find: L(
          "  ITerminalSessionPayload,",
          "  ITerminalStateChangedPayload,",
          "  ITerminalStatusChangePayload,",
        ),
        replace: L(
          "  ITerminalSessionPayload,",
          "  ITerminalStatusChangePayload,",
        ),
      },
      // 字段声明
      {
        id: 'field',
        count: 1,
        find: L(
          "  private _exitUnlisten: UnlistenFn | null = null;",
          "  private _stateChangedUnlisten: UnlistenFn | null = null;",
          "  private _eventListenerRegistration: Promise<void> | null = null;",
        ),
        replace: L(
          "  private _exitUnlisten: UnlistenFn | null = null;",
          "  private _eventListenerRegistration: Promise<void> | null = null;",
        ),
      },
      // registerEventListeners 短路守卫
      {
        id: 'guard',
        count: 1,
        find: L(
          "      this._exitUnlisten &&",
          "      this._stateChangedUnlisten",
          "    ) {",
        ),
        replace: L(
          "      this._exitUnlisten",
          "    ) {",
        ),
      },
      // Promise.all 监听数组（去掉第 4 个 listen 与 sl 解构）
      {
        id: 'listen-array',
        count: 1,
        find: L(
          "      const [dl, cl, el, sl] = await Promise.all([",
          "        listen<ITerminalDataEvent>('terminal:data', (e) => this._handleDataEvent(e)),",
          "        listen<ITerminalRunCompletedPayload>('terminal:run-completed', (e) =>",
          "          this._handleRunCompletedEvent(e),",
          "        ),",
          "        listen<ITerminalExitEvent>('terminal:interactive-exited', (e) => this._handleExitEvent(e)),",
          "        listen<ITerminalStateChangedPayload>('terminal:state-changed', (e) =>",
          "          this._handleStateChangedEvent(e),",
          "        ),",
          "      ]);",
        ),
        replace: L(
          "      const [dl, cl, el] = await Promise.all([",
          "        listen<ITerminalDataEvent>('terminal:data', (e) => this._handleDataEvent(e)),",
          "        listen<ITerminalRunCompletedPayload>('terminal:run-completed', (e) =>",
          "          this._handleRunCompletedEvent(e),",
          "        ),",
          "        listen<ITerminalExitEvent>('terminal:interactive-exited', (e) => this._handleExitEvent(e)),",
          "      ]);",
        ),
      },
      // 版本竞态清理里的 sl()
      {
        id: 'cleanup-sl',
        count: 1,
        find: L(
          "        el();",
          "        sl();",
          "        return;",
        ),
        replace: L(
          "        el();",
          "        return;",
        ),
      },
      // 赋值块里的 sl
      {
        id: 'assign-sl',
        count: 1,
        find: L(
          "      this._exitUnlisten = el;",
          "      this._stateChangedUnlisten = sl;",
          "    })().finally(() => {",
        ),
        replace: L(
          "      this._exitUnlisten = el;",
          "    })().finally(() => {",
        ),
      },
      // detach() 释放调用
      {
        id: 'detach-unlisten',
        count: 1,
        find: L(
          "    this._exitUnlisten?.();",
          "    this._stateChangedUnlisten?.();",
          "    this._dataUnlisten = null;",
        ),
        replace: L(
          "    this._exitUnlisten?.();",
          "    this._dataUnlisten = null;",
        ),
      },
      // detach() 置空
      {
        id: 'detach-null',
        count: 1,
        find: L(
          "    this._exitUnlisten = null;",
          "    this._stateChangedUnlisten = null;",
          "",
          "    this._bellUnsubscribe?.();",
        ),
        replace: L(
          "    this._exitUnlisten = null;",
          "",
          "    this._bellUnsubscribe?.();",
        ),
      },
      // 死方法 _handleStateChangedEvent
      {
        id: 'handler-method',
        count: 1,
        find: L(
          "    this._emitTerminalRunCompleted(event.payload);",
          "  }",
          "",
          "  private _handleStateChangedEvent(event: { payload: ITerminalStateChangedPayload }): void {",
          "    if (event.payload.to !== 'idle_interactive') return;",
          "    this._clearTrackedRunState();",
          "    this._interactiveResizeRepaintSuppressUntilMs = 0;",
          "  }",
          "",
          "  private _handleExitEvent(event: { payload: ITerminalExitEvent }): void {",
        ),
        replace: L(
          "    this._emitTerminalRunCompleted(event.payload);",
          "  }",
          "",
          "  private _handleExitEvent(event: { payload: ITerminalExitEvent }): void {",
        ),
      },
    ],
  },

  {
    rel: 'src/types/terminal/index.ts',
    label: '#2 删除全局 ITerminalStateChangedPayload 类型',
    skipIf: (s) => !s.includes('export interface ITerminalStateChangedPayload'),
    edits: [
      {
        id: 'remove-interface+fix-doc',
        count: 1,
        find: L(
          "  pid: number;",
          "}",
          "",
          "export interface ITerminalStateChangedPayload {",
          "  from: TTerminalRuntimeState;",
          "  to: TTerminalRuntimeState;",
          "  atMs: number;",
          "}",
          "",
          "/**",
          " * 每会话状态转移事件 (`terminal:session-state-changed`)。",
          " * 与全局 {@link ITerminalStateChangedPayload} 的区别是带 `sessionId`,",
          " * 后端按会话定向发射,前端按会话存储——P0 多会话地基。",
          " */",
        ),
        replace: L(
          "  pid: number;",
          "}",
          "",
          "/**",
          " * 每会话状态转移事件 (`terminal:session-state-changed`)：带 `sessionId`,",
          " * 后端按会话定向发射,前端按会话存储——P0 多会话地基。",
          " */",
        ),
      },
    ],
  },
];

// ── 应用 ─────────────────────────────────────────────────────────────────────
function applyEdit(content, edit) {
  const found = occurrences(content, edit.find);
  const expected = edit.count ?? 1;
  if (found !== expected) return { ok: false, found, expected, content };
  return { ok: true, found, expected, content: content.split(edit.find).join(edit.replace) };
}

console.log(`repo root: ${ROOT}`);
console.log(`mode     : ${WRITE ? 'WRITE' : 'DRY-RUN（加 --write 写入）'}\n`);

let changed = 0;
let errors = 0;

for (const file of FILES) {
  const abs = resolve(ROOT, file.rel);
  console.log(`— ${file.rel}  [${file.label}]`);
  if (!existsSync(abs)) {
    console.log('  ✗ 文件不存在，跳过\n');
    errors += 1;
    continue;
  }
  const original = readFileSync(abs, 'utf8');
  if (file.skipIf(original)) {
    console.log('  ⏭  已是目标态，跳过（幂等）\n');
    continue;
  }

  let content = original;
  const applied = [];
  let failed = null;
  for (const edit of file.edits) {
    const r = applyEdit(content, edit);
    if (!r.ok) { failed = { edit, r }; break; }
    content = r.content;
    applied.push(`${edit.id} (x${r.found})`);
  }

  if (failed) {
    console.log(
      `  ✗ 锚点不匹配：${failed.edit.id} 期望 ${failed.r.expected} 处、实际 ${failed.r.found} 处。`,
    );
    console.log('    本文件整体跳过、未写入（all-or-nothing）。\n');
    errors += 1;
    continue;
  }

  console.log(`  应用: ${applied.join(', ')}`);
  console.log(`  字节: ${original.length} -> ${content.length}`);
  if (WRITE) {
    writeFileSync(abs, content, 'utf8');
    console.log('  ✓ 已写入\n');
  } else {
    console.log('  ✓ 试运行通过（未写入）\n');
  }
  changed += 1;
}

// ── 残留扫描 ─────────────────────────────────────────────────────────────────
const SCAN_TOKENS = [
  'ITerminalStateChangedPayload',
  'terminal:state-changed',
  '.onStateChanged(',
  'emitStateChanged',
  'stateChangedHandlers',
  '_stateChangedUnlisten',
  '_handleStateChangedEvent',
];
const SCAN_DIRS = ['src', 'src-tauri/src'];
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', '.git']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|rs)$/.test(name)) yield full;
  }
}

const residuals = [];
for (const d of SCAN_DIRS) {
  const base = resolve(ROOT, d);
  if (!existsSync(base)) continue;
  for (const f of walk(base)) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const tok of SCAN_TOKENS) {
        if (line.includes(tok)) {
          residuals.push(`${f.replace(ROOT + '/', '').replace(ROOT + '\\', '')}:${i + 1}  [${tok}]  ${line.trim()}`);
        }
      }
    });
  }
}

console.log('================ 残留扫描 ================');
if (residuals.length === 0) {
  console.log('✓ 无残留：所有目标符号均已清除。');
} else {
  console.log(`仍有 ${residuals.length} 处引用（应为 0）：`);
  for (const r of residuals) console.log('  ' + r);
}
console.log('=========================================');
console.log(`\n完成：${changed} 个文件待改 / 已改，${errors} 个文件出错。`);
console.log('下一步：pnpm tsc --noEmit && pnpm test');