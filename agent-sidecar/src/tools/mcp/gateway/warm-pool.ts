import { createTool } from '@mastra/core/tools';
import { resolve } from 'node:path';
import { MCP_SERVER_NAMES, type TMcpServerName } from '../client.js';
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
  resolveMcpToolApprovalDefault,
} from './capability.js';
import {
  MCP_GATEWAY_TOOL_NAMES,
  createCatalogFromBundle,
  createCatalogKey,
  createPoolKey,
  createToolUnavailableError,
  executeMcpGatewayToolWithTimeout,
  filterMcpToolsForProfile,
  readErrors,
  resolveMcpGatewayTool,
} from './helpers.js';
import { McpGatewayMetricBuffer } from './metrics.js';
import { createMcpListTool } from './tools/list-tools.js';
import { createMcpCallTool } from './tools/call-tool.js';

const DEFAULT_MCP_GATEWAY_MAX_WARM = 4;
const DEFAULT_MCP_GATEWAY_TTL_IDLE_MS = 5 * 60_000;
const DEFAULT_MCP_GATEWAY_PINNED_SERVERS: readonly TMcpServerName[] = ['memory'];
const DEFAULT_MCP_GATEWAY_PINNED_SERVERS_IGNORE_WORKSPACE: readonly TMcpServerName[] = ['memory'];
const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;


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
  private isDisposed = false;

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
      mcp_list_tools: createMcpListTool(this, options),
      mcp_call_tool: createMcpCallTool(this, options),
    };
  }

  // 判定某次 MCP 工具调用是否需要人工审批：先把 @mastra/mcp 从 tools/list
  // 透传出的 annotations 归一成 Calamex 的 IAgentToolDescriptor，再复用统一
  // descriptor approval 规则。这样 MCP、workspace、browser/internal 工具不再
  // 各自维护一套审批默认值。
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
        return resolveMcpToolApprovalDefault(input.serverName, resolved.name, annotations);
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

    // 并行列举所有 MCP 服务工具：各服务互不依赖，串行等待会线性叠加
    // spawn + listTools 延迟（每个未在暖池中的服务需 spawn 子进程，超时 30s）。
    // 并发度受 maxWarm 限制，避免同时 spawn 超过暖池上限导致 spawn→evict 抖动。
    // ensureEntry 内部的 evictOverflow + catalog 缓存保证：即使被 evict 的服务，
    // 其 catalog 已在 bundle 创建成功时缓存，后续调用走缓存零开销。
    const concurrency = Math.min(MCP_SERVER_NAMES.length, this.maxWarm);
    let cursor = 0;
    // 保持原始顺序：按 MCP_SERVER_NAMES 顺序整理结果
    const byName = new Map<string, { ok: boolean; catalog?: IMcpGatewayCatalog; message?: string | undefined }>();
    await Promise.allSettled(
      Array.from({ length: concurrency }, async () => {
        while (cursor < MCP_SERVER_NAMES.length) {
          const serverName = MCP_SERVER_NAMES[cursor] as TMcpServerName;
          cursor += 1;
          try {
            const catalog = await this.listTools({
              serverName,
              profile: input.profile,
              ...(input.workspaceRootPath ? { workspaceRootPath: input.workspaceRootPath } : {}),
              ...(input.metricSink ? { metricSink: input.metricSink } : {}),
            });
            byName.set(serverName, { ok: true, catalog });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            byName.set(serverName, { ok: false, message });
          }
        }
      }),
    );

    for (const serverName of MCP_SERVER_NAMES) {
      const entry = byName.get(serverName);
      if (entry?.ok && entry.catalog) {
        catalogs.push(entry.catalog);
        errors.push(...entry.catalog.errors.map((message) => `${serverName}: ${message}`));
      } else if (entry && !entry.ok) {
        const message = entry.message ?? 'Unknown error';
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
    this.isDisposed = true;
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
    if (this.isDisposed) {
      throw new Error('MCP gateway warm pool 已关闭。');
    }
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
      if (this.isDisposed) {
        return bundle.disconnectAll().catch(() => undefined).then(() => entry);
      }
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
    if (this.isDisposed || !entry.bundle || this.pinnedServers.has(entry.serverName)) {
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
