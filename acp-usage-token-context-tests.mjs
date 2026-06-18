#!/usr/bin/env node
/**
 * apply-optionc-batch2.mjs
 * Option C — Batch C2: remove the component-layer run-chunk -> onOutput emit chain (dead code).
 *
 * Touches (component/composable layer only):
 *   src/terminal/session.ts
 *   src/composables/useIntegratedTerminal.ts
 *   src/components/workbench/EmbeddedTerminal.vue
 *   src/components/workbench/RunPanel.vue
 *   src/composables/useTerminalRun.ts
 *   src/composables/useWorkbench.ts
 *
 * NOTE: types/terminal ITerminalRunChunkPayload is intentionally KEPT (runOrchestrator.ts still
 * imports it until Batch C3). Do not delete it here.
 *
 * Conventions: CRLF-safe, per-file all-or-nothing (no partial writes), idempotent
 * (0 matches + result already present => skip), single-occurrence guard (anchor must match exactly once).
 *
 * Run from the repo root:  node apply-optionc-batch2.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FILES = [
  {
    path: 'src/terminal/session.ts',
    edits: [
      // 1a: type import
      [
`  ITerminalInputRoutePayload,
  ITerminalRunChunkPayload,
  ITerminalRunCompletedPayload,`,
`  ITerminalInputRoutePayload,
  ITerminalRunCompletedPayload,`,
      ],
      // 1b: ITerminalSessionCallbacks interface
      [
`  onStatusChange?: (payload: ITerminalStatusChangePayload) => void;
  onOutput?: (payload: ITerminalRunChunkPayload) => void;
  onRunCompleted?: (payload: ITerminalRunCompletedPayload) => void;`,
`  onStatusChange?: (payload: ITerminalStatusChangePayload) => void;
  onRunCompleted?: (payload: ITerminalRunCompletedPayload) => void;`,
      ],
      // 1c: private callback field
      [
`  private _onStatusChange: ((p: ITerminalStatusChangePayload) => void) | null = null;
  private _onOutput: ((p: ITerminalRunChunkPayload) => void) | null = null;
  private _onRunCompleted: ((p: ITerminalRunCompletedPayload) => void) | null = null;`,
`  private _onStatusChange: ((p: ITerminalStatusChangePayload) => void) | null = null;
  private _onRunCompleted: ((p: ITerminalRunCompletedPayload) => void) | null = null;`,
      ],
      // 1d: _runChunkUnlisten field
      [
`  private _dataUnlisten: UnlistenFn | null = null;
  private _runChunkUnlisten: UnlistenFn | null = null;
  private _runCompletedUnlisten: UnlistenFn | null = null;`,
`  private _dataUnlisten: UnlistenFn | null = null;
  private _runCompletedUnlisten: UnlistenFn | null = null;`,
      ],
      // 1e: constructor assignment
      [
`    this._onStatusChange = options.onStatusChange ?? null;
    this._onOutput = options.onOutput ?? null;
    this._onRunCompleted = options.onRunCompleted ?? null;`,
`    this._onStatusChange = options.onStatusChange ?? null;
    this._onRunCompleted = options.onRunCompleted ?? null;`,
      ],
      // 1f: updateCallbacks assignment
      [
`    this._onStatusChange = callbacks.onStatusChange ?? null;
    this._onOutput = callbacks.onOutput ?? null;
    this._onRunCompleted = callbacks.onRunCompleted ?? null;`,
`    this._onStatusChange = callbacks.onStatusChange ?? null;
    this._onRunCompleted = callbacks.onRunCompleted ?? null;`,
      ],
      // 1g: registerEventListeners guard
      [
`      this._dataUnlisten &&
      this._runChunkUnlisten &&
      this._runCompletedUnlisten &&`,
`      this._dataUnlisten &&
      this._runCompletedUnlisten &&`,
      ],
      // 1h: Promise.all destructure + run-chunk listen entry
      [
`      const [dl, rl, cl, el, sl] = await Promise.all([
        listen<ITerminalDataEvent>('terminal:data', (e) => this._handleDataEvent(e)),
        listen<ITerminalRunChunkPayload>('terminal:run-chunk', (e) => this._handleRunChunkEvent(e)),
        listen<ITerminalRunCompletedPayload>('terminal:run-completed', (e) =>`,
`      const [dl, cl, el, sl] = await Promise.all([
        listen<ITerminalDataEvent>('terminal:data', (e) => this._handleDataEvent(e)),
        listen<ITerminalRunCompletedPayload>('terminal:run-completed', (e) =>`,
      ],
      // 1i: version-mismatch cleanup rl()
      [
`        dl();
        rl();
        cl();`,
`        dl();
        cl();`,
      ],
      // 1j: assign unlisten handles
      [
`      this._dataUnlisten = dl;
      this._runChunkUnlisten = rl;
      this._runCompletedUnlisten = cl;`,
`      this._dataUnlisten = dl;
      this._runCompletedUnlisten = cl;`,
      ],
      // 1k: detach() unlisten call
      [
`    this._dataUnlisten?.();
    this._runChunkUnlisten?.();
    this._runCompletedUnlisten?.();`,
`    this._dataUnlisten?.();
    this._runCompletedUnlisten?.();`,
      ],
      // 1l: detach() null reset
      [
`    this._dataUnlisten = null;
    this._runChunkUnlisten = null;
    this._runCompletedUnlisten = null;`,
`    this._dataUnlisten = null;
    this._runCompletedUnlisten = null;`,
      ],
      // 1m: remove _emitOutput method (+ trailing blank line)
      [
`  private _emitOutput(payload: ITerminalRunChunkPayload): void {
    this._onOutput?.(payload);
  }

`,
``,
      ],
      // 1n: remove _handleRunChunkEvent method (+ trailing blank line)
      [
`  private _handleRunChunkEvent(event: { payload: ITerminalRunChunkPayload }): void {
    if (event.payload.sessionId !== this.id || !event.payload.data) return;
    this._emitOutput(event.payload);
  }

`,
``,
      ],
    ],
  },
  {
    path: 'src/composables/useIntegratedTerminal.ts',
    edits: [
      // 2a: type import
      [
`  ITerminalDataEvent,
  ITerminalRunChunkPayload,
  ITerminalRunCompletedPayload,`,
`  ITerminalDataEvent,
  ITerminalRunCompletedPayload,`,
      ],
      // 2b: options type member
      [
`  onStatusChange?: (payload: ITerminalStatusChangePayload) => void;
  onOutput?: (payload: ITerminalRunChunkPayload) => void;
  onRunCompleted?: (payload: ITerminalRunCompletedPayload) => void;`,
`  onStatusChange?: (payload: ITerminalStatusChangePayload) => void;
  onRunCompleted?: (payload: ITerminalRunCompletedPayload) => void;`,
      ],
      // 2c: destructured params
      [
`  sessionId = DEFAULT_TERMINAL_SESSION_ID,
  onStatusChange,
  onOutput,
  onRunCompleted,`,
`  sessionId = DEFAULT_TERMINAL_SESSION_ID,
  onStatusChange,
  onRunCompleted,`,
      ],
      // 2d: buildSessionCallbacks returned object
      [
`  const buildSessionCallbacks = (): ITerminalSessionCallbacks => ({
    onStatusChange,
    onOutput,
    onRunCompleted,`,
`  const buildSessionCallbacks = (): ITerminalSessionCallbacks => ({
    onStatusChange,
    onRunCompleted,`,
      ],
    ],
  },
  {
    path: 'src/components/workbench/EmbeddedTerminal.vue',
    edits: [
      // 3a: type import
      [
`import type {
  ITerminalRunChunkPayload,
  ITerminalRunCompletedPayload,
  ITerminalStatusChangePayload,
} from '@/types/terminal';`,
`import type {
  ITerminalRunCompletedPayload,
  ITerminalStatusChangePayload,
} from '@/types/terminal';`,
      ],
      // 3b: defineEmits run-chunk
      [
`  'status-change': [payload: ITerminalStatusChangePayload];
  'run-chunk': [payload: ITerminalRunChunkPayload];
  'run-completed': [payload: ITerminalRunCompletedPayload];`,
`  'status-change': [payload: ITerminalStatusChangePayload];
  'run-completed': [payload: ITerminalRunCompletedPayload];`,
      ],
      // 3c: useIntegratedTerminal onOutput wiring
      [
`  onStatusChange: (payload) => emit('status-change', payload),
  onOutput: (payload) => emit('run-chunk', payload),
  onRunCompleted: (payload) => emit('run-completed', payload),`,
`  onStatusChange: (payload) => emit('status-change', payload),
  onRunCompleted: (payload) => emit('run-completed', payload),`,
      ],
    ],
  },
  {
    path: 'src/components/workbench/RunPanel.vue',
    edits: [
      // 4a: template @run-chunk binding
      [
`            @run-chunk="$emit('terminal-run-chunk', $event)"
            @run-completed="$emit('terminal-run-completed', $event)"`,
`            @run-completed="$emit('terminal-run-completed', $event)"`,
      ],
      // 4b: type import
      [
`import type { ITerminalRunChunkPayload, ITerminalRunCompletedPayload } from '@/types/terminal';`,
`import type { ITerminalRunCompletedPayload } from '@/types/terminal';`,
      ],
      // 4c: defineEmits terminal-run-chunk
      [
`  hide: [];
  'terminal-run-chunk': [payload: ITerminalRunChunkPayload];
  'terminal-run-completed': [payload: ITerminalRunCompletedPayload];`,
`  hide: [];
  'terminal-run-completed': [payload: ITerminalRunCompletedPayload];`,
      ],
    ],
  },
  {
    path: 'src/composables/useTerminalRun.ts',
    edits: [
      // 5a: type import
      [
`import type { ITerminalRunChunkPayload, ITerminalRunCompletedPayload } from '@/types/terminal';`,
`import type { ITerminalRunCompletedPayload } from '@/types/terminal';`,
      ],
      // 5b: drop appendTerminalOutput from returned object
      [
`    runScript: (): Promise<void> => orchestrator.runScript(),
    appendTerminalOutput: (payload: ITerminalRunChunkPayload): void =>
      orchestrator.appendTerminalOutput(payload),
    handleIntegratedTerminalRunCompleted: (payload: ITerminalRunCompletedPayload): void =>`,
`    runScript: (): Promise<void> => orchestrator.runScript(),
    handleIntegratedTerminalRunCompleted: (payload: ITerminalRunCompletedPayload): void =>`,
      ],
    ],
  },
  {
    path: 'src/composables/useWorkbench.ts',
    edits: [
      // 6a: destructure from useTerminalRun
      [
`  const { runScript, appendTerminalOutput, handleIntegratedTerminalRunCompleted } = useTerminalRun({`,
`  const { runScript, handleIntegratedTerminalRunCompleted } = useTerminalRun({`,
      ],
      // 6b: drop appendTerminalOutput from returned object
      [
`    updateContent,
    appendTerminalOutput,
    updateEncoding,`,
`    updateContent,
    updateEncoding,`,
      ],
    ],
  },
];

let hadError = false;
const summary = [];

for (const { path, edits } of FILES) {
  if (!existsSync(path)) {
    console.error(`[fail] 文件不存在: ${path}`);
    hadError = true;
    continue;
  }
  const raw = readFileSync(path, 'utf8');
  const usedCRLF = raw.includes('\r\n');
  let text = usedCRLF ? raw.replace(/\r\n/g, '\n') : raw;
  const original = text;
  let applied = 0;
  let skipped = 0;
  let fileError = false;

  for (let i = 0; i < edits.length; i++) {
    const [find, replace] = edits[i];
    const count = text.split(find).length - 1;
    if (count === 1) {
      text = text.replace(find, () => replace);
      applied++;
    } else if (count === 0) {
      // idempotent: treat as already-applied only if the result is already present
      const alreadyApplied = replace === '' ? true : text.split(replace).length - 1 >= 1;
      if (alreadyApplied) {
        skipped++;
      } else {
        console.error(`[fail] ${path} 第 ${i + 1} 处锚点 0 匹配，且未发现已应用结果。未改动该文件。`);
        fileError = true;
        break;
      }
    } else {
      console.error(`[fail] ${path} 第 ${i + 1} 处锚点匹配 ${count} 次（期望恰好 1 处）。未改动该文件。`);
      fileError = true;
      break;
    }
  }

  if (fileError) {
    hadError = true;
    continue;
  }
  if (text === original) {
    summary.push(`[skip] ${path}（已是目标状态，未写入）`);
    continue;
  }
  const out = usedCRLF ? text.replace(/\n/g, '\r\n') : text;
  writeFileSync(path, out, 'utf8');
  summary.push(`[ok]   ${path}  应用 ${applied} / 跳过 ${skipped}`);
}

console.log('\n' + summary.join('\n'));
if (hadError) {
  console.error('\n存在失败项：失败文件未做任何写入。请把以上 [fail] 行原样回贴给我。');
  process.exit(1);
}
console.log('\nBatch C2 完成。请运行校验：pnpm vue-tsc --noEmit && pnpm vitest run');
