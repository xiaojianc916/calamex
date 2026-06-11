// mcp-gateway 拆分后的公共入口（barrel）。
// 实现已拆到 ./mcp-gateway/ 子目录；本文件仅原样转出原有对外接口，
// 保证外部对 './mcp-gateway.js' 的导入路径与符号保持不变。

export type {
  IMcpGatewayBundle,
  IMcpGatewayCatalog,
  IMcpGatewayCatalogCollection,
  IMcpGatewayCatalogTool,
  IMcpGatewayMetricSink,
  TMcpGatewayCreateBundle,
  TMcpGatewayMetric,
  TMcpGatewayToolProfile,
} from './mcp-gateway/types.js';

export type {
  IMcpToolAnnotations,
  TMcpToolCapability,
} from './mcp-gateway/capability.js';

export {
  createMcpGatewayToolDescriptor,
  readMcpToolAnnotations,
  requiresMcpToolApproval,
  resolveMcpToolApprovalDefault,
  resolveMcpToolCapability,
} from './mcp-gateway/capability.js';

export {
  MCP_GATEWAY_TOOL_NAMES,
  createMcpGatewayRunBundle,
} from './mcp-gateway/tool-helpers.js';

export { McpGatewayMetricBuffer } from './mcp-gateway/metrics.js';

export {
  McpGatewayWarmPool,
  createMcpGatewayWarmPool,
} from './mcp-gateway/warm-pool.js';
