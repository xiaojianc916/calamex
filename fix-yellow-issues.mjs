#!/usr/bin/env node
// apply-optionc-batch3.mjs
// Option C — Batch 3: 切断运行输出的「独立捕获」喂入链。
//   1) runOrchestrator.ts：删除 run-chunk 订阅 + appendTerminalOutput/缓冲区/批量定时器/
//      flush/reset 及其在 prime/fail/finalize/reset 中的调用，failTerminalRun 去掉
//      writeMessageToTerminalOutput 选项。
//   2) terminal-run.ts：buildTerminalRunResult 去掉 output 入参，stdout/stderr/combinedOutput 置空
//      （卡片只留元数据，输出只看终端）。
//   3) terminal-run.spec.ts：同步去掉 output 用例输入与断言。
//
// 约定：CRLF 安全；逐文件「全有或全无」；幂等（已是目标状态则跳过）；
//      非空替换默认要求恰好 N 处匹配（count，默认 1）；replace==='' 为整体删除。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const EDITS = [
  // ===================== runOrchestrator.ts =====================
  {
    file: 'src/services/terminal/runOrchestrator.ts',
    edits: [
      // R1: 删除类型导入 ITerminalRunChunkPayload
      {
        find: `import {\n  DEFAULT_TERMINAL_SESSION_ID,\n  type IDispatchTerminalScriptRequest,\n  type ITerminalExitEvent,\n  type ITerminalRunChunkPayload,\n  type ITerminalRunCompletedPayload,\n} from '@/types/terminal';`,
        replace: `import {\n  DEFAULT_TERMINAL_SESSION_ID,\n  type IDispatchTerminalScriptRequest,\n  type ITerminalExitEvent,\n  type ITerminalRunCompletedPayload,\n} from '@/types/terminal';`,
      },
      // R2: 删除批量间隔常量
      {
        find: `const TERMINAL_OUTPUT_BATCH_INTERVAL_MS = 120;\nconst TERMINAL_RUN_COMPLETION_TIMEOUT_MS = 30 * 60 * 1000;`,
        replace: `const TERMINAL_RUN_COMPLETION_TIMEOUT_MS = 30 * 60 * 1000;`,
      },
      // R3: 删除缓冲区字段
      {
        find: `  private bufferedTerminalOutputChunks: string[] = [];\n  private readonly bufferedTerminalOutputTimer = createMutableDisposable();\n  private readonly terminalRunFallbackTimer = createMutableDisposable();`,
        replace: `  private readonly terminalRunFallbackTimer = createMutableDisposable();`,
      },
      // R4: 删除 appendTerminalOutput 方法（含其后一空行）
      {
        find: `  appendTerminalOutput(payload: ITerminalRunChunkPayload): void {\n    if (\n      !this.isActiveRunSession(payload.sessionId) ||\n      !payload.data ||\n      !this.isCurrentTerminalRun(payload.runId)\n    ) {\n      return;\n    }\n\n    this.bufferedTerminalOutputChunks.push(payload.data);\n    if (this.bufferedTerminalOutputTimer.value !== null) {\n      return;\n    }\n\n    this.bufferedTerminalOutputTimer.set(\n      requestDisposableTimeout(() => {\n        this.bufferedTerminalOutputTimer.clearAndLeak();\n        this.flushBufferedTerminalOutput();\n      }, TERMINAL_OUTPUT_BATCH_INTERVAL_MS),\n    );\n  }\n\n`,
        replace: ``,
      },
      // R5: resetActiveRunLifecycle 去掉 resetBufferedTerminalOutput 调用
      {
        find: `  resetActiveRunLifecycle(): void {\n    this.resetBufferedTerminalOutput();\n    this.clearTerminalRunFallbackTimer();`,
        replace: `  resetActiveRunLifecycle(): void {\n    this.clearTerminalRunFallbackTimer();`,
      },
      // R6a: 删除 clearBufferedTerminalOutputTimer 方法（保留 clearTerminalRunFallbackTimer）
      {
        find: `  private clearBufferedTerminalOutputTimer(): void {\n    this.bufferedTerminalOutputTimer.clear();\n  }\n\n  private clearTerminalRunFallbackTimer(): void {`,
        replace: `  private clearTerminalRunFallbackTimer(): void {`,
      },
      // R6b: 删除 flushBufferedTerminalOutput + resetBufferedTerminalOutput 方法
      {
        find: `  private flushBufferedTerminalOutput(): void {\n    this.clearBufferedTerminalOutputTimer();\n\n    if (this.bufferedTerminalOutputChunks.length === 0) {\n      return;\n    }\n\n    const output = this.bufferedTerminalOutputChunks.join('');\n    this.bufferedTerminalOutputChunks = [];\n    this.editorStore.appendTerminalOutput(output);\n  }\n\n  private resetBufferedTerminalOutput(): void {\n    this.clearBufferedTerminalOutputTimer();\n    this.bufferedTerminalOutputChunks = [];\n  }\n\n  private clearActiveTerminalRunState(): void {`,
        replace: `  private clearActiveTerminalRunState(): void {`,
      },
      // R7: failTerminalRun 去掉 options 形参 + writeMessageToTerminalOutput 分支 + resetBufferedTerminalOutput
      {
        find: `  private failTerminalRun(\n    title: string,\n    errorOrMessage: unknown,\n    fallbackMessage: string,\n    logCode: string,\n    options: {\n      writeMessageToTerminalOutput?: boolean;\n    } = {},\n  ): void {\n    const message =\n      typeof errorOrMessage === 'string'\n        ? errorOrMessage\n        : toErrorMessage(errorOrMessage, fallbackMessage);\n    const failedRunId = this.getCurrentTerminalRunId();\n\n    if (this.hasFinalizedTerminalRun(failedRunId)) {\n      return;\n    }\n\n    this.resetBufferedTerminalOutput();\n    this.clearTerminalRunFallbackTimer();\n    this.clearActiveTerminalRunState();\n\n    if (options.writeMessageToTerminalOutput) {\n      this.editorStore.setTerminalOutput(message);\n    }\n\n    this.appendRunLifecycleLog('error', title, message, failedRunId, logCode);\n    this.notifier.error(message);\n  }`,
        replace: `  private failTerminalRun(\n    title: string,\n    errorOrMessage: unknown,\n    fallbackMessage: string,\n    logCode: string,\n  ): void {\n    const message =\n      typeof errorOrMessage === 'string'\n        ? errorOrMessage\n        : toErrorMessage(errorOrMessage, fallbackMessage);\n    const failedRunId = this.getCurrentTerminalRunId();\n\n    if (this.hasFinalizedTerminalRun(failedRunId)) {\n      return;\n    }\n\n    this.clearTerminalRunFallbackTimer();\n    this.clearActiveTerminalRunState();\n\n    this.appendRunLifecycleLog('error', title, message, failedRunId, logCode);\n    this.notifier.error(message);\n  }`,
      },
      // R8: 两处 failTerminalRun 调用去掉 { writeMessageToTerminalOutput: true }（恰好 2 处）
      {
        find: `      this.failTerminalRun('脚本执行失败', error, '脚本执行失败', TERMINAL_RUN_LOG_CODES.failed, {\n        writeMessageToTerminalOutput: true,\n      });`,
        replace: `      this.failTerminalRun('脚本执行失败', error, '脚本执行失败', TERMINAL_RUN_LOG_CODES.failed);`,
        count: 2,
      },
      // R9: primeTerminalRun 去掉 resetBufferedTerminalOutput + setTerminalOutput('')
      {
        find: `    this.editorStore.setActiveRunSummary(\n      buildPendingTerminalRunSummary(document, runId, startedAt, DEFAULT_EXECUTOR, usedTempFile),\n    );\n    this.resetBufferedTerminalOutput();\n    this.editorStore.lastRunResult = null;\n    this.editorStore.setTerminalOutput('');\n    this.activeTerminalRunMeta = createActiveTerminalRunMeta(`,
        replace: `    this.editorStore.setActiveRunSummary(\n      buildPendingTerminalRunSummary(document, runId, startedAt, DEFAULT_EXECUTOR, usedTempFile),\n    );\n    this.editorStore.lastRunResult = null;\n    this.activeTerminalRunMeta = createActiveTerminalRunMeta(`,
      },
      // R10a: ensureTerminalRunEventListeners 删除 run-chunk 监听
      {
        find: `      const listeners = createDisposableBag();\n      const runChunkUnlisten = this.terminalEventBus.onRunChunk(\n        (payload: ITerminalRunChunkPayload) => {\n          this.appendTerminalOutput(payload);\n        },\n      );\n      const runCompletedUnlisten = this.terminalEventBus.onRunCompleted(`,
        replace: `      const listeners = createDisposableBag();\n      const runCompletedUnlisten = this.terminalEventBus.onRunCompleted(`,
      },
      // R10b: 删除 listeners.add(runChunkUnlisten)
      {
        find: `      listeners.add(runChunkUnlisten);\n      listeners.add(runCompletedUnlisten);\n      listeners.add(exitUnlisten);`,
        replace: `      listeners.add(runCompletedUnlisten);\n      listeners.add(exitUnlisten);`,
      },
      // R11: finalizeTerminalRun 去掉 flush + buildTerminalRunResult 的 output 入参
      {
        find: `    this.clearTerminalRunFallbackTimer();\n    this.flushBufferedTerminalOutput();\n\n    const runResult = buildTerminalRunResult({\n      output: this.editorStore.getTerminalOutputSnapshot(),\n      exitCode: normalizedPayload.exitCode,`,
        replace: `    this.clearTerminalRunFallbackTimer();\n\n    const runResult = buildTerminalRunResult({\n      exitCode: normalizedPayload.exitCode,`,
      },
    ],
  },

  // ===================== terminal-run.ts =====================
  {
    file: 'src/utils/terminal/terminal-run.ts',
    edits: [
      // T1: IBuildRunResultOptions 去掉 output 字段
      {
        find: `interface IBuildRunResultOptions {\n  output: string;\n  exitCode: number | null;`,
        replace: `interface IBuildRunResultOptions {\n  exitCode: number | null;`,
      },
      // T2: 解构去掉 output
      {
        find: `export const buildTerminalRunResult = ({\n  output,\n  exitCode,\n  finishedAt,\n  executor,\n  activeRunMeta,\n  activeRunSummary,\n}: IBuildRunResultOptions): IRunResult => {`,
        replace: `export const buildTerminalRunResult = ({\n  exitCode,\n  finishedAt,\n  executor,\n  activeRunMeta,\n  activeRunSummary,\n}: IBuildRunResultOptions): IRunResult => {`,
      },
      // T3: stdout/stderr/combinedOutput 置空
      {
        find: `    success: exitCode === 0,\n    stdout: output,\n    stderr: exitCode === 0 ? '' : output,\n    combinedOutput: output,\n    exitCode,`,
        replace: `    success: exitCode === 0,\n    stdout: '',\n    stderr: '',\n    combinedOutput: '',\n    exitCode,`,
      },
    ],
  },

  // ===================== terminal-run.spec.ts =====================
  {
    file: 'src/utils/terminal/terminal-run.spec.ts',
    edits: [
      // S1: 去掉用例输入 output: 'done'
      {
        find: `    const runResult = buildTerminalRunResult({\n      output: 'done',\n      exitCode: 0,`,
        replace: `    const runResult = buildTerminalRunResult({\n      exitCode: 0,`,
      },
      // S2: 断言 stdout 改为空串
      {
        find: `      stdout: 'done',`,
        replace: `      stdout: '',`,
      },
    ],
  },
];

const countOccurrences = (text, needle) => text.split(needle).length - 1;

let anyFailure = false;
const summary = [];

for (const fileSpec of EDITS) {
  const { file, edits } = fileSpec;
  if (!existsSync(file)) {
    summary.push(`[fail] 文件不存在: ${file}`);
    anyFailure = true;
    continue;
  }

  const raw = readFileSync(file, 'utf8');
  const hadCRLF = raw.includes('\r\n');
  let text = hadCRLF ? raw.replace(/\r\n/g, '\n') : raw;

  let applied = 0;
  let skipped = 0;
  let failed = false;
  let failReason = '';

  for (const edit of edits) {
    const { find, replace } = edit;
    const count = edit.count ?? 1;
    const occ = countOccurrences(text, find);

    if (occ === count) {
      let next = text;
      for (let i = 0; i < count; i++) {
        next = next.replace(find, () => replace);
      }
      text = next;
      applied += 1;
      continue;
    }

    if (occ === 0) {
      // 幂等：整体删除（replace===''）或目标串已存在 => 视为已应用
      if (replace === '' || text.includes(replace)) {
        skipped += 1;
        continue;
      }
      failed = true;
      failReason = `锚点未找到（期望 ${count} 处，实际 0 处）`;
      break;
    }

    failed = true;
    failReason = `期望恰好 ${count} 处匹配，实际 ${occ} 处`;
    break;
  }

  if (failed) {
    summary.push(`[fail] ${file} — ${failReason}（未改动该文件）`);
    anyFailure = true;
    continue;
  }

  if (applied === 0) {
    summary.push(`[skip] ${file}（已是目标状态，未写入）`);
    continue;
  }

  const out = hadCRLF ? text.replace(/\n/g, '\r\n') : text;
  writeFileSync(file, out, 'utf8');
  summary.push(`[ok]   ${file}  应用 ${applied} / 跳过 ${skipped}`);
}

console.log('\n' + summary.join('\n'));

if (anyFailure) {
  console.log('\n存在失败项：失败文件未做任何写入。请把以上 [fail] 行原样回贴给我。');
  process.exit(1);
}

console.log('\nBatch C3 完成。请运行校验：pnpm vue-tsc --noEmit && pnpm vitest run');
