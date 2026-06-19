/**
 * src/terminal/run-visual-sequencer.ts
 * Run 可视化帧序列重排器 — 从 TerminalSession 类中提取。
 *
 * 职责：
 *   - 接收 run/source 的终端数据帧，按 runSeq 排序后按序输出
 *   - 序列缺口检测与超时恢复（乱序帧自动等待，超时后按当前可见序列放行）
 *   - 注入分隔符帧到达时清理事务
 *
 * 设计说明：
 *   不持有 xterm 引用，通过回调将排好序的帧传给写缓冲。
 */

import type { ITerminalDataEvent } from '@/types/terminal';
import { TERMINAL_RUN_VISUAL_REORDER_TIMEOUT_MS } from './session-constants';
import type { IRunVisualTransaction } from './session-types';

// ─── 外部依赖接口 ─────────────────────────────────────────────────────────────

/** Run 可视化序列器所需的外部回调 */
export interface IRunVisualSequencerDeps {
  /** 将排好序的帧写入终端 */
  writePayload: (payload: ITerminalDataEvent) => void;
}

// ─── RunVisualSequencer ────────────────────────────────────────────────────────

export class RunVisualSequencer {
  private readonly _deps: IRunVisualSequencerDeps;
  private readonly _transactions = new Map<string, IRunVisualTransaction>();

  constructor(deps: IRunVisualSequencerDeps) {
    this._deps = deps;
  }

  /**
   * 处理 run 数据帧：如果携带有效的 runId/runSeq，按 seq 排序输出；
   * 否则直接透传给写缓冲。
   */
  handlePayload(payload: ITerminalDataEvent): void {
    const runId = payload.runId;
    const runSeq = payload.runSeq;
    if (
      typeof runId !== 'string' ||
      runId.length === 0 ||
      typeof runSeq !== 'number' ||
      !Number.isSafeInteger(runSeq) ||
      runSeq <= 0
    ) {
      this._deps.writePayload(payload);
      return;
    }

    const transaction = this._getTransaction(runId);
    if (runSeq < transaction.nextSeq) {
      return;
    }

    transaction.pending.set(runSeq, payload);
    this._drainTransaction(runId, transaction);
  }

  /** 清除指定 run 的事务（run 完成或分离时调用） */
  clear(runId: string): void {
    const transaction = this._transactions.get(runId);
    if (!transaction) return;
    if (transaction.gapTimerId !== null) {
      window.clearTimeout(transaction.gapTimerId);
    }
    this._transactions.delete(runId);
  }

  /** 清除所有事务（detach 时调用） */
  clearAll(): void {
    for (const transaction of this._transactions.values()) {
      if (transaction.gapTimerId !== null) {
        window.clearTimeout(transaction.gapTimerId);
      }
    }
    this._transactions.clear();
  }

  // ── 私有方法 ────────────────────────────────────────────────────────────────

  private _getTransaction(runId: string): IRunVisualTransaction {
    const existing = this._transactions.get(runId);
    if (existing) return existing;

    const transaction: IRunVisualTransaction = {
      nextSeq: 1,
      pending: new Map<number, ITerminalDataEvent>(),
      gapTimerId: null,
    };
    this._transactions.set(runId, transaction);
    return transaction;
  }

  private _scheduleGapRecovery(runId: string, transaction: IRunVisualTransaction): void {
    if (transaction.gapTimerId !== null) return;
    transaction.gapTimerId = window.setTimeout(() => {
      transaction.gapTimerId = null;
      this._recoverSeqGap(runId);
    }, TERMINAL_RUN_VISUAL_REORDER_TIMEOUT_MS);
  }

  private _recoverSeqGap(runId: string): void {
    const transaction = this._transactions.get(runId);
    if (!transaction || transaction.pending.size === 0) return;

    let lowestPendingSeq = Number.POSITIVE_INFINITY;
    for (const seq of transaction.pending.keys()) {
      if (seq < lowestPendingSeq) lowestPendingSeq = seq;
    }
    if (!transaction.pending.has(transaction.nextSeq)) {
      transaction.nextSeq = lowestPendingSeq;
      console.warn('[terminal] terminal:data runSeq 缺口，已按当前可见事务放行。', {
        runId,
        nextSeq: transaction.nextSeq,
      });
    }
    this._drainTransaction(runId, transaction);
  }

  private _drainTransaction(runId: string, transaction: IRunVisualTransaction): void {
    while (true) {
      const payload = transaction.pending.get(transaction.nextSeq);
      if (!payload) break;
      transaction.pending.delete(transaction.nextSeq);
      transaction.nextSeq += 1;
      this._deps.writePayload(payload);
      if (payload.source === 'injected_separator') {
        this.clear(runId);
        return;
      }
    }

    if (transaction.pending.size > 0) {
      this._scheduleGapRecovery(runId, transaction);
      return;
    }

    if (transaction.gapTimerId !== null) {
      window.clearTimeout(transaction.gapTimerId);
      transaction.gapTimerId = null;
    }
  }
}
