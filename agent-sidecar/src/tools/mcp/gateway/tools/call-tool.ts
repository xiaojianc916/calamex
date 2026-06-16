import { createTool } from '@mastra/core/tools';
import type { z } from 'zod';
import { compactModelOutput } from '../../../../models/output-budget.js';
import { createJsonToolModelOutput } from '../../../../engines/budget/budget.js';
import { mcpGatewayCallInputSchema, unwrapGatewayToolInput } from '../helpers.js';
import type { McpGatewayWarmPool } from '../warm-pool.js';
import type { IMcpGatewayToolOptions } from './list-tools.js';

const MCP_GATEWAY_MODEL_OUTPUT_MAX_CHARS = 4_000;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_STRING_CHARS = 1_500;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_ARRAY_ITEMS = 20;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_OBJECT_KEYS = 40;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_DEPTH = 6;

// mcp_call_tool —— 按 serverName + toolName 直接调用 MCP 工具；审批/执行委托给 warm pool。
export const createMcpCallTool = (
  pool: McpGatewayWarmPool,
  options: IMcpGatewayToolOptions,
): ReturnType<typeof createTool> =>
  createTool({
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
      return await pool.requiresToolApproval({
        serverName: parsed.serverName,
        toolName: parsed.toolName,
        profile: options.profile,
        ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
        ...(options.metricSink ? { metricSink: options.metricSink } : {}),
      });
    },
    execute: async (inputData) => {
      const parsed = mcpGatewayCallInputSchema.parse(unwrapGatewayToolInput(inputData));
      return await pool.callTool({
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
  });
