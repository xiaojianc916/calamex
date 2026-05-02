import {
  extractSidecarChangedFilePaths,
  hasSidecarFileMutationEvent,
  mapSidecarEventsToToolCalls,
  projectSidecarEventsToActivityState,
} from '@/utils/agent-sidecar-events';
import { describe, expect, it } from 'vitest';

describe('agent-sidecar-events', () => {
  it('把嵌套 toolResult 文本清洗成可读摘要，避免把 raw JSON 暴露给聊天 UI', () => {
    const toolCalls = mapSidecarEventsToToolCalls([
      {
        type: 'tool_start',
        toolName: 'tavily_search',
        input: {
          query: '今日热点新闻',
        },
      },
      {
        type: 'tool_result',
        toolName: 'tavily_search',
        output: {
          toolResult: {
            content: [
              {
                text: 'Detailed Results:\n\nTitle: 5-year-old aspiring astronaut Jack visits NASA\nURL: https://example.com/news',
              },
            ],
          },
        },
      },
    ]);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      name: 'tavily_search',
      status: 'succeeded',
      targetPreview: '今日热点新闻',
      detailItems: [
        '平台：Tavily',
        '查询：今日热点新闻',
      ],
    });
    expect(toolCalls[0]?.summary).toContain('5-year-old aspiring astronaut Jack visits NASA');
    expect(toolCalls[0]?.summary).not.toContain('toolResult');
    expect(toolCalls[0]?.summary).not.toContain('Detailed Results');
  });

  it('能处理字符串包裹的 toolResult JSON，并且结果事件不会伪装成目标', () => {
    const toolCalls = mapSidecarEventsToToolCalls([
      {
        type: 'tool_result',
        toolName: 'list_directory',
        output: '{"toolResult":{"content":[{"text":"Detailed Results:\\n\\nTitle: src/components/business/ai\\nURL: file:///repo/src/components/business/ai"}]}}',
      },
    ]);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      name: 'list_directory',
      status: 'succeeded',
      summary: 'src/components/business/ai',
    });
    expect(toolCalls[0]?.targetPreview).toBe('项目结构');
    expect(toolCalls[0]?.summary).not.toContain('toolResult');
  });

  it('从文件搜索输入里展示搜索词和范围', () => {
    const toolCalls = mapSidecarEventsToToolCalls([
      {
        type: 'tool_start',
        toolName: 'search_files',
        input: {
          path: 'D:/repo/src',
          pattern: 'AiToolActivityInline',
        },
      },
    ]);

    expect(toolCalls[0]).toMatchObject({
      name: 'search_files',
      status: 'running',
      targetPreview: 'AiToolActivityInline · D:/repo/src',
      detailItems: [
        '搜索：AiToolActivityInline',
        '范围：D:/repo/src',
      ],
    });
  });

  it('从文件读取输入里展示具体文件', () => {
    const toolCalls = mapSidecarEventsToToolCalls([
      {
        type: 'tool_start',
        toolName: 'read_media_file',
        input: {
          path: 'D:/repo/assets/news.png',
        },
      },
    ]);

    expect(toolCalls[0]).toMatchObject({
      name: 'read_media_file',
      targetPreview: 'D:/repo/assets/news.png',
      detailItems: [
        '文件：D:/repo/assets/news.png',
      ],
    });
  });

  it('把 Streaming Events 工具生命周期投影成同一套工具活动', () => {
    const toolCalls = mapSidecarEventsToToolCalls([
      {
        type: 'agent_event',
        event: {
          id: 'runtime-tool-started',
          type: 'agent.tool.started',
          runId: 'run-1',
          sessionId: 'session-1',
          agentId: 'agent-1',
          timestamp: '2026-05-02T10:00:00.000Z',
          seq: 0,
          schemaVersion: 1,
          redacted: true,
          visibility: 'user',
          level: 'info',
          toolUseId: 'tool-use-1',
          toolName: 'tavily_search',
          inputPreview: '{"query":"淘宝网 最新商品 2026","site":"taobao.com"}',
        },
      },
      {
        type: 'agent_event',
        event: {
          id: 'runtime-tool-completed',
          type: 'agent.tool.completed',
          runId: 'run-1',
          sessionId: 'session-1',
          agentId: 'agent-1',
          timestamp: '2026-05-02T10:00:01.000Z',
          seq: 1,
          schemaVersion: 1,
          redacted: true,
          visibility: 'user',
          level: 'info',
          toolUseId: 'tool-use-1',
          toolName: 'tavily_search',
          ok: true,
          resultPreview: '{"toolResult":{"content":[{"text":"Title: Taobao launches new product page\\nURL: https://taobao.com/new"}]}}',
        },
      },
    ]);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      id: 'runtime-tool:tool-use-1',
      name: 'tavily_search',
      status: 'succeeded',
      targetPreview: '淘宝网 最新商品 2026 · taobao.com',
      detailItems: [
        '平台：Tavily',
        '查询：淘宝网 最新商品 2026',
        '站点：taobao.com',
      ],
    });
    expect(toolCalls[0]?.summary).toContain('Taobao launches new product page');
    expect(toolCalls[0]?.summary).not.toContain('toolResult');
  });

  it('新版 Streaming Events 文件写入工具也参与变更路径检测', () => {
    const events = [
      {
        type: 'agent_event' as const,
        event: {
          id: 'runtime-write-started',
          type: 'agent.tool.started' as const,
          runId: 'run-1',
          sessionId: 'session-1',
          agentId: 'agent-1',
          timestamp: '2026-05-02T10:00:00.000Z',
          seq: 0,
          schemaVersion: 1 as const,
          redacted: true as const,
          visibility: 'user' as const,
          level: 'info' as const,
          toolUseId: 'tool-write-1',
          toolName: 'write_file',
          inputPreview: '{"path":"D:/repo/src/App.vue","content":"redacted"}',
        },
      },
    ];

    expect(hasSidecarFileMutationEvent(events)).toBe(true);
    expect(extractSidecarChangedFilePaths(events)).toEqual([
      'D:/repo/src/App.vue',
    ]);
  });

  it('把 sidecar 事件统一投影成活动文案、活动轨迹和增量 event log', () => {
    const runningProjection = projectSidecarEventsToActivityState({
      assistantMessageId: 'assistant-1',
      fallbackActivityText: '检查工作区',
      streamStatus: 'streaming',
      events: [
        {
          type: 'tool_start',
          toolName: 'search_files',
          input: {
            path: 'D:/repo/src',
            pattern: 'useAiAssistant',
          },
        },
        {
          type: 'agent_event',
          event: {
            id: 'side-effect-1',
            type: 'side_effect.recorded',
            runId: 'run-1',
            sessionId: 'session-1',
            agentId: 'agent-1',
            timestamp: '2026-05-02T10:00:00.000Z',
            seq: 1,
            schemaVersion: 1,
            redacted: true,
            visibility: 'user',
            level: 'warn',
            message: '将修改 2 个文件',
          },
        },
      ],
    });

    expect(runningProjection.activityText).toBe('在 D:/repo/src 搜索「useAiAssistant」');
    expect(runningProjection.activityTrail).toEqual(['将修改 2 个文件']);
    expect(runningProjection.activityEvents.map((event) => event.type)).toContain('ACTIVITY_SNAPSHOT');

    const completedProjection = projectSidecarEventsToActivityState({
      assistantMessageId: 'assistant-1',
      fallbackActivityText: '检查工作区',
      streamStatus: 'completed',
      currentActivityEvents: runningProjection.activityEvents,
      events: [
        {
          type: 'tool_start',
          toolName: 'search_files',
          input: {
            path: 'D:/repo/src',
            pattern: 'useAiAssistant',
          },
        },
        {
          type: 'tool_result',
          toolName: 'search_files',
          output: {
            summary: '找到 3 个命中',
          },
        },
        {
          type: 'agent_event',
          event: {
            id: 'side-effect-1',
            type: 'side_effect.recorded',
            runId: 'run-1',
            sessionId: 'session-1',
            agentId: 'agent-1',
            timestamp: '2026-05-02T10:00:00.000Z',
            seq: 1,
            schemaVersion: 1,
            redacted: true,
            visibility: 'user',
            level: 'warn',
            message: '将修改 2 个文件',
          },
        },
        {
          type: 'agent_event',
          event: {
            id: 'rollback-restore-failed',
            type: 'rollback.restore.failed',
            runId: 'run-1',
            sessionId: 'session-1',
            agentId: 'agent-1',
            timestamp: '2026-05-02T10:00:02.000Z',
            seq: 2,
            schemaVersion: 1,
            redacted: true,
            visibility: 'user',
            level: 'error',
            errorMessage: '权限不足',
          },
        },
      ],
    });

    expect(completedProjection.activityTrail).toEqual([
      '将修改 2 个文件',
      '回滚恢复失败：权限不足',
    ]);
    expect(completedProjection.activityEvents.some((event) => event.type === 'ACTIVITY_DELTA')).toBe(true);
    expect(completedProjection.activities[0]).toMatchObject({
      kind: 'run',
      title: '在 D:/repo/src 搜索「useAiAssistant」',
    });
  });
});
