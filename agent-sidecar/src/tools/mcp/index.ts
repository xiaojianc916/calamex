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
} from './gateway/types.js';

export type {
  IMcpToolAnnotations,
  TMcpToolCapability,
} from './gateway/capability.js';

export {
  createMcpGatewayToolDescriptor,
  readMcpToolAnnotations,
  requiresMcpToolApproval,
  resolveMcpToolApprovalDefault,
  resolveMcpToolCapability,
} from './gateway/capability.js';

export {
  MCP_GATEWAY_TOOL_NAMES,
  createMcpGatewayRunBundle,
} from './gateway/helpers.js';

export { McpGatewayMetricBuffer } from './gateway/metrics.js';

export {
  McpGatewayWarmPool,
  createMcpGatewayWarmPool,
} from './gateway/warm-pool.js';
