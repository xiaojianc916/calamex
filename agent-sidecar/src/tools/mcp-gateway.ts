import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { resolve } from 'node:path';
import { z } from 'zod';
import { compactModelOutput } from '../models/output-budget.js';
import { createJsonToolModelOutput } from '../engines/budget/budget.js';
import { toRecord } from '../engines/utils.js';
import { withTimeout } from '../timeout.js';
import {
  MCP_SERVER_NAMES,
  type IMcpServerConfig,
  type TMcpServerName,
} from './mcp.js';

export type TMcpGatewayToolProfile = 'readonly' | 'write';

export interface IMcpGatewayBundle {
  tools: ToolsInput;
  configs?: IMcpServerConfig[];
  errors?: string[];
  disconnectAll: () => Promise<void>;
}

export type TMcpGatewayCreateBundle = (
  options?: { workspaceRootPath?: string | null; serverNames?: readonly TMcpServerName[] },
) => Promise<IMcpGatewayBundle>;

export type TMcpGatewayMetric =
  | {
    type: 'mcp_gateway.boot';
    serverName: TMcpServerName;
    durationMs: number;
    activeBundleCount: number;
    warmBundleCount: number;
    toolCount: number;
    errorCount: number;
  }
  | {
    type: 'mcp_gateway.boot_failed';
    serverName: TMcpServerName;
    durationMs: number;
    errorMessage: string;
  }
  | {
    type: 'mcp_gateway.catalog';
    serverName: TMcpServerName;
    profile: TMcpGatewayToolProfile;
    cacheHit: boolean;
    durationMs: number;
    activeBundleCount: number;
    warmBundleCount: number;
    toolCount: number;
    errorCount: number;
  }
  | {
    type: 'mcp_gateway.call';
    serverName: TMcpServerName;
    requestedToolName: string;
    resolvedToolName: string;
    durationMs: number;
    activeBundleCount: number;
    warmBundleCount: number;
    toolCallCount: number;
    errorCount: number;
  }
  | {
    type: 'mcp_gateway.metric_buffer_dropped';
    droppedCount: number;
  };

export interface IMcpGatewayMetricSink {
  emit(metric: TMcpGatewayMetric): void;
}

export interface IMcpGatewayCatalogTool {
  name: string;
  description: string;
}

export interface IMcpGatewayCatalog {
  serverName: TMcpServerName;
  profile: TMcpGatewayToolProfile;
  tools: IMcpGatewayCatalogTool[];
  errors: string[];
}

export interface IMcpGatewayCatalogCollection {
  profile: TMcpGatewayToolProfile;
  catalogs: IMcpGatewayCatalog[];
  errors: string[];
}

interface IMcpGatewayPoolOptions {
  createBundle: TMcpGatewayCreateBundle;
  maxWarm?: number;
  ttlIdleMs?: number;
  pinnedServers?: readonly TMcpServerName[];
  pinnedServersIgnoreWorkspace?: readonly TMcpServerName[];
  callTimeoutMs?: number;
  now?: () => number;
}

interface IMcpGatewayPoolEntry {
  key: string;
  serverName: TMcpServerName;
  workspaceRootPath?: string;
  bundle?: IMcpGatewayBundle;
  creating?: Promise<IMcpGatewayPoolEntry>;
  activeCount: number;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
}

interface IMcpGatewayResolvedTool {
  name: string;
  tool: unknown;
}

interface IMcpGatewayExecutableTool {
  execute: (inputData: unknown) => unknown | Promise<unknown>;
}

const DEFAULT_MCP_GATEWAY_MAX_WARM = 4;
const DEFAULT_MCP_GATEWAY_TTL_IDLE_MS = 5 * 60_000;
const DEFAULT_MCP_GATEWAY_PINNED_SERVERS: readonly TMcpServerName[] = ['memory'];
const DEFAULT_MCP_GATEWAY_PINNED_SERVERS_IGNORE_WORKSPACE: readonly TMcpServerName[] = ['memory'];
const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;
const METRIC_BUFFER_MAX = 1_000;

const MCP_GATEWAY_MODEL_OUTPUT_MAX_CHARS = 4_000;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_STRING_CHARS = 1_500;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_ARRAY_ITEMS = 20;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_OBJECT_KEYS = 40;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_DEPTH = 6;

const GIT_NATIVE_FILE_DUPLICATE_TOOL_PATTERN =
  /(?:^|[_*-])(?:read_file|write_file|edit_file|create_directory|move_file|delete_file|grep)(?:$|[_*-])/iu;

const PROBE_NATIVE_FILE_DUPLICATE_TOOL_PATTERN =
  /(?:^|[_*-])(?:grep|search_code|search_files|extract_code|read_file|list_files)(?:$|[_*-])/iu;

export const MCP_GATEWAY_TOOL_NAMES = ['mcp_list_tools', 'mcp_call_tool'] as const;

const mcpGatewayServerNameSchema = z.enum(MCP_SERVER_NAMES);

const mcpGatewayListInputSchema = z.object({}).strict();
const mcpGatewayListLegacyInputSchema = z.object({}).passthrough();

const mcpGatewayCallInputSchema = z.object({
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

const unwrapGatewayToolInput = (value: unknown): unknown => {
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

// ── MCP 工具能力模型（capability model）─────────────────────────────
// 是否需要人工审批，不再依据工具名形态猜测，而是依据 MCP 协议层 server 在
// `tools/list` 自报的 tool annotations（readOnlyHint / destructiveHint / ...）。
// @mastra/mcp 会把这些注解透传到 Mastra 工具的 `tool.mcp.annotations` 上
// （见 @mastra/mcp client.ts 与 CHANGELOG：annotations 同时转发给
//  requireToolApproval 回调，并挂在 tool.mcp.annotations 供消费）。
//
// 信任模型（这就是“白名单”的优雅形态，按 server 粒度、可论证）：
//   - 注解是 hint，不是保证（MCP spec 明确：除非来自受信任 server，否则
//     必须视为不可信）。calamex 的全部 MCP server 均由本进程按固定版本
//     spawn、完全受控（见 mcp.ts），属于 provenance-trusted，故可据其注解
//     做能力判定。
//   - 对**整库无副作用**的 server（纯推理 / 纯文档检索）做 server 级信任，
//     无条件免审批；这是按 server 粒度的白名单，而非逐个工具名猜测。
//   - 其余一律 fail-closed：只有能**正向证明只读**时才免审批。

// MCP tool annotations（hint）。字段语义见 MCP spec 2025-11-25。
// server 整体省略 annotations 时该对象为 undefined（@mastra/mcp 不自动填
// 默认值），据此可区分“未声明”与“声明为安全”。
export interface IMcpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// 整库无副作用的 MCP server（server 级信任白名单）：其工具始终视为只读。
const SIDE_EFFECT_FREE_SERVERS: ReadonlySet<TMcpServerName> = new Set<TMcpServerName>([
  'sequential-thinking',
  'context7',
]);

export type TMcpToolCapability = 'readonly' | 'write' | 'unknown';

// 从 @mastra/mcp 透传的工具对象上读取 MCP annotations：
// 优先 `tool.mcp.annotations`（转换后的 Mastra 工具），回退 `tool.annotations`
// （原始 MCP 工具）。读不到则返回 undefined（=server 未自报）。
export const readMcpToolAnnotations = (tool: unknown): IMcpToolAnnotations | undefined => {
  const record = toRecord(tool);
  if (!record) {
    return undefined;
  }
  const mcpMeta = toRecord(record.mcp);
  const fromMcp = mcpMeta ? toRecord(mcpMeta.annotations) : undefined;
  const fromRaw = toRecord(record.annotations);
  const annotations = fromMcp ?? fromRaw;
  return annotations as IMcpToolAnnotations | undefined;
};

// 能力判定（逻辑链条）：
//   1. server 级无副作用白名单 → readonly（信任优先于注解）
//   2. 无 annotations（server 未自报）→ unknown（不猜名字）
//   3. annotations.readOnlyHint === true → readonly
//   4. 其余（destructive、仅增量写入、或字段缺省按 spec 默认非只读）→ write
export const resolveMcpToolCapability = (
  serverName: TMcpServerName,
  annotations: IMcpToolAnnotations | undefined,
): TMcpToolCapability => {
  if (SIDE_EFFECT_FREE_SERVERS.has(serverName)) {
    return 'readonly';
  }
  if (!annotations) {
    return 'unknown';
  }
  if (annotations.readOnlyHint === true) {
    return 'readonly';
  }
  return 'write';
};

// 审批门控（fail-closed）：仅当能**正向证明只读**时免审批；
// write 与 unknown（server 未自报注解）一律要求人工审批。
// 取代旧的“按工具名猜测写动词才审批”逻辑——后者会让名字不匹配的危险工具
// （例如 sqlite-mcp 的 query 跑 DELETE、或任意自定义命名的写工具）静默绕过审批。
export const requiresMcpToolApproval = (
  serverName: TMcpServerName,
  annotations: IMcpToolAnnotations | undefined,
): boolean => resolveMcpToolCapability(serverName, annotations) !== 'readonly';

const filterMcpToolsForProfile = (
  serverName: TMcpServerName,
  tools: ToolsInput,
  profile: TMcpGatewayToolProfile,
): ToolsInput => {
  const nativeFilteredTools = filterNativeFilePrimitiveDuplicates(serverName, tools);
  if (profile === 'write') {
    return nativeFilteredTools;
  }
  // readonly profile：剔除**能证明是写操作**的工具（server 注解声明非只读 /
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

const resolveMcpGatewayTool = (
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

const executeMcpGatewayToolWithTimeout = async (
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

const createPoolKey = (
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

const createCatalogKey = (
  serverName: TMcpServerName,
  profile: TMcpGatewayToolProfile,
): string => `${serverName}::${profile}`;

const readErrors = (bundle: IMcpGatewayBundle): string[] => bundle.errors ?? [];
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

const createCatalogFromBundle = (
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

const createToolUnavailableError = (
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

export class McpGatewayMetricBuffer implements IMcpGatewayMetricSink {
  private readonly metrics: TMcpGatewayMetric[] = [];
  private listener: ((metric: TMcpGatewayMetric) => void) | null = null;
  private droppedCount = 0;

  emit(metric: TMcpGatewayMetric): void {
    if (this.listener) {
      this.listener(metric);
      return;
    }
    this.metrics.push(metric);
    if (this.metrics.length > METRIC_BUFFER_MAX) {
      this.metrics.shift();
      this.droppedCount += 1;
    }
  }

  setListener(listener: (metric: TMcpGatewayMetric) => void): void {
    this.listener = listener;
    while (this.metrics.length > 0) {
      const metric = this.metrics.shift();
      if (metric) {
        listener(metric);
      }
    }
    if (this.droppedCount > 0) {
      listener({ type: 'mcp_gateway.metric_buffer_dropped', droppedCount: this.droppedCount });
      this.droppedCount = 0;
    }
  }
}

export class McpGatewayWarmPool {
  private readonly createBundle: TMcpGatewayCreateBundle;
  private readonly maxWarm: number;
  private readonly ttlIdleMs: number;
  private readonly pinnedServers: ReadonlySet<TMcpServerName>;
  private readonly pinnedServersIgnoreWorkspace: ReadonlySet<TMcpServerName>;
  private readonly callTimeoutMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, IMcpGatewayPoolEntry>();
  private readonly catalog = new Map<string, IMcpGatewayCatalog>();
  private readonly toolCallCounts = new Map<string, number>();
  private readonly listAllInflight = new Map<string, Promise<IMcpGatewayCatalogCollection>>();

  constructor(options: IMcpGatewayPoolOptions) {
    this.createBundle = options.createBundle;
    this.maxWarm = options.maxWarm ?? DEFAULT_MCP_GATEWAY_MAX_WARM;
    this.ttlIdleMs = options.ttlIdleMs ?? DEFAULT_MCP_GATEWAY_TTL_IDLE_MS;
    this.pinnedServers = new Set(options.pinnedServers ?? DEFAULT_MCP_GATEWAY_PINNED_SERVERS);
    this.pinnedServersIgnoreWorkspace = new Set(
      options.pinnedServersIgnoreWorkspace ?? DEFAULT_MCP_GATEWAY_PINNED_SERVERS_IGNORE_WORKSPACE,
    );
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  createMetricBuffer(): McpGatewayMetricBuffer {
    return new McpGatewayMetricBuffer();
  }

  createTools(options: {
    workspaceRootPath?: string;
    profile: TMcpGatewayToolProfile;
    metricSink?: IMcpGatewayMetricSink;
  }): Record<typeof MCP_GATEWAY_TOOL_NAMES[number], ReturnType<typeof createTool>> {
    return {
      mcp_list_tools: createTool({
        id: 'mcp_list_tools',
        description: [
          '一次性列出所有 MCP server 的工具目录。',
          '这是无参数工具；不要为不同 server 重复调用，也不要传 serverName。',
          '目录来自 sidecar 缓存，完整返回所有可用工具名和描述，不暴露完整 schema。',
          '首次调用可能触发 MCP server 冷启动（可能数秒），后续调用走缓存。',
          '已知 tool 名称时应直接用 mcp_call_tool 调用，避免不必要的目录浏览。',
        ].join('\n'),
        inputSchema: mcpGatewayListInputSchema,
        execute: async (inputData) => {
          mcpGatewayListLegacyInputSchema.parse(unwrapGatewayToolInput(inputData));
          const baseInput = {
            profile: options.profile,
            ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
            ...(options.metricSink ? { metricSink: options.metricSink } : {}),
          };

          return await this.listAllTools(baseInput);
        },
        toModelOutput: (output) => createJsonToolModelOutput(output),
      }),
      mcp_call_tool: createTool({
        id: 'mcp_call_tool',
        description: [
          '直接按 serverName 和 toolName 调用 MCP 工具。',
          '已知道 tool 名称时应直接调用，只有不确定名称时才先用 mcp_list_tools 探索。',
        ].join('\n'),
        inputSchema: mcpGatewayCallInputSchema,
        requireApproval: async (rawInput) => {
          let parsed: z.infer<typeof mcpGatewayCallInputSchema>;
          try {
            parsed = mcpGatewayCallInputSchema.parse(unwrapGatewayToolInput(rawInput));
          } catch {
            // 无法解析调用目标 → 无法判定能力 → fail-closed。
            return true;
          }
          return await this.requiresToolApproval({
            serverName: parsed.serverName,
            toolName: parsed.toolName,
            profile: options.profile,
            ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
            ...(options.metricSink ? { metricSink: options.metricSink } : {}),
          });
        },
        execute: async (inputData) => {
          const parsed = mcpGatewayCallInputSchema.parse(unwrapGatewayToolInput(inputData));
          return await this.callTool({
            serverName: parsed.serverName,
            toolName: parsed.toolName,
            arguments: parsed.arguments,
            profile: options.profile,
            ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
            ...(options.metricSink ? { metricSink: options.metricSink } : {}),
          });
        },
        toModelOutput: (output) => createJsonToolModelOutput(compactModelOutput(output, {
          maxTotalChars: MCP_GATEWAY_MODEL_OUTPUT_MAX_CHARS,
          maxStringChars: MCP_GATEWAY_MODEL_OUTPUT_MAX_STRING_CHARS,
          maxArrayItems: MCP_GATEWAY_MODEL_OUTPUT_MAX_ARRAY_ITEMS,
          maxObjectKeys: MCP_GATEWAY_MODEL_OUTPUT_MAX_OBJECT_KEYS,
          maxDepth: MCP_GATEWAY_MODEL_OUTPUT_MAX_DEPTH,
        })),
      }),
    };
  }

  // 判定某次 MCP 工具调用是否需要人工审批：依据 server 在 tools/list 自报、
  // 经 @mastra/mcp 透传到 tool.mcp.annotations 的能力注解，不依赖工具名形态。
  // 任何无法正向判定为只读的情况（含未自报注解、解析失败、启动失败）一律
  // fail-closed 要求审批。
  async requiresToolApproval(input: {
    serverName: TMcpServerName;
    toolName: string;
    profile: TMcpGatewayToolProfile;
    workspaceRootPath?: string;
    metricSink?: IMcpGatewayMetricSink;
  }): Promise<boolean> {
    // 快路径：server 级无副作用白名单无需启动 server 即可免审批。
    if (SIDE_EFFECT_FREE_SERVERS.has(input.serverName)) {
      return false;
    }
    try {
      return await this.withServer(input, (bundle) => {
        const tools = filterMcpToolsForProfile(input.serverName, bundle.tools, input.profile);
        const resolved = resolveMcpGatewayTool(tools, input.serverName, input.toolName);
        if (!resolved) {
          // 解析不到目标工具 → 能力未知 → fail-closed。
          return true;
        }
        const annotations = readMcpToolAnnotations(resolved.tool);
        return requiresMcpToolApproval(input.serverName, annotations);
      });
    } catch {
      // 启动 / 列举工具失败 → 无法判定能力 → fail-closed。
      return true;
    }
  }

  async primeCatalog(options: {
    workspaceRootPath?: string;
    serverNames?: readonly TMcpServerName[];
    metricSink?: IMcpGatewayMetricSink;
  } = {}): Promise<void> {
    const serverNames = options.serverNames ?? MCP_SERVER_NAMES;
    for (const serverName of serverNames) {
      const startedAt = this.now();
      await this.withServer({
        serverName,
        ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
        ...(options.metricSink ? { metricSink: options.metricSink } : {}),
      }, (bundle) => {
        this.cacheCatalogVariants(serverName, bundle);
      }).catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        options.metricSink?.emit({
          type: 'mcp_gateway.boot_failed',
          serverName,
          durationMs: this.now() - startedAt,
          errorMessage,
        });
      });
    }
  }

  async listTools(input: {
    serverName: TMcpServerName;
    profile: TMcpGatewayToolProfile;
    workspaceRootPath?: string;
    metricSink?: IMcpGatewayMetricSink;
  }): Promise<IMcpGatewayCatalog> {
    const startedAt = this.now();
    const catalogKey = createCatalogKey(input.serverName, input.profile);
    const cached = this.catalog.get(catalogKey);
    if (cached) {
      this.emitCatalogMetric(input, true, startedAt, cached);
      return cached;
    }
    const catalog = await this.withServer(input, (bundle) => {
      this.cacheCatalogVariants(input.serverName, bundle);
      return this.catalog.get(catalogKey) ?? createCatalogFromBundle(input.serverName, input.profile, bundle);
    });
    this.emitCatalogMetric(input, false, startedAt, catalog);
    return catalog;
  }

  async listAllTools(input: {
    profile: TMcpGatewayToolProfile;
    workspaceRootPath?: string;
    metricSink?: IMcpGatewayMetricSink;
  }): Promise<IMcpGatewayCatalogCollection> {
    const key = `${input.workspaceRootPath ? resolve(input.workspaceRootPath) : '<default>'}::${input.profile}`;
    const inflight = this.listAllInflight.get(key);
    if (inflight) {
      return await inflight;
    }

    const task = this.listAllToolsUncached(input).finally(() => {
      this.listAllInflight.delete(key);
    });
    this.listAllInflight.set(key, task);
    return await task;
  }

  private async listAllToolsUncached(input: {
    profile: TMcpGatewayToolProfile;
    workspaceRootPath?: string;
    metricSink?: IMcpGatewayMetricSink;
  }): Promise<IMcpGatewayCatalogCollection> {
    const catalogs: IMcpGatewayCatalog[] = [];
    const errors: string[] = [];

    for (const serverName of MCP_SERVER_NAMES) {
      try {
        const catalog = await this.listTools({
          serverName,
          profile: input.profile,
          ...(input.workspaceRootPath ? { workspaceRootPath: input.workspaceRootPath } : {}),
          ...(input.metricSink ? { metricSink: input.metricSink } : {}),
        });
        catalogs.push(catalog);
        errors.push(...catalog.errors.map((message) => `${serverName}: ${message}`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${serverName}: ${message}`);
        catalogs.push({
          serverName,
          profile: input.profile,
          tools: [],
          errors: [message],
        });
      }
    }

    return {
      profile: input.profile,
      catalogs,
      errors,
    };
  }

  async callTool(input: {
    serverName: TMcpServerName;
    toolName: string;
    arguments: Record<string, unknown>;
    profile: TMcpGatewayToolProfile;
    workspaceRootPath?: string;
    metricSink?: IMcpGatewayMetricSink;
  }): Promise<{
    serverName: TMcpServerName;
    toolName: string;
    result: unknown;
  }> {
    const startedAt = this.now();
    return await this.withServer(input, async (bundle) => {
      const tools = filterMcpToolsForProfile(input.serverName, bundle.tools, input.profile);
      const resolvedTool = resolveMcpGatewayTool(tools, input.serverName, input.toolName);
      if (!resolvedTool) {
        throw createToolUnavailableError(
          input.serverName,
          input.toolName,
          bundle,
          input.profile,
          Object.keys(tools),
        );
      }
      const frequencyKey = `${input.serverName}/${resolvedTool.name}`;
      try {
        const result = await executeMcpGatewayToolWithTimeout(
          resolvedTool.tool,
          input.arguments,
          this.callTimeoutMs,
        );
        const toolCallCount = (this.toolCallCounts.get(frequencyKey) ?? 0) + 1;
        this.toolCallCounts.set(frequencyKey, toolCallCount);
        input.metricSink?.emit({
          type: 'mcp_gateway.call',
          serverName: input.serverName,
          requestedToolName: input.toolName,
          resolvedToolName: resolvedTool.name,
          durationMs: this.now() - startedAt,
          activeBundleCount: this.countActiveBundles(),
          warmBundleCount: this.countWarmBundles(),
          toolCallCount,
          errorCount: readErrors(bundle).length,
        });
        return {
          serverName: input.serverName,
          toolName: resolvedTool.name,
          result,
        };
      } catch (error) {
        input.metricSink?.emit({
          type: 'mcp_gateway.call',
          serverName: input.serverName,
          requestedToolName: input.toolName,
          resolvedToolName: resolvedTool.name,
          durationMs: this.now() - startedAt,
          activeBundleCount: this.countActiveBundles(),
          warmBundleCount: this.countWarmBundles(),
          toolCallCount: this.toolCallCounts.get(frequencyKey) ?? 0,
          errorCount: readErrors(bundle).length + 1,
        });
        throw error;
      }
    });
  }

  async disconnectAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.catalog.clear();
    this.toolCallCounts.clear();
    this.listAllInflight.clear();
    await Promise.all(entries.map(async (entry) => {
      this.clearIdleTimer(entry);
      // 等待在途创建完成：否则刚创建好的 bundle（含 MCP 子进程）会脱离 entries map 成为孤儿。
      if (entry.creating) {
        await entry.creating.catch(() => undefined);
      }
      await entry.bundle?.disconnectAll().catch(() => undefined);
    }));
  }

  private async withServer<T>(
    input: { serverName: TMcpServerName; workspaceRootPath?: string; metricSink?: IMcpGatewayMetricSink },
    action: (bundle: IMcpGatewayBundle) => T | Promise<T>,
  ): Promise<T> {
    const entry = await this.ensureEntry(input);
    entry.activeCount += 1;
    this.clearIdleTimer(entry);
    try {
      const bundle = entry.bundle;
      if (!bundle) {
        throw new Error(`MCP server ${input.serverName} 未完成初始化。`);
      }
      return await action(bundle);
    } finally {
      entry.activeCount = Math.max(0, entry.activeCount - 1);
      entry.lastUsedAt = this.now();
      this.scheduleIdleDisconnect(entry);
      void this.evictOverflow().catch(() => undefined);
    }
  }

  private async ensureEntry(input: {
    serverName: TMcpServerName;
    workspaceRootPath?: string;
    metricSink?: IMcpGatewayMetricSink;
  }): Promise<IMcpGatewayPoolEntry> {
    await this.evictExpired();
    const key = createPoolKey(input.workspaceRootPath, input.serverName, this.pinnedServersIgnoreWorkspace);
    const existing = this.entries.get(key);
    if (existing?.bundle) {
      existing.lastUsedAt = this.now();
      return existing;
    }
    if (existing?.creating) {
      return await existing.creating;
    }
    const entry: IMcpGatewayPoolEntry = {
      key,
      serverName: input.serverName,
      ...(input.workspaceRootPath ? { workspaceRootPath: input.workspaceRootPath } : {}),
      activeCount: 0,
      lastUsedAt: this.now(),
    };
    const startedAt = this.now();
    entry.creating = this.createBundle({
      ...(input.workspaceRootPath ? { workspaceRootPath: input.workspaceRootPath } : {}),
      serverNames: [input.serverName],
    }).then((bundle) => {
      entry.bundle = bundle;
      delete entry.creating;
      entry.lastUsedAt = this.now();
      this.cacheCatalogVariants(input.serverName, bundle);
      this.scheduleIdleDisconnect(entry);
      input.metricSink?.emit({
        type: 'mcp_gateway.boot',
        serverName: input.serverName,
        durationMs: this.now() - startedAt,
        activeBundleCount: this.countActiveBundles(),
        warmBundleCount: this.countWarmBundles(),
        toolCount: Object.keys(bundle.tools).length,
        errorCount: readErrors(bundle).length,
      });
      void this.evictOverflow().catch(() => undefined);
      return entry;
    }).catch((error: unknown) => {
      this.entries.delete(key);
      delete entry.creating;
      throw error;
    });
    this.entries.set(key, entry);
    return await entry.creating;
  }

  private cacheCatalogVariants(serverName: TMcpServerName, bundle: IMcpGatewayBundle): void {
    this.catalog.set(createCatalogKey(serverName, 'write'), createCatalogFromBundle(serverName, 'write', bundle));
    this.catalog.set(createCatalogKey(serverName, 'readonly'), createCatalogFromBundle(serverName, 'readonly', bundle));
  }

  private emitCatalogMetric(
    input: {
      serverName: TMcpServerName;
      profile: TMcpGatewayToolProfile;
      metricSink?: IMcpGatewayMetricSink;
    },
    cacheHit: boolean,
    startedAt: number,
    catalog: IMcpGatewayCatalog,
  ): void {
    input.metricSink?.emit({
      type: 'mcp_gateway.catalog',
      serverName: input.serverName,
      profile: input.profile,
      cacheHit,
      durationMs: this.now() - startedAt,
      activeBundleCount: this.countActiveBundles(),
      warmBundleCount: this.countWarmBundles(),
      toolCount: catalog.tools.length,
      errorCount: catalog.errors.length,
    });
  }

  private countWarmBundles(): number {
    return [...this.entries.values()].filter((entry) => Boolean(entry.bundle)).length;
  }

  private countActiveBundles(): number {
    return [...this.entries.values()].filter((entry) => entry.activeCount > 0).length;
  }

  private clearIdleTimer(entry: IMcpGatewayPoolEntry): void {
    if (!entry.idleTimer) {
      return;
    }
    clearTimeout(entry.idleTimer);
    delete entry.idleTimer;
  }

  private scheduleIdleDisconnect(entry: IMcpGatewayPoolEntry): void {
    this.clearIdleTimer(entry);
    if (!entry.bundle || this.pinnedServers.has(entry.serverName)) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      if (entry.activeCount > 0 || !entry.bundle) {
        return;
      }
      if (this.now() - entry.lastUsedAt < this.ttlIdleMs) {
        this.scheduleIdleDisconnect(entry);
        return;
      }
      void this.disconnectEntry(entry).catch(() => undefined);
    }, this.ttlIdleMs);
    entry.idleTimer.unref();
  }

  private async evictExpired(): Promise<void> {
    const now = this.now();
    const expiredEntries = [...this.entries.values()].filter((entry) => (
      Boolean(entry.bundle)
      && entry.activeCount === 0
      && !this.pinnedServers.has(entry.serverName)
      && now - entry.lastUsedAt >= this.ttlIdleMs
    ));
    await Promise.all(expiredEntries.map((entry) => this.disconnectEntry(entry)));
  }

  private async evictOverflow(): Promise<void> {
    const candidates = [...this.entries.values()]
      .filter((entry) => (
        Boolean(entry.bundle)
        && entry.activeCount === 0
        && !this.pinnedServers.has(entry.serverName)
      ))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    while (this.countWarmBundles() > this.maxWarm && candidates.length > 0) {
      const entry = candidates.shift();
      if (entry) {
        await this.disconnectEntry(entry);
      }
    }
  }

  private async disconnectEntry(entry: IMcpGatewayPoolEntry): Promise<void> {
    this.clearIdleTimer(entry);
    this.entries.delete(entry.key);
    const bundle = entry.bundle;
    delete entry.bundle;
    if (bundle) {
      await bundle.disconnectAll().catch(() => undefined);
    }
  }
}

export const createMcpGatewayWarmPool = (
  options: IMcpGatewayPoolOptions,
): McpGatewayWarmPool => new McpGatewayWarmPool(options);
