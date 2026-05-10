import { describe, expect, it } from 'vitest';

import {
  agentSidecarChatRequestSchema,
  agentSidecarCheckpointRestoreRequestSchema,
  agentSidecarExecuteRequestSchema,
  agentSidecarHealthPayloadSchema,
  agentSidecarPlanRequestSchema,
  agentSidecarResponsePayloadSchema,
} from '@/types/agent-sidecar.schema';

describe('agent sidecar event contract', () => {
  it('validates a complex full-process Agent timeline with question, tools, approval and final answer', () => {
    const userQuestion = '把 AI 面板迁移为 Tauri -> Node sidecar -> Mastra，并修复工具调用失败。';
    const response = {
      sessionId: 'agent-session-complex-1',
      events: [
        {
          type: 'agent_event',
          event: {
            id: 'runtime-event-1',
            type: 'agent.tool.started',
            runId: 'run-1',
            sessionId: 'agent-session-complex-1',
            agentId: 'mastra-agent',
            timestamp: '2026-05-01T10:00:00.000Z',
            seq: 0,
            schemaVersion: 1,
            redacted: true,
            visibility: 'user',
            level: 'info',
            toolName: 'search_project_files',
            inputPreview: '{"query":"sidecar"}',
          },
        },
        {
          type: 'message_delta',
          text: '我会先读取当前 AI IPC 合约、Tauri 命令注册和前端模式状态，再决定最小修改路径。',
        },
        {
          type: 'tool_start',
          toolName: 'list_project_files',
          input: {
            root: 'D:/com.xiaojianc/my_desktop_app',
            include: ['src/services/**', 'src-tauri/src/commands/**'],
          },
        },
        {
          type: 'tool_result',
          toolName: 'list_project_files',
          output: {
            files: [
              'src/services/tauri.contracts.ts',
              'src/services/modules/ai.ts',
              'src-tauri/src/commands/mod.rs',
            ],
          },
        },
        {
          type: 'approval_required',
          request: {
            id: 'approval-write-sidecar',
            toolName: 'write_file',
            question: '需要写入 sidecar IPC 合约和 Tauri 命令文件，是否允许本次修改？',
            summary: '新增 agent_sidecar 命令、AgentUiEvent schema 和 service façade。',
            riskLevel: 'medium',
            reversible: true,
            createdAt: '2026-05-01T10:00:00.000Z',
          },
        },
        {
          type: 'plan_ready',
          planId: 'plan-complex-1',
          threadId: 'thread-complex-1',
          version: 1,
          status: 'pending_approval',
          createdAt: '2026-05-01T10:00:00.000Z',
          updatedAt: '2026-05-01T10:00:00.000Z',
          approvedAt: null,
          executedAt: null,
          rejectionReason: null,
          errorMessage: null,
          plan: {
            goal: userQuestion,
            summary: '迁移 AI 面板调用链并保留审批边界。',
            requiresApproval: true,
            steps: [
              {
                id: 'step-1',
                title: '核对现有 AI 调用链',
                goal: '找出 chat、agent、plan 三种模式当前分别调用哪个 IPC。',
                status: 'done',
                tools: ['read_project_file', 'search_project_files'],
                riskLevel: 'low',
                requiresApproval: false,
                expectedOutput: '输出当前调用链和需要替换的边界。',
              },
              {
                id: 'step-2',
                title: '接入 Node sidecar 边界',
                goal: '新增 AgentEngine 抽象、Mastra runtime、模型配置和 Rust IPC 代理。',
                status: 'done',
                tools: ['write_file'],
                riskLevel: 'medium',
                requiresApproval: true,
                expectedOutput: '前端只能通过 Tauri service 调用 sidecar。',
              },
              {
                id: 'step-3',
                title: '验证复杂事件流',
                goal: '确保 UI 能看到提问、工具时间线、审批和 AI 最终回答。',
                status: 'done',
                tools: ['run_shell_command'],
                riskLevel: 'medium',
                requiresApproval: true,
                expectedOutput: '测试覆盖完整 AgentUiEvent 流程。',
              },
            ],
          },
        },
        {
          type: 'done',
          result: '已完成第一阶段：Agent 默认不生成计划；只有 Plan 模式会生成计划；sidecar 事件协议能表达工具读取、审批、diff 和最终回答。',
        },
      ],
      result: '已完成第一阶段：Agent 默认不生成计划；只有 Plan 模式会生成计划；sidecar 事件协议能表达工具读取、审批、diff 和最终回答。',
    };

    const parsedRequest = agentSidecarChatRequestSchema.parse({
      mode: 'agent',
      messages: [
        {
          role: 'user',
          content: userQuestion,
        },
      ],
      workspaceRootPath: 'D:/com.xiaojianc/my_desktop_app',
      context: [],
    });
    const parsedResponse = agentSidecarResponsePayloadSchema.parse(response);

    expect(parsedRequest.mode).toBe('agent');
    expect(parsedResponse.events.some((event) => event.type === 'agent_event')).toBe(true);
    expect(parsedResponse.events.some((event) => event.type === 'approval_required')).toBe(true);
    expect(parsedResponse.events.at(-1)).toMatchObject({
      type: 'done',
      result: expect.stringContaining('Agent 默认不生成计划'),
    });
  });

  it('rejects malformed tool events before they reach the UI timeline', () => {
    expect(() =>
      agentSidecarResponsePayloadSchema.parse({
        sessionId: 'agent-session-invalid',
        events: [
          {
            type: 'tool_start',
            toolName: '',
            input: undefined,
          },
        ],
        result: null,
      }),
    ).toThrow();
  });

  it('validates sidecar health payload with MCP runtime status', () => {
    const parsed = agentSidecarHealthPayloadSchema.parse({
      ok: true,
      status: 'ready',
      engine: 'mastra',
      version: '0.1.0',
      mcp: {
        configuredServers: 1,
        serverNames: ['filesystem'],
        errors: [],
      },
    });

    expect(parsed.mcp).toEqual({
      configuredServers: 1,
      serverNames: ['filesystem'],
      errors: [],
    });
  });

  it('normalizes optional sidecar request fields before IPC', () => {
    const parsed = agentSidecarChatRequestSchema.parse({
      sessionId: null,
      mode: ' ',
      goal: ' ',
      messages: [],
      workspaceRootPath: null,
      context: [],
    });

    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.mode).toBeUndefined();
    expect(parsed.goal).toBeUndefined();
    expect(parsed.workspaceRootPath).toBeNull();
  });

  it('accepts omitted optional sidecar request fields before IPC', () => {
    const parsed = agentSidecarChatRequestSchema.parse({
      goal: 'run',
      messages: [],
      context: [],
    });

    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.workspaceRootPath).toBeUndefined();
    expect(parsed.goal).toBe('run');
  });

  it('requires approved plan gate fields for sidecar execute requests', () => {
    expect(() =>
      agentSidecarExecuteRequestSchema.parse({
        goal: 'run',
        messages: [],
        context: [],
      }),
    ).toThrow();
  });

  it('keeps plan and execute goals non-empty after trimming', () => {
    expect(() =>
      agentSidecarPlanRequestSchema.parse({
        goal: '',
        messages: [],
        context: [],
      }),
    ).toThrow();
    expect(
      agentSidecarExecuteRequestSchema.parse({
        goal: ' run ',
        messages: [],
        context: [],
        planId: 'plan-1',
        planVersion: 1,
        planStepId: 'step-1',
      }).goal,
    ).toBe('run');
  });

  it('accepts rollback restore requests with nested durable step paths', () => {
    const parsed = agentSidecarCheckpointRestoreRequestSchema.parse({
      runId: 'run-1',
      snapshotId: 'snapshot-1',
      step: ['durable-agentic-execution', 'durable-llm-execution'],
    });

    expect(parsed).toEqual({
      runId: 'run-1',
      snapshotId: 'snapshot-1',
      step: ['durable-agentic-execution', 'durable-llm-execution'],
    });
  });
});
