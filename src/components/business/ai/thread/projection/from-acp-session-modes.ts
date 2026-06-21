import type { IAcpSessionMode, IAcpSessionModesState } from '@/types/ai/sidecar';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 解析单个 SessionMode（{ id, name, description? }）。缺 id/name 时返回 null。 */
function parseSessionMode(raw: unknown): IAcpSessionMode | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw.id);
  const name = readString(raw.name);
  if (id === null || name === null) return null;
  const mode: IAcpSessionMode = { id, name };
  const description = readOptionalString(raw.description);
  if (description !== undefined) mode.description = description;
  return mode;
}

/** 解析 SessionMode[]。非数组 => null；逐项过滤无效与重复 id。 */
function parseSessionModeList(raw: unknown): IAcpSessionMode[] | null {
  if (!Array.isArray(raw)) return null;
  const modes: IAcpSessionMode[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const mode = parseSessionMode(entry);
    if (mode === null) continue;
    if (seen.has(mode.id)) continue;
    seen.add(mode.id);
    modes.push(mode);
  }
  return modes;
}

/**
 * 从 ai_get_session_modes 的原始 modes（ACP SessionModeState）解析为 VM。
 * 非对象（含 null）=> null；availableModes 非数组 => null；合法但为空 =>
 * { currentModeId, availableModes: [] }（已加载、agent 未公示模式）。
 */
export function parseAcpSessionModesState(raw: unknown): IAcpSessionModesState | null {
  if (!isRecord(raw)) return null;
  const availableModes = parseSessionModeList(raw.availableModes);
  if (availableModes === null) return null;
  const currentModeId = readString(raw.currentModeId);
  return { currentModeId, availableModes };
}

/**
 * 应用 current_mode_update：仅回灌 currentModeId（agent 回合中自行切换模式时），
 * 不触碰 availableModes（沿用 ai_get_session_modes 拉取的完整列表）。state 为 null 时不动。
 */
export function applyAcpCurrentModeUpdate(
  state: IAcpSessionModesState | null,
  currentModeId: string | null,
): IAcpSessionModesState | null {
  if (state === null) return null;
  return { ...state, currentModeId };
}
