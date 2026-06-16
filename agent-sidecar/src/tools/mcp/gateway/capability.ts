import { createMcpToolDescriptor, resolveDescriptorApprovalDefault, type IAgentToolDescriptor } from '../../../engines/policy/tool-descriptor.js';
import { toRecord } from '../../../engines/shared/utils.js';
import type { TMcpServerName } from '../client.js';

// ── MCP 工具能力模型（capability model）─────────────────────────────
// MCP 工具不再维护一套独立的“审批判断逻辑”。能力判定只负责把 MCP 协议层
// annotations 转换为 Calamex 统一的 IAgentToolDescriptor；是否默认审批则复用
// engines/policy/tool-descriptor.ts 中的 descriptor 规则。
//
// 这对应两边专业实现的取长补短：
//   - Mastra 官方 @mastra/mcp 会把 tools/list 的 annotations 透传到
//     tool.mcp.annotations，并支持动态 requireToolApproval。
//   - Zed 的工具权限体系以稳定工具名、明确 kind、mutates/default approval
//     形成单一策略面，而不是在调用点散落多个 allow/confirm 判断。
//
// 信任模型：
//   - annotations 是 hint，不是保证；仅对本进程固定配置并启动的可信 server
//     使用其 readOnlyHint 做能力判定。
//   - 整库无副作用 server 使用 server 级信任白名单。
//   - 其余 fail-closed：未知能力按 mutatesState=true 建 descriptor，默认 confirm。

export interface IMcpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// 整库无副作用的 MCP server（server 级信任白名单）：其工具始终视为只读。
export const SIDE_EFFECT_FREE_SERVERS: ReadonlySet<TMcpServerName> = new Set<TMcpServerName>([
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
  return (annotations ?? undefined) as IMcpToolAnnotations | undefined;
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

export const createMcpGatewayToolDescriptor = (
  serverName: TMcpServerName,
  toolName: string,
  annotations: IMcpToolAnnotations | undefined,
): IAgentToolDescriptor => {
  const capability = resolveMcpToolCapability(serverName, annotations);
  return createMcpToolDescriptor(serverName, toolName, capability !== 'readonly');
};

export const resolveMcpToolApprovalDefault = (
  serverName: TMcpServerName,
  toolName: string,
  annotations: IMcpToolAnnotations | undefined,
): boolean => resolveDescriptorApprovalDefault(
  createMcpGatewayToolDescriptor(serverName, toolName, annotations),
) === 'confirm';

// 工具名无关的审批门面：MCP 审批默认只取决于 server 与 annotations，不依赖具体 toolName，
// 故以空 toolName 复用 descriptor 审批规则。
export const requiresMcpToolApproval = (
  serverName: TMcpServerName,
  annotations: IMcpToolAnnotations | undefined,
): boolean => resolveMcpToolApprovalDefault(serverName, '', annotations);
