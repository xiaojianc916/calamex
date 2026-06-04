import { toRecord } from '../../engines/utils.js';
import type { TMcpServerName } from '../mcp.js';

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
