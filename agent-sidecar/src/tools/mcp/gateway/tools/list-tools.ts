import { createTool } from '@mastra/core/tools';
import { createJsonToolModelOutput } from '../../../../engines/budget/budget.js';
import {
  mcpGatewayListInputSchema,
  mcpGatewayListLegacyInputSchema,
  unwrapGatewayToolInput,
} from '../helpers.js';
import type { McpGatewayWarmPool } from '../warm-pool.js';
import type { IMcpGatewayMetricSink, TMcpGatewayToolProfile } from '../types.js';

export interface IMcpGatewayToolOptions {
  workspaceRootPath?: string;
  profile: TMcpGatewayToolProfile;
  metricSink?: IMcpGatewayMetricSink;
}

// mcp_list_tools —— 一次性列出所有 MCP server 的工具目录（无参数；目录走 sidecar 缓存）。
export const createMcpListTool = (
  pool: McpGatewayWarmPool,
  options: IMcpGatewayToolOptions,
): ReturnType<typeof createTool> =>
  createTool({
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
      return await pool.listAllTools(baseInput);
    },
    toModelOutput: (output) => createJsonToolModelOutput(output),
  });
