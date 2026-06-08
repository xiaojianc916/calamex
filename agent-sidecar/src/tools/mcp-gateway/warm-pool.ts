import { createTool } from '@mastra/core/tools';
import { resolve } from 'node:path';
import { z } from 'zod';
import { compactModelOutput } from '../../models/output-budget.js';
import { createJsonToolModelOutput } from '../../engines/budget/budget.js';
import { MCP_SERVER_NAMES, type TMcpServerName } from '../mcp.js';
import type {
  IMcpGatewayBundle,
  IMcpGatewayCatalog,
  IMcpGatewayCatalogCollection,
  IMcpGatewayMetricSink,
  IMcpGatewayPoolEntry,
  IMcpGatewayPoolOptions,
  TMcpGatewayCreateBundle,
  TMcpGatewayToolProfile,
} from './types.js';
import {
  SIDE_EFFECT_FREE_SERVERS,
  readMcpToolAnnotations,
  requiresMcpToolApproval,
} from './capability.js';
import {
  MCP_GATEWAY_TOOL_NAMES,
  createCatalogFromBundle,
  createCatalogKey,
  createPoolKey,
  createToolUnavailableError,
  executeMcpGatewayToolWithTimeout,
  filterMcpToolsForProfile,
  mcpGatewayCallInputSchema,
  mcpGatewayListInputSchema,
  mcpGatewayListLegacyInputSchema,
  readErrors,
  resolveMcpGatewayTool,
  unwrapGatewayToolInput,
} from './tool-helpers.js';
import { McpGatewayMetricBuffer } from './metrics.js';

const DEFAULT_MCP_GATEWAY_MAX_WARM = 4;
const DEFAULT_MCP_GATEWAY_TTL_IDLE_MS = 5 * 60_000;
const DEFAULT_MCP_GATEWAY_PINNED_SERVERS: readonly TMcpServerName[] = ['memory'];
const DEFAULT_MCP_GATEWAY_PINNED_SERVERS_IGNORE_WORKSPACE: readonly TMcpServerName[] = ['memory'];
const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;

const MCP_GATEWAY_MODEL_OUTPUT_MAX_CHARS = 4_000;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_STRING_CHARS = 1_500;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_ARRAY_ITEMS = 20;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_OBJECT_KEYS = 40;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_DEPTH = 6;

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
  private disconnectAllPromise: Promise<void> | null = null;

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
    if (this.disconnectAllPromise) {
      return this.disconnectAllPromise;
    }
    this.disconnectAllPromise = this.disconnectAllEntries().finally(() => {
      this.disconnectAllPromise = null;
    });
    return this.disconnectAllPromise;
  }

  private async disconnectAllEntries(): Promise<void> {
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
      // createBundle 完成路径会重新 schedule idle timer；断开前必须再清一次，避免 stale timer 挂到已移除 entry。
      this.clearIdleTimer(entry);
      const bundle = entry.bundle;
      delete entry.bundle;
      delete entry.creating;
      await bundle?.disconnectAll().catch(() => undefined);
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
