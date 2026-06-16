import { describe, expect, it } from 'vitest';
import {
  buildDispatchedTerminalRunSummary,
  buildPendingTerminalRunSummary,
  buildTerminalRunCompletionDetail,
  buildTerminalRunHistoryEntry,
  buildTerminalRunResult,
  createActiveTerminalRunMeta,
  isTerminalRunFinalLog,
  isTerminalRunFlowLog,
  resolveRunHistoryStatus,
  TERMINAL_RUN_LOG_CODES,
  TERMINAL_RUN_LOG_TITLES,
} from './terminal-run';

describe('terminal-run helpers', () => {
  it('将退出码归一化为运行历史状态', () => {
    expect(resolveRunHistoryStatus(0)).toBe('success');
    expect(resolveRunHistoryStatus(null)).toBe('canceled');
    expect(resolveRunHistoryStatus(130)).toBe('canceled');
    expect(resolveRunHistoryStatus(1)).toBe('failed');
  });

  it('构建待发送运行摘要时保留文档信息与执行器标签', () => {
    const summary = buildPendingTerminalRunSummary(
      {
        name: 'deploy.sh',
        path: '/workspace/deploy.sh',
      },
      'run-1',
      '2026-04-22T10:00:00.000Z',
      'wsl',
      true,
    );

    expect(summary).toMatchObject({
      runId: 'run-1',
      documentName: 'deploy.sh',
      documentPath: '/workspace/deploy.sh',
      executor: 'wsl',
      executorLabel: 'WSL2',
      usedTempFile: true,
    });
    expect(summary.commandLine).toContain('正在发送');
  });

  it('基于活动运行元信息构建完成结果与历史记录', () => {
    const activeRunMeta = createActiveTerminalRunMeta(
      'run-1',
      '2026-04-22T10:00:00.000Z',
      'bash /tmp/run.sh',
      true,
    );
    const activeRunSummary = buildDispatchedTerminalRunSummary(
      {
        name: 'deploy.sh',
        path: '/workspace/deploy.sh',
      },
      activeRunMeta,
      'wsl',
    );
    const runResult = buildTerminalRunResult({
      output: 'done',
      exitCode: 0,
      finishedAt: '2026-04-22T10:00:03.500Z',
      executor: 'wsl',
      activeRunMeta,
      activeRunSummary,
    });
    const historyEntry = buildTerminalRunHistoryEntry(runResult, activeRunSummary, {
      name: 'fallback.sh',
      path: '/workspace/fallback.sh',
    });

    expect(runResult).toMatchObject({
      runId: 'run-1',
      success: true,
      stdout: 'done',
      stderr: '',
      commandLine: 'bash /tmp/run.sh',
      executorLabel: 'WSL2',
      usedTempFile: true,
    });
    expect(runResult.durationMs).toBe(3500);
    expect(historyEntry).toMatchObject({
      status: 'success',
      documentName: 'deploy.sh',
      documentPath: '/workspace/deploy.sh',
      commandLine: 'bash /tmp/run.sh',
    });
  });

  it('生成完成日志详情时输出关键诊断信息', () => {
    const detail = buildTerminalRunCompletionDetail({
      runId: 'run-2',
      success: false,
      stdout: '',
      stderr: 'boom',
      combinedOutput: 'boom',
      exitCode: 2,
      executor: 'wsl',
      executorLabel: 'WSL2',
      durationMs: 1200,
      startedAt: '2026-04-22T10:00:00.000Z',
      finishedAt: '2026-04-22T10:00:01.200Z',
      commandLine: 'bash /tmp/run.sh',
      logPath: null,
      usedTempFile: false,
    });

    expect(detail).toContain('WSL2');
    expect(detail).toContain('2');
    expect(detail).toContain('1200ms');
  });

  it('通过日志元数据识别运行链路日志', () => {
    expect(
      isTerminalRunFlowLog({
        id: 'log-1',
        level: 'info',
        title: TERMINAL_RUN_LOG_TITLES.start,
        detail: 'using WSL2',
        createdAt: '2026-04-22T10:00:00.000Z',
        scope: 'run',
        runId: 'run-1',
        code: TERMINAL_RUN_LOG_CODES.start,
      }),
    ).toBe(true);

    expect(
      isTerminalRunFinalLog({
        id: 'log-2',
        level: 'error',
        title: TERMINAL_RUN_LOG_TITLES.failed,
        detail: 'exit 1',
        createdAt: '2026-04-22T10:00:03.000Z',
        scope: 'run',
        runId: 'run-1',
        code: TERMINAL_RUN_LOG_CODES.failed,
      }),
    ).toBe(true);
  });
});
