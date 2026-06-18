import type { IAiThreadTerminalSnapshot } from '@/components/business/ai/thread/projection/tool-view';

/**
 * ACP 终端输出 ACL（ADR-20260617 · D7-⑥）。
 *
 * 把 ACP terminal/output 的原始负载（client 侧自有终端的输出快照，形状 unknown）归一到
 * 渲染层终端快照 VM（tool-view.ts 的 IAiThreadTerminalSnapshot），供 toAiThreadToolView
 * 的 resolveTerminal 依赖按 terminalId 查得。ACP 形状（camelCase，见
 * agentclientprotocol.com/protocol/terminals）：
 *   { output: string, truncated?: boolean, exitStatus?: { exitCode, signal } | null }
 *
 * 语义：exitStatus 缺省 / 为 null => 进程仍在运行（streaming=true）；出现 exitStatus
 * 对象 => 已结束（streaming=false）。output 非字符串 / 非对象一律返回 null（无终端输出），
 * 不抛错、不伪造。title 可选透传。
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export const parseAcpTerminalSnapshot = (raw: unknown): IAiThreadTerminalSnapshot | null => {
  if (!isRecord(raw) || typeof raw.output !== 'string') {
    return null;
  }
  const output = raw.output;
  const streaming = raw.exitStatus === null || raw.exitStatus === undefined;
  const title = readString(raw.title);
  return title === null ? { output, streaming } : { title, output, streaming };
};
