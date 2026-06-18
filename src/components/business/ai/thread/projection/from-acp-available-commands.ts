import type { IAcpAvailableCommand, IAcpAvailableCommandsState } from '@/types/ai/sidecar';

/**
 * ACP 可用斜杠命令 ACL（ADR-20260617 · D7-④）。
 *
 * 把 ACP available_commands_update 的原始 availableCommands 数组（逐字透传、形状
 * unknown）归一到前端斜杠命令面板 VM。ACP 形状（camelCase，见
 * agentclientprotocol.com/protocol/slash-commands）：
 *   { name: string, description: string, input?: { hint: string } }
 *
 * 解析失败 / 非数组 / 无有效命令 一律返回 null（面板据此整体隐藏），不抛错、不伪造
 * 默认项。逐项跳过缺 name（或 description 非字符串）的非法条目。
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const parseCommand = (raw: unknown): IAcpAvailableCommand | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const name = readString(raw.name);
  const description = typeof raw.description === 'string' ? raw.description : null;
  if (!name || description === null) {
    return null;
  }
  const inputHint = isRecord(raw.input) ? readString(raw.input.hint) : null;
  return inputHint ? { name, description, inputHint } : { name, description };
};

export const parseAcpAvailableCommands = (raw: unknown): IAcpAvailableCommandsState | null => {
  if (!Array.isArray(raw)) {
    return null;
  }
  const commands = raw
    .map(parseCommand)
    .filter((command): command is IAcpAvailableCommand => command !== null);
  return commands.length > 0 ? { commands } : null;
};
