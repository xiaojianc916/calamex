#!/usr/bin/env node
// apply-fe2-tab-title.mjs
// FE-2 收尾：把 xterm 标题序列（OSC 0/2）接到终端 tab 标题。
// 对照 VSCode TerminalInstance 的 xterm.raw.onTitleChange。
// 本地跑：node apply-fe2-tab-title.mjs && pnpm vue-tsc --noEmit && pnpm vitest run
import { readFileSync, writeFileSync } from 'node:fs';

/** @type {{file:string, edits:{find:string, replace:string}[]}[]} */
const groups = [
  {
    file: 'src/store/terminalTabs.ts',
    edits: [
      {
        find:
`  const setTabTitle = (sessionId: string, title: string): void => {
    const tab = tabs.value.find((item) => item.sessionId === sessionId);
    if (tab && title.trim()) tab.title = title;
  };`,
        replace:
`  const setTabTitle = (sessionId: string, title: string): void => {
    const tab = tabs.value.find((item) => item.sessionId === sessionId);
    const next = title.trim();
    if (tab && next && tab.title !== next) tab.title = next;
  };`,
      },
    ],
  },
  {
    file: 'src/terminal/session.ts',
    edits: [
      {
        find:
`  onVisualWrite?: (payload: ITerminalVisualWritePayload) => void;
  onBufferDiagnostic?: (payload: ITerminalBufferDiagnostic) => void;
}`,
        replace:
`  onVisualWrite?: (payload: ITerminalVisualWritePayload) => void;
  onBufferDiagnostic?: (payload: ITerminalBufferDiagnostic) => void;
  /** xterm 标题序列（OSC 0/2）变更：默认 WSL bash 写「user@host: <cwd>」，前台程序写运行命令。对照 VSCode TerminalInstance.xterm.raw.onTitleChange。 */
  onTitleChange?: (title: string) => void;
}`,
      },
      {
        find: `  private _onBufferDiagnostic: ((p: ITerminalBufferDiagnostic) => void) | null = null;`,
        replace:
`  private _onBufferDiagnostic: ((p: ITerminalBufferDiagnostic) => void) | null = null;
  private _onTitleChange: ((title: string) => void) | null = null;`,
      },
      {
        find: `    this._onBufferDiagnostic = options.onBufferDiagnostic ?? null;`,
        replace:
`    this._onBufferDiagnostic = options.onBufferDiagnostic ?? null;
    this._onTitleChange = options.onTitleChange ?? null;`,
      },
      {
        find: `    this._onBufferDiagnostic = callbacks.onBufferDiagnostic ?? null;`,
        replace:
`    this._onBufferDiagnostic = callbacks.onBufferDiagnostic ?? null;
    this._onTitleChange = callbacks.onTitleChange ?? null;`,
      },
      {
        find:
`  private _emitVisualWrite(payload: ITerminalVisualWritePayload): void {
    this._onVisualWrite?.(payload);
  }`,
        replace:
`  private _emitVisualWrite(payload: ITerminalVisualWritePayload): void {
    this._onVisualWrite?.(payload);
  }

  private _emitTitleChange(title: string): void {
    this._onTitleChange?.(title);
  }`,
      },
      {
        find:
`      terminal.onSelectionChange(() => {
        void this._writeSelectionToClipboard();
      });
    }`,
        replace:
`      terminal.onSelectionChange(() => {
        void this._writeSelectionToClipboard();
      });
      // 标签标题跟随 shell 标题序列（OSC 0/2）：对照 VSCode TerminalInstance 监听 xterm.raw.onTitleChange，
      // 默认 WSL bash 写「user@host: <cwd>」，前台程序运行时写命令名 —— 让 tab 反映 cwd/运行命令。
      terminal.onTitleChange((title) => {
        this._emitTitleChange(title);
      });
    }`,
      },
    ],
  },
  {
    file: 'src/composables/useIntegratedTerminal.ts',
    edits: [
      {
        find:
`import { useTerminalRunRoutingStore } from '@/store/terminalRunRouting';
import { useTerminalRegistryStore } from '@/terminal/registry';`,
        replace:
`import { useTerminalRunRoutingStore } from '@/store/terminalRunRouting';
import { useTerminalTabsStore } from '@/store/terminalTabs';
import { useTerminalRegistryStore } from '@/terminal/registry';`,
      },
      {
        find:
`  const registry = useTerminalRegistryStore();
  const hostRef = ref<HTMLElement | null>(null);`,
        replace:
`  const registry = useTerminalRegistryStore();
  const tabsStore = useTerminalTabsStore();
  const hostRef = ref<HTMLElement | null>(null);`,
      },
      {
        find:
`  const buildSessionCallbacks = (): ITerminalSessionCallbacks => ({
    onStatusChange,
    onRunCompleted,`,
        replace:
`  const buildSessionCallbacks = (): ITerminalSessionCallbacks => ({
    onStatusChange,
    onRunCompleted,
    onTitleChange: (title) => {
      tabsStore.setTabTitle(sessionId, title);
    },`,
      },
    ],
  },
];

let hadError = false;
for (const { file, edits } of groups) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`[fail] ${file}: 读取失败 ${e.message}`);
    hadError = true;
    continue;
  }
  const hadCRLF = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');
  let applied = 0;
  let skipped = 0;
  let fileFailed = false;
  for (const { find, replace } of edits) {
    if (text.includes(replace)) {
      skipped += 1; // 已应用，幂等跳过
      continue;
    }
    const occurrences = text.split(find).length - 1;
    if (occurrences === 0) {
      console.error(`[fail] ${file}: 未找到锚点（按最新 main 核对）：\n  ${find.slice(0, 80)}…`);
      fileFailed = true;
      break;
    }
    if (occurrences > 1) {
      console.error(`[fail] ${file}: 锚点出现 ${occurrences} 次，要求唯一：\n  ${find.slice(0, 80)}…`);
      fileFailed = true;
      break;
    }
    text = text.replace(find, () => replace);
    applied += 1;
  }
  if (fileFailed) {
    hadError = true;
    continue; // all-or-nothing：该文件不写盘
  }
  if (applied === 0) {
    console.log(`[skip] ${file}: ${skipped} 处均已应用，无改动`);
    continue;
  }
  writeFileSync(file, hadCRLF ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  console.log(`[ok] ${file}: 应用 ${applied} 处${skipped ? `，跳过 ${skipped} 处` : ''}`);
}

if (hadError) {
  console.error('\n存在硬失败，已按文件 all-or-nothing 跳过，未写入半成品。请核对锚点后重试。');
  process.exit(1);
}
console.log('\nFE-2 tab 标题接线完成。请运行：pnpm vue-tsc --noEmit && pnpm vitest run');