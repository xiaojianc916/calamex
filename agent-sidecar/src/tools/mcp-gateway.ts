import { resolve } from 'node:path';

import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  MCP_SERVER_NAMES,
  type IMcpServerConfig,
  type TMcpServerName,
} from './mcp.js';
import {
  compactModelOutput,
  truncateModelOutputText,
} from '../models/model-output-budget.js';

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
  toolCount: number;
  tools: IMcpGatewayCatalogTool[];
  errors: string[];
  unavailableReason?: string;
}

interface IMcpGatewayPoolOptions {
  createBundle: TMcpGatewayCreateBundle;
  maxWarm?: number;
  ttlIdleMs?: number;
  pinnedServers?: readonly TMcpServerName[];
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
const MCP_GATEWAY_TOOL_DESCRIPTION_MAX_CHARS = 240;
const MCP_GATEWAY_CATALOG_MODEL_OUTPUT_MAX_CHARS = 2_500;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_CHARS = 4_000;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_STRING_CHARS = 1_500;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_ARRAY_ITEMS = 20;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_OBJECT_KEYS = 40;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_DEPTH = 6;

const READONLY_MCP_TOOL_DENY_PATTERN =
  /(?:^|[_*-])(write|edit|create|move|delete|remove|run|exec|execute|shell|install|apply|commit|checkout|reset|add|stage|unstage|discard|drop|push|pull|merge|rebase|stash|upload|send|post|put|patch|update|insert|replace)(?:$|[_*-])/iu;
const GIT_NATIVE_FILE_DUPLICATE_TOOL_PATTERN =
  /(?:^|[_*-])(?:read_file|write_file|edit_file|create_directory|move_file|delete_file|grep)(?:$|[_*-])/iu;
const PROBE_NATIVE_FILE_DUPLICATE_TOOL_PATTERN =
  /(?:^|[_*-])(?:grep|search_code|search_files|extract_code|read_file|list_files)(?:$|[_*-])/iu;

export const MCP_GATEWAY_TOOL_NAMES = ['mcp_list_tools', 'mcp_call_tool'] as const;

const mcpGatewayServerNameSchema = z.enum(MCP_SERVER_NAMES);
const mcpGatewayListInputSchema = z.object({
  serverName: mcpGatewayServerNameSchema,
});
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

const toRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const unwrapGatewayToolInput = (value: unknown): unknown => {
  const record = toRecord(value);

  if (!record) {
    return {};
  }

  if ('serverName' in record || 'toolName' in record) {
    return record;
  }

  const input = toRecord(record.input);
  if (input) {
    return input;
  }

  const args = toRecord(record.arguments);
  if (args) {
    return args;
  }

  return record;
};

const createJsonToolModelOutput = (value: unknown): { type: 'json'; value: unknown } => ({
  type: 'json',
  value,
});

const getToolDescription = (tool: unknown): string => {
  const record = toRecord(tool);
  const description = record?.description;

  return typeof description === 'string' ? description : '';
};

const createCompactToolDescription = (tool: unknown): string => {
  const normalized = getToolDescription(tool).replace(/\s+/gu, ' ').trim();
  const truncated = truncateModelOutputText(
    normalized,
    MCP_GATEWAY_TOOL_DESCRIPTION_MAX_CHARS,
    { includeNotice: false },
  );

  return truncated.truncated ? `${truncated.text}...` : truncated.text;
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

const filterMcpToolsForProfile = (
  serverName: TMcpServerName,
  tools: ToolsInput,
  profile: TMcpGatewayToolProfile,
): ToolsInput => {
  const nativeFilteredTools = filterNativeFilePrimitiveDuplicates(serverName, tools);

  if (profile === 'write') {
    return nativeFilteredTools;
  }

  const filteredTools: ToolsInput = {};

  for (const [name, tool] of Object.entries(nativeFilteredTools)) {
    if (!READONLY_MCP_TOOL_DENY_PATTERN.test(name)) {
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

const executeMcpGatewayTool = async (tool: unknown, input: unknown): Promise<unknown> => {
  if (!isExecutableTool(tool)) {
    throw new Error('目标 MCP tool 没有可执行入口。');
  }

  return await tool.execute(input);
};

const createPoolKey = (
  workspaceRootPath: string | undefined,
  serverName: TMcpServerName,
): string => {
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
    return `当前 profile 不允许使用 ${serverName} 的任何 MCP tool。`;
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
    description: createCompactToolDescription(tool),
  }));
  const unavailableReason = createUnavailableReason(
    serverName,
    bundle,
    profile,
    toolEntries.length,
  );

  return {
    serverName,
    profile,
    toolCount: toolEntries.length,
    tools: toolEntries,
    errors: readErrors(bundle),
    ...(unavailableReason ? { unavailableReason } : {}),
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
  const details = [
    `MCP tool 不可用：${serverName}/${toolName}`,
    availableTools.length > 0 ? `可用工具：${availableTools.join(', ')}` : unavailableReason,
    ...(readErrors(bundle).length > 0 ? [`错误：${readErrors(bundle).join('；')}`] : []),
  ].filter((line): line is string => typeof line === 'string' && line.length > 0);

  return new Error(details.join('\n'));
};

export class McpGatewayMetricBuffer implements IMcpGatewayMetricSink {
  private readonly metrics: TMcpGatewayMetric[] = [];

  private listener: ((metric: TMcpGatewayMetric) => void) | null = null;

  emit(metric: TMcpGatewayMetric): void {
    if (this.listener) {
      this.listener(metric);
      return;
    }

    this.metrics.push(metric);
  }

  setListener(listener: (metric: TMcpGatewayMetric) => void): void {
    this.listener = listener;

    while (this.metrics.length > 0) {
      const metric = this.metrics.shift();

      if (metric) {
        listener(metric);
      }
    }
  }
}

export class McpGatewayWarmPool {
  private readonly createBundle: TMcpGatewayCreateBundle;

  private readonly maxWarm: number;

  private readonly ttlIdleMs: number;

  private readonly pinnedServers: ReadonlySet<TMcpServerName>;

  private readonly now: () => number;

  private readonly entries = new Map<string, IMcpGatewayPoolEntry>();

  private readonly catalog = new Map<string, IMcpGatewayCatalog>();

  private readonly toolCallCounts = new Map<string, number>();

  constructor(options: IMcpGatewayPoolOptions) {
    this.createBundle = options.createBundle;
    this.maxWarm = options.maxWarm ?? DEFAULT_MCP_GATEWAY_MAX_WARM;
    this.ttlIdleMs = options.ttlIdleMs ?? DEFAULT_MCP_GATEWAY_TTL_IDLE_MS;
    this.pinnedServers = new Set(options.pinnedServers ?? DEFAULT_MCP_GATEWAY_PINNED_SERVERS);
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
        description: '列出指定 MCP server 的工具目录；仅在不确定 tool 名称时用于探索。目录来自 sidecar 缓存，只返回工具名和描述，不暴露完整 schema。',
        inputSchema: mcpGatewayListInputSchema,
        execute: async (inputData) => {
          const { serverName } = mcpGatewayListInputSchema.parse(unwrapGatewayToolInput(inputData));

          return await this.listTools({
            serverName,
            profile: options.profile,
            ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
            ...(options.metricSink ? { metricSink: options.metricSink } : {}),
          });
        },
        toModelOutput: (output) => createJsonToolModelOutput(compactModelOutput(output, {
          maxTotalChars: MCP_GATEWAY_CATALOG_MODEL_OUTPUT_MAX_CHARS,
          maxStringChars: MCP_GATEWAY_TOOL_DESCRIPTION_MAX_CHARS + 3,
          maxArrayItems: MCP_GATEWAY_MODEL_OUTPUT_MAX_ARRAY_ITEMS,
          maxObjectKeys: MCP_GATEWAY_MODEL_OUTPUT_MAX_OBJECT_KEYS,
          maxDepth: MCP_GATEWAY_MODEL_OUTPUT_MAX_DEPTH,
        })),
      }),
      mcp_call_tool: createTool({
        id: 'mcp_call_tool',
        description: '直接按 serverName 和 toolName 调用 MCP 工具；已知道 tool 名称时应直接调用，只有不确定名称时才先用 mcp_list_tools 探索。',
        inputSchema: mcpGatewayCallInputSchema,
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

  async primeCatalog(options: {
    workspaceRootPath?: string;
    serverNames?: readonly TMcpServerName[];
  } = {}): Promise<void> {
    const serverNames = options.serverNames ?? MCP_SERVER_NAMES;

    for (const serverName of serverNames) {
      await this.withServer({
        serverName,
        ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
      }, (bundle) => {
        this.cacheCatalogVariants(serverName, bundle);
      }).catch(() => undefined);
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

      try {
        const result = await executeMcpGatewayTool(resolvedTool.tool, input.arguments);
        const frequencyKey = `${input.serverName}/${resolvedTool.name}`;
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
          toolCallCount: this.toolCallCounts.get(`${input.serverName}/${resolvedTool.name}`) ?? 0,
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

    await Promise.all(entries.map(async (entry) => {
      this.clearIdleTimer(entry);
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
      void this.evictOverflow();
    }
  }

  private async ensureEntry(input: {
    serverName: TMcpServerName;
    workspaceRootPath?: string;
    metricSink?: IMcpGatewayMetricSink;
  }): Promise<IMcpGatewayPoolEntry> {
    await this.evictExpired();

    const key = createPoolKey(input.workspaceRootPath, input.serverName);
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
      this.entries.set(key, entry);
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
      void this.evictOverflow();
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
      toolCount: catalog.toolCount,
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

      const bundle = entry.bundle;

      this.entries.delete(entry.key);
      delete entry.bundle;
      void bundle.disconnectAll().catch(() => undefined);
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
    await entry.bundle?.disconnectAll().catch(() => undefined);
    delete entry.bundle;
  }
}

export const createMcpGatewayWarmPool = (
  options: IMcpGatewayPoolOptions,
): McpGatewayWarmPool => new McpGatewayWarmPool(options);
