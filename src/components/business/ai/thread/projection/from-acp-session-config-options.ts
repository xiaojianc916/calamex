import type {
  IAcpSessionConfigOption,
  IAcpSessionConfigSelectOption,
  TAcpSessionConfigOptions,
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

function parseSelectOptions(raw: unknown): IAcpSessionConfigSelectOption[] | null {
  if (!Array.isArray(raw)) return null;
  const options: IAcpSessionConfigSelectOption[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    if (Array.isArray(entry.options)) {
      const groupName = readString(entry.name) ?? readString(entry.group) ?? undefined;
      for (const child of entry.options) {
        const option = parseSelectOption(child, groupName);
        if (option !== null) options.push(option);
      }
      continue;
    }
    const option = parseSelectOption(entry);
    if (option !== null) options.push(option);
  }
  return options;
}

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
 * 解析 ACP configOptions（SessionConfigOption[]）为 v3 判别式「ready」态。
 * 非数组（含 null）=> null（坏帧 / 非法负载，由调用方决定保留旧态）；
 * 合法但为空 => { kind: 'ready', configOptions: [] }（已公示、无可选项）。
 */
export function parseAcpSessionConfigOptions(
  raw: unknown,
): Extract<TAcpSessionConfigOptions, { kind: 'ready' }> | null {
  const configOptions = parseConfigOptionList(raw);
  if (configOptions === null) return null;
  return { kind: 'ready', configOptions };
}

/**
 * 应用 config_option_update（完整快照）：成功解析则整体替换为 ready 态；
 * 坏帧（非数组）保留旧状态，避免单帧异常清空 UI。唯一标准事件入口。
 */
export function applyAcpConfigOptionUpdate(
  state: TAcpSessionConfigOptions,
  raw: unknown,
): TAcpSessionConfigOptions {
  const next = parseAcpSessionConfigOptions(raw);
  return next ?? state;
}
