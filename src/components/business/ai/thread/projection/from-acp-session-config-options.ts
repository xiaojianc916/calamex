import type {
  IAcpSessionConfigOption,
  IAcpSessionConfigOptionsState,
  IAcpSessionConfigSelectOption,
} from '@/types/ai/sidecar';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 解析单个 select 候选值（Ungrouped 元素，或 Grouped 组内元素）。
 * group 透传分组标签（顶层未分组时为 undefined）。
 */
function parseSelectOption(raw: unknown, group?: string): IAcpSessionConfigSelectOption | null {
  if (!isRecord(raw)) return null;
  const value = readString(raw.value);
  const name = readString(raw.name);
  if (value === null || name === null) return null;
  const option: IAcpSessionConfigSelectOption = { value, name };
  const description = readOptionalString(raw.description);
  if (description !== undefined) option.description = description;
  if (group !== undefined) option.group = group;
  return option;
}

/**
 * 解析 SessionConfigSelectOptions 联合（Ungrouped | Grouped），拍平为单一列表。
 * 非数组 => null；逐元素探测：带 options 数组的视为 Grouped，否则视为 Ungrouped。
 */
function parseSelectOptions(raw: unknown): IAcpSessionConfigSelectOption[] | null {
  if (!Array.isArray(raw)) return null;
  const options: IAcpSessionConfigSelectOption[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    if (Array.isArray(entry.options)) {
      // Grouped 变体：{ group, name, options[] } —— 拍平并保留分组名。
      const groupName = readString(entry.name) ?? readString(entry.group) ?? undefined;
      for (const child of entry.options) {
        const option = parseSelectOption(child, groupName);
        if (option !== null) options.push(option);
      }
      continue;
    }
    // Ungrouped 变体：{ value, name, description? }
    const option = parseSelectOption(entry);
    if (option !== null) options.push(option);
  }
  return options;
}

/**
 * 解析单个 SessionConfigOption。仅支持 select 型（schema 中 boolean 型为 unstable，未启用）。
 * 缺 id/name/currentValue 或无有效候选值时返回 null（被上层过滤）。
 */
function parseConfigOption(raw: unknown): IAcpSessionConfigOption | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'select') return null;
  const id = readString(raw.id);
  const name = readString(raw.name);
  const currentValue = readString(raw.currentValue);
  if (id === null || name === null || currentValue === null) return null;
  const options = parseSelectOptions(raw.options);
  if (options === null || options.length === 0) return null;
  const option: IAcpSessionConfigOption = { id, name, currentValue, options };
  const description = readOptionalString(raw.description);
  if (description !== undefined) option.description = description;
  const category = readOptionalString(raw.category);
  if (category !== undefined) option.category = category;
  return option;
}

/** 解析 SessionConfigOption[]。非数组 => null；逐项过滤无效与重复 id。 */
function parseConfigOptionList(raw: unknown): IAcpSessionConfigOption[] | null {
  if (!Array.isArray(raw)) return null;
  const configOptions: IAcpSessionConfigOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const option = parseConfigOption(entry);
    if (option === null) continue;
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    configOptions.push(option);
  }
  return configOptions;
}

/**
 * 从 ai_get_session_config_options 的原始 configOptions（ACP SessionConfigOption[]）解析为 VM。
 * 非数组（含 null）=> null；合法但为空 => { configOptions: [] }（已加载、无可用选择器）。
 */
export function parseAcpSessionConfigOptionsState(
  raw: unknown,
): IAcpSessionConfigOptionsState | null {
  const configOptions = parseConfigOptionList(raw);
  if (configOptions === null) return null;
  return { configOptions };
}

/**
 * 应用 config_option_update：该事件携带完整 configOptions 快照，整体替换。
 * 解析失败（坏帧 / 非数组）时保留旧状态，避免单帧异常清空 UI。
 */
export function applyAcpConfigOptionUpdate(
  state: IAcpSessionConfigOptionsState | null,
  raw: unknown,
): IAcpSessionConfigOptionsState | null {
  const next = parseAcpSessionConfigOptionsState(raw);
  return next ?? state;
}
