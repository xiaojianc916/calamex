import type { ToolsInput } from '@mastra/core/agent';
import type { IMcpServerConfig, TMcpServerName } from '../client.js';

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

export interface IMcpGatewayPoolOptions {
  createBundle: TMcpGatewayCreateBundle;
  maxWarm?: number;
  ttlIdleMs?: number;
  pinnedServers?: readonly TMcpServerName[];
  pinnedServersIgnoreWorkspace?: readonly TMcpServerName[];
  callTimeoutMs?: number;
  now?: () => number;
}

export interface IMcpGatewayPoolEntry {
  key: string;
  serverName: TMcpServerName;
  workspaceRootPath?: string;
  bundle?: IMcpGatewayBundle;
  creating?: Promise<IMcpGatewayPoolEntry>;
  activeCount: number;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
}

export interface IMcpGatewayResolvedTool {
  name: string;
  tool: unknown;
}

export interface IMcpGatewayExecutableTool {
  execute: (inputData: unknown) => unknown | Promise<unknown>;
}
