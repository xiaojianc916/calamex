#!/usr/bin/env node
// fix-terminal-deadcode.mjs
// 用途：删除终端模块前端两类纯死代码
//   #2 全局 terminal:state-changed 事件传输层（eventBus.ts + facade.ts）
//   #8 store/terminal.ts 中从未被调用的 markSwitchingToRun / markSwitchingToIdle
// 保留：applyStateChanged / state / isRunning / onSessionStateChanged 全链路。
//
// 用法（在仓库根目录 D:\com.xiaojianc\my_desktop_app 运行）：
//   node fix-terminal-deadcode.mjs            # dry-run，只预览
//   node fix-terminal-deadcode.mjs --write    # 实际写入
//   node fix-terminal-deadcode.mjs <repoRoot> --write
//
// 特性：幂等（重复运行安全）；任一必需锚点匹配不到则该文件不写并报错；不产生备份文件。
// 改完务必：pnpm tsc --noEmit && pnpm test （脚本会列出仍需手动更新的残留引用）。

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const ROOT = (() => {
  const a = args.find((x) => !x.startsWith('--'));
  return a ? path.resolve(a) : process.cwd();
})();

const L = (...lines) => lines.join('\n');
const occurrences = (hay, needle) => (needle === '' ? 0 : hay.split(needle).length - 1);

// 每个文件：edits = [{ id, find, replace }]；markersAbsent = 成功后必须全部消失的唯一标记
const FILES = [
  {
    rel: 'src/services/terminal/eventBus.ts',
    label: '#2 eventBus 全局 state-changed 传输层',
    markersAbsent: [
      'ITerminalStateChangedPayload',
      'terminalStateChangedEventSchema',
      'stateChangedHandlers',
      'TERMINAL_STATE_CHANGED_EVENT',
    ],
    edits: [
      {
        id: 'import-type',
        find: L("  ITerminalStateChangedPayload,", "} from '@/types/terminal';"),
        replace: "} from '@/types/terminal';",
      },
      {
        id: 'event-const',
        find: L("const TERMINAL_STATE_CHANGED_EVENT = 'terminal:state-changed';", ""),
        replace: '',
      },
      {
        id: 'schema',
        find: L(
          'const terminalStateChangedEventSchema = z.object({',
          '  from: terminalRuntimeStateSchema,',
          '  to: terminalRuntimeStateSchema,',
          '  atMs: z.number().int().nonnegative(),',
          '});',
          '',
          '',
        ),
        replace: '',
      },
      {
        id: 'interface-method',
        find: L('  onStateChanged(handler: TEventHandler<ITerminalStateChangedPayload>): UnlistenFn;', ''),
        replace: '',
      },
      {
        id: 'handlers-set',
        find: L('  const stateChangedHandlers = new Set<TEventHandler<ITerminalStateChangedPayload>>();', ''),
        replace: '',
      },
      {
        id: 'start-wireListener',
        find: L(
          '        wireListener(',
          '          TERMINAL_STATE_CHANGED_EVENT,',
          '          terminalStateChangedEventSchema,',
          '          stateChangedHandlers,',
          '        ),',
          '',
        ),
        replace: '',
      },
      {
        id: 'returned-method',
        find: L(
          '    onStateChanged(handler) {',
          '      stateChangedHandlers.add(handler);',
          '      return () => removeHandler(stateChangedHandlers, handler);',
          '    },',
          '',
        ),
        replace: '',
      },
    ],
  },
  {
    rel: 'src/services/terminal/facade.ts',
    label: '#2 facade onStateChanged 订阅',
    markersAbsent: ['eventBus.onStateChanged'],
    edits: [
      {
        id: 'facade-onStateChanged-listener',
        find: L(
          '    listeners.add(',
          '      eventBus.onStateChanged((payload) => {',
          '        runtimeStore.applyStateChanged(payload);',
          '        if (switchingInputBuffer.length > 0 && routeInput(currentSessionState(), activeRun.value)) {',
          '          void flushSwitchingInputBuffer();',
          '        }',
          '      }),',
          '    );',
          '',
        ),
        replace: '',
      },
    ],
  },
  {
    rel: 'src/store/terminal.ts',
    label: '#8 store 死方法 markSwitchingToRun / markSwitchingToIdle',
    markersAbsent: ['markSwitchingToRun', 'markSwitchingToIdle'],
    edits: [
      {
        id: 'method-markSwitchingToRun',
        find: L(
          '  const markSwitchingToRun = (): void => {',
          "    state.value = 'switching_to_run';",
          "    markEvent('terminal:switching-to-run');",
          '  };',
          '',
          '',
        ),
        replace: '',
      },
      {
        id: 'method-markSwitchingToIdle',
        find: L(
          '  const markSwitchingToIdle = (): void => {',
          '    if (!activeRun.value) return;',
          "    state.value = 'switching_to_idle';",
          "    markEvent('terminal:switching-to-idle');",
          '  };',
          '',
          '',
        ),
        replace: '',
      },
      { id: 'return-markSwitchingToRun', find: L('    markSwitchingToRun,', ''), replace: '' },
      { id: 'return-markSwitchingToIdle', find: L('    markSwitchingToIdle,', ''), replace: '' },
    ],
  },
];

// 全仓扫描：这些 token 出现在“非本次编辑文件”里 = 需要你手动跟进（旧测试 / 调用点 / #11）
const SCAN_TOKENS = [
  '.onStateChanged(',
  'ITerminalStateChangedPayload',
  'terminalStateChangedEventSchema',
  'stateChangedHandlers',
  'TERMINAL_STATE_CHANGED_EVENT',
  'terminal:state-changed',
  'markSwitchingToRun',
  'markSwitchingToIdle',
];
const SCAN_DIRS = ['src', 'src-tauri/src'];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.vue', '.rs']);
const SKIP_DIR = new Set(['node_modules', 'target', 'dist', '.git']);

let hadError = false;
let changedCount = 0;

console.log('repo root: ' + ROOT);
console.log('mode     : ' + (WRITE ? 'WRITE' : 'DRY-RUN (加 --write 才会写盘)'));
console.log('');

for (const file of FILES) {
  const abs = path.join(ROOT, file.rel);
  if (!fs.existsSync(abs)) {
    console.log('✗ ' + file.rel + ' —— 文件不存在，跳过');
    hadError = true;
    continue;
  }
  const original = fs.readFileSync(abs, 'utf8');
  let updated = original;
  const applied = [];

  for (const e of file.edits) {
    const n = occurrences(updated, e.find);
    if (n > 0) {
      updated = updated.split(e.find).join(e.replace);
      applied.push(e.id + ' (x' + n + ')');
    }
  }

  const remaining = file.markersAbsent.filter((m) => updated.includes(m));

  console.log('— ' + file.rel + '  [' + file.label + ']');

  if (updated === original) {
    if (remaining.length === 0) {
      console.log('  ✓ 已是修复后状态，跳过（幂等）');
    } else {
      console.log('  ✗ 失败：锚点未匹配，且死代码标记仍在: ' + remaining.join(', '));
      console.log('    （源码可能已变动，请核对 find 字符串后重试）');
      hadError = true;
    }
    console.log('');
    continue;
  }

  if (remaining.length > 0) {
    console.log('  ✗ 失败：部分编辑未应用，标记仍残留: ' + remaining.join(', ') + ' —— 不写入');
    hadError = true;
    console.log('');
    continue;
  }

  console.log('  应用: ' + applied.join(', '));
  console.log('  字节: ' + original.length + ' -> ' + updated.length);
  if (WRITE) {
    fs.writeFileSync(abs, updated, 'utf8');
    console.log('  ✓ 已写入');
  } else {
    console.log('  (dry-run，未写盘)');
  }
  changedCount += 1;
  console.log('');
}

// ---- 全仓扫描残留引用 ----
const walk = (dir, out) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (!SKIP_DIR.has(ent.name)) walk(path.join(dir, ent.name), out);
    } else if (SCAN_EXTS.has(path.extname(ent.name))) {
      out.push(path.join(dir, ent.name));
    }
  }
};

const editedSet = new Set(FILES.map((f) => path.join(ROOT, f.rel)));
const scanFiles = [];
for (const d of SCAN_DIRS) walk(path.join(ROOT, d), scanFiles);

const hits = [];
for (const abs of scanFiles) {
  if (editedSet.has(abs)) continue; // 本次已处理的文件不重复报
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const tok of SCAN_TOKENS) {
      if (line.includes(tok)) {
        hits.push(path.relative(ROOT, abs) + ':' + (i + 1) + '  [' + tok + ']  ' + line.trim().slice(0, 100));
        break;
      }
    }
  });
}

console.log('================ 需手动跟进的残留引用 ================');
if (hits.length === 0) {
  console.log('（无）');
} else {
  console.log('以下文件仍引用已删的死代码符号，多为旧测试/调用点，请按方案页更新：');
  for (const h of hits) console.log('  ' + h);
  console.log('');
  console.log('提醒：facade.spec.ts 用 onStateChanged/emitStateChanged 驱动断言的用例 = 旧测试，改用 onSessionStateChanged + per-session 断言；');
  console.log('      session.ts 的 listen("terminal:state-changed") = #11，单独删除。');
}
console.log('=====================================================');
console.log('');
console.log(WRITE ? ('完成：改动 ' + changedCount + ' 个文件。') : ('预览：将改动 ' + changedCount + ' 个文件（加 --write 写盘）。'));
console.log('下一步：pnpm tsc --noEmit && pnpm test');
if (hadError) {
  console.log('注意：有文件处理失败，请看上方 ✗。');
  process.exit(1);
}