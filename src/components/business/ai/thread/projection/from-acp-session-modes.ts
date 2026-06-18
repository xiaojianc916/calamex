import type { IAcpSessionModeOption, IAcpSessionModeState } from '@/types/ai/sidecar';

/**
 * ACP 会话模式 ACL（ADR-20260617 · D7-③-c）。
 *
 * 把 `ai_get_session_modes` 返回的原始 `modes`（ACP `SessionModeState`，逐字透传、
 * 形状 unknown）归一到前端模式选择器 VM。ACP 形状（camelCase，见
 * agentclientprotocol.com/protocol/session-modes）：
 *   { currentModeId: string, availableModes: { id, name, description? }[] }
 *
 * 解析失败 / 非对象 / 无可用模式 一律返回 null（选择器据此整体隐藏），不抛错、
 * 不伪造默认项。currentModeId 缺失或不在 availableModes 中时回退到首项。
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const parseModeOption = (raw: unknown): IAcpSessionModeOption | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const id = readString(raw.id);
  const name = readString(raw.name);
  if (!id || !name) {
    return null;
  }
  const description = readString(raw.description);
  return description ? { id, name, description } : { id, name };
};

export const parseAcpSessionModeState = (raw: unknown): IAcpSessionModeState | null => {
  if (!isRecord(raw) || !Array.isArray(raw.availableModes)) {
    return null;
  }
  const availableModes = raw.availableModes
    .map(parseModeOption)
    .filter((mode): mode is IAcpSessionModeOption => mode !== null);
  if (availableModes.length === 0) {
    return null;
  }
  const requestedModeId = readString(raw.currentModeId);
  const currentModeId =
    requestedModeId && availableModes.some((mode) => mode.id === requestedModeId)
      ? requestedModeId
      : (availableModes[0]?.id ?? null);
  return { currentModeId, availableModes };
};

/**
 * 应用 `mode_update` UI 事件：仅当 modeId 命中既有可用模式时更新当前项，否则原样
 * 返回（忽略未知模式，避免选择器进入无对应项的空状态）。
 */
export const applyAcpModeUpdate = (
  state: IAcpSessionModeState,
  modeId: string,
): IAcpSessionModeState =>
  state.availableModes.some((mode) => mode.id === modeId)
    ? { ...state, currentModeId: modeId }
    : state;
