import type { ToolsInput } from '@mastra/core/agent';
import { resolve } from 'node:path';
import { z } from 'zod';
import { toRecord } from '../../engines/utils.js';
import { withTimeout } from '../../timeout.js';
import {
  MCP_SERVER_NAMES,
  type IMcpServerConfig,
  type TMcpServerName,
} from '../mcp.js';
import type {
  IMcpGatewayBundle,
  IMcpGatewayCatalog,
  IMcpGatewayExecutableTool,
  IMcpGatewayResolvedTool,
  TMcpGatewayToolProfile,
} from './types.js';
import { readMcpToolAnnotations, resolveMcpToolCapability } from './capability.js';

const GIT_NATIVE_FILE_DUPLICATE_TOOL_PATTERN =
  /(?:^|[_*-])(?:read_file|write_file|edit_file|create_directory|move_file|delete_file|grep)(?:$|[_*-])/iu;

const PROBE_NATIVE_FILE_DUPLICATE_TOOL_PATTERN =
  /(?:^|[_*-])(?:grep|search_code|search_files|extract_code|read_file|list_files)(?:$|[_*-])/iu;

export const MCP_GATEWAY_TOOL_NAMES = ['mcp_list_tools', 'mcp_call_tool'] as const;

const mcpGatewayServerNameSchema = z.enum(MCP_SERVER_NAMES);

export const mcpGatewayListInputSchema = z.object({}).strict();
export const mcpGatewayListLegacyInputSchema = z.object({}).passthrough();

export const mcpGatewayCallInputSchema = z.object({
  serverName: mcpGatewayServerNameSchema,
  toolName: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

const createEmptyGatewayBundle = (): IMcpGatewayBundle => ({
  tools: {},
  configs: [],
  errors: [],
  disconnectAll: async () => undefined,
});

export const createMcpGatewayRunBundle = createEmptyGatewayBundle;

let unwrapConflictWarningEmitted = false;

export const unwrapGatewayToolInput = (value: unknown): unknown => {
  const record = toRecord(value);
  if (!record) {
    return {};
  }
  if ('serverName' in record || 'toolName' in record) {
    return record;
  }
  const input = toRecord(record.input);
  const args = toRecord(record.arguments);
  // 优先级：input > arguments；若两者并存，告警一次（生产期检测异常模型输出）
  if (input && args && !unwrapConflictWarningEmitted) {
    unwrapConflictWarningEmitted = true;
    console.warn('[mcp-gateway] tool input wrapped with both `input` and `arguments`; using `input`.');
  }
  if (input) {
    return input;
  }
  if (args) {
    return args;
  }
  return record;
};

const getToolDescription = (tool: unknown): string => {
  const record = toRecord(tool);
  const description = record?.description;
  return typeof description === 'string' ? description : '';
};

const createToolDescription = (tool: unknown, toolName: string): string => {
  const raw = getToolDescription(tool).replace(/\s+/gu, ' ').trim();
  return raw || `(no description for ${toolName})`;
};

const normalizeMcpServerToolPrefix = (serverName: TMcpServerName): string =>
  serverName.replace(/-/gu, '_');

const isNativeFilePrimitiveDuplicateTool = (
  serverName: TMcpServerName,
  toolName: string,
): boolean => {
  switch (serverName) {
    case 'git':
      return GIT_NATIVE_FILE_DUPLICATE_TOOL_PATTERN.test(toolName);
    case 'probe':
      return PROBE_NATIVE_FILE_DUPLICATE_TOOL_PATTERN.test(toolName);
    default:
      return false;
  }
};

const filterNativeFilePrimitiveDuplicates = (
  serverName: TMcpServerName,
  tools: ToolsInput,
): ToolsInput => {
  const filteredTools: ToolsInput = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!isNativeFilePrimitiveDuplicateTool(serverName, name)) {
      filteredTools[name] = tool;
    }
  }
  return filteredTools;
};

export const filterMcpToolsForProfile = (
  serverName: TMcpServerName,
  tools: ToolsInput,
  profile: TMcpGatewayToolProfile,
): ToolsInput => {
  const nativeFilteredTools = filterNativeFilePrimitiveDuplicates(serverName, tools);
  if (profile === 'write') {
    return nativeFilteredTools;
  }
  // readonly profile：剃除**能证明是写操作**的工具（server 注解声明非只读 /
  // 破坏性）。能力未知（server 未自报注解）的工具仍保留可见，但调用时会被
  // 审批门控（requiresMcpToolApproval，fail-closed）拦截——安全性不依赖此处过滤。
  const filteredTools: ToolsInput = {};
  for (const [name, tool] of Object.entries(nativeFilteredTools)) {
    const annotations = readMcpToolAnnotations(tool);
    if (resolveMcpToolCapability(serverName, annotations) !== 'write') {
      filteredTools[name] = tool;
    }
  }
  return filteredTools;
};

export const resolveMcpGatewayTool = (
  tools: ToolsInput,
  serverName: TMcpServerName,
  toolName: string,
): IMcpGatewayResolvedTool | null => {
  const direct = tools[toolName];
  if (direct) {
    return { name: toolName, tool: direct };
  }
  const prefixedName = `${normalizeMcpServerToolPrefix(serverName)}_${toolName}`;
  const prefixed = tools[prefixedName];
  if (prefixed) {
    return { name: prefixedName, tool: prefixed };
  }
  const suffix = `_${toolName}`;
  const matches = Object.entries(tools).filter(([name]) => name.endsWith(suffix));
  if (matches.length !== 1) {
    return null;
  }
  const match = matches[0];
  return match ? { name: match[0], tool: match[1] } : null;
};

const isExecutableTool = (tool: unknown): tool is IMcpGatewayExecutableTool => {
  const record = toRecord(tool);
  return typeof record?.execute === 'function';
};

// MCP 原生工具通常直接接收 raw args；
// 少数 Mastra 风格工具的 execute 实现会从 args.context 取输入。
// 双路兼容：优先传 raw args，只有明确缺少 context/runtimeContext 时才回退包装参数。
const isContextSignatureError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  return /\b(?:context|runtimeContext|undefined is not an object|cannot read propert)/iu.test(error.message);
};

export const executeMcpGatewayToolWithTimeout = async (
  tool: unknown,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> => {
  if (!isExecutableTool(tool)) {
    throw new Error('目标 MCP tool 没有可执行入口。');
  }
  const invoke = async (): Promise<unknown> => {
    try {
      return await tool.execute(args);
    } catch (error) {
      if (isContextSignatureError(error)) {
        return await tool.execute({ context: args, runtimeContext: undefined });
      }
      throw error;
    }
  };
  return await withTimeout(
    invoke(),
    timeoutMs,
    () => new Error(`MCP tool 调用超时（${timeoutMs}ms）。`),
  );
};

export const createPoolKey = (
  workspaceRootPath: string | undefined,
  serverName: TMcpServerName,
  pinnedIgnoreWorkspace: ReadonlySet<TMcpServerName>,
): string => {
  if (pinnedIgnoreWorkspace.has(serverName)) {
    return `<global>::${serverName}`;
  }
  const workspaceKey = workspaceRootPath ? resolve(workspaceRootPath) : '<default>';
  return `${workspaceKey}::${serverName}`;
};

export const createCatalogKey = (
  serverName: TMcpServerName,
  profile: TMcpGatewayToolProfile,
): string => `${serverName}::${profile}`;

export const readErrors = (bundle: IMcpGatewayBundle): string[] => bundle.errors ?? [];
const readConfigs = (bundle: IMcpGatewayBundle): IMcpServerConfig[] => bundle.configs ?? [];

const createUnavailableReason = (
  serverName: TMcpServerName,
  bundle: IMcpGatewayBundle,
  profile: TMcpGatewayToolProfile,
  filteredToolCount: number,
): string | undefined => {
  const rawToolCount = Object.keys(bundle.tools).length;
  const nativeFilteredToolCount = Object.keys(
    filterNativeFilePrimitiveDuplicates(serverName, bundle.tools),
  ).length;
  if (rawToolCount > 0 && nativeFilteredToolCount === 0) {
    return `MCP server ${serverName} 的本地文件读写/搜索工具已由内置 file primitives 接管。`;
  }
  if (nativeFilteredToolCount > 0 && filteredToolCount === 0 && profile === 'readonly') {
    return `当前 readonly profile 不允许使用 ${serverName} 的任何 MCP tool。`;
  }
  if (rawToolCount === 0 && readConfigs(bundle).length === 0 && readErrors(bundle).length > 0) {
    return `当前 MCP 配置未启用 ${serverName}。`;
  }
  if (rawToolCount === 0) {
    return `MCP server ${serverName} 未返回工具。`;
  }
  return undefined;
};

export const createCatalogFromBundle = (
  serverName: TMcpServerName,
  profile: TMcpGatewayToolProfile,
  bundle: IMcpGatewayBundle,
): IMcpGatewayCatalog => {
  const tools = filterMcpToolsForProfile(serverName, bundle.tools, profile);
  const toolEntries = Object.entries(tools).map(([name, tool]) => ({
    name,
    description: createToolDescription(tool, name),
  }));
  return {
    serverName,
    profile,
    tools: toolEntries,
    errors: readErrors(bundle),
  };
};

export const createToolUnavailableError = (
  serverName: TMcpServerName,
  toolName: string,
  bundle: IMcpGatewayBundle,
  profile: TMcpGatewayToolProfile,
  availableTools: string[],
): Error => {
  const unavailableReason = createUnavailableReason(serverName, bundle, profile, availableTools.length);
  const errors = readErrors(bundle);
  const details = [
    `MCP tool 不可用：${serverName}/${toolName}`,
    availableTools.length > 0 ? `可用工具：${availableTools.join(', ')}` : null,
    unavailableReason ?? null,
    errors.length > 0 ? `错误：${errors.join('；')}` : null,
  ].filter((line): line is string => typeof line === 'string' && line.length > 0);
  return new Error(details.join('\n'));
};
