import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AiToolActivityInline from '@/components/business/ai/AiToolActivityInline.vue';

import type { IAgentActivity, TAgentActivityEvent } from '@/types/agent-activity';
import type { IAiToolCall } from '@/types/ai';

const mountActivity = (
  toolCalls: IAiToolCall[],
  activityText?: string,
  activityTrail?: string[],
  activities?: IAgentActivity[],
  activityEvents?: TAgentActivityEvent[],
) =>
  mount(AiToolActivityInline, {
    props: {
      toolCalls,
      ...(activityText ? { activityText } : {}),
      ...(activityTrail ? { activityTrail } : {}),
      ...(activities ? { activities } : {}),
      ...(activityEvents ? { activityEvents } : {}),
    },
  });

describe('AiToolActivityInline', () => {
  it('把运行态工具调用渲染成对话流里的紧凑时间线行', () => {
    const wrapper = mountActivity([
      {
        id: 'tool-call-read',
        name: 'read_file',
        status: 'running',
        summary: '正在读取 test.sh…',
      },
    ]);

    expect(wrapper.get('.ai-tool-activity-inline').attributes('aria-label')).toBe('工具调用树');
    expect(wrapper.text()).toContain('查看文件');
    expect(wrapper.text()).toContain('test.sh');
    expect(wrapper.text()).not.toContain('正在读取 test.sh…');
    expect(wrapper.text()).toContain('文件：test.sh');
    expect(wrapper.text()).toContain('状态：正在执行');
    expect(wrapper.find('.ai-tool-running-dots').exists()).toBe(false);
  });

  it('优先显示 targetPreview，并把文件行号拆成独立范围标签', () => {
    const wrapper = mountActivity([
      {
        id: 'tool-call-search',
        name: 'search_text',
        status: 'succeeded',
        summary: '已搜索项目内容',
        targetPreview: 'src/components/business/ai/AiAssistantPanel.vue:120-156',
      },
    ]);

    expect(wrapper.text()).toContain('全文搜索');
    expect(wrapper.text()).toContain('src/components/business/ai/AiAssistantPanel.vue');
    expect(wrapper.text()).toContain('L120-156');
  });

  it('工具失败时保留目标并通过状态类暴露失败状态', () => {
    const wrapper = mountActivity([
      {
        id: 'tool-call-test',
        name: 'run_test',
        status: 'failed',
        summary: 'pnpm exec vitest run AiToolActivityInline.spec.ts',
      },
    ]);

    expect(wrapper.get('.ai-tool-run-item').classes()).toContain('is-failed');
    expect(wrapper.text()).toContain('验证');
    expect(wrapper.text()).toContain('pnpm exec vitest run AiToolActivityInline.spec.ts');
  });

  it('联网搜索默认隐藏 SDK 工具名，只显示查询和站点等真实上下文', () => {
    const wrapper = mountActivity([
      {
        id: 'tool-call-search',
        name: 'tavily_search',
        status: 'running',
        summary: '今日热点新闻 · example.com',
        targetPreview: '今日热点新闻 · example.com',
        detailItems: [
          '平台：Tavily',
          '查询：今日热点新闻',
          '站点：example.com',
        ],
      },
    ], '联网搜索「今日热点新闻」，站点 example.com');

    expect(wrapper.text()).toContain('联网搜索「今日热点新闻」，站点 example.com');
    expect(wrapper.text()).toContain('联网搜索');
    expect(wrapper.text()).toContain('今日热点新闻');
    expect(wrapper.text()).toContain('站点：example.com');
    expect(wrapper.text()).toContain('平台：Tavily');
    expect(wrapper.text()).not.toContain('tavily_search');
    expect(wrapper.text()).not.toContain('1 个工具');
    expect(wrapper.text()).not.toContain('已完成 1/1');
  });

  it('没有 targetPreview 时不会把工具结果 JSON 当成标题', () => {
    const wrapper = mountActivity([
      {
        id: 'tool-call-list',
        name: 'list_directory',
        status: 'succeeded',
        summary: '{"toolResult":{"content":[{"text":"Title: src/components/business/ai"}]}}',
        targetPreview: '目录读取完成: {"toolResult":{"content":[{"text":"Title: src/components/business/ai"}]}}',
      },
    ]);

    expect(wrapper.get('.ai-tool-run-target').text()).toBe('项目结构');
    expect(wrapper.get('.ai-tool-run-target').text()).not.toContain('toolResult');
    expect(wrapper.text()).not.toContain('{"toolResult"');
  });

  it('活动文本和工具条目共享同一条向下延伸的时间线', () => {
    const wrapper = mountActivity([
      {
        id: 'tool-call-list',
        name: 'list_directory',
        status: 'succeeded',
        summary: 'D:/repo/src',
        targetPreview: 'D:/repo/src',
        detailItems: [
          '目录：D:/repo/src',
        ],
      },
      {
        id: 'tool-call-search',
        name: 'search_files',
        status: 'running',
        summary: 'AiToolActivityInline · D:/repo/src',
        targetPreview: 'AiToolActivityInline · D:/repo/src',
        detailItems: [
          '搜索：AiToolActivityInline',
          '范围：D:/repo/src',
        ],
      },
    ], '在 D:/repo/src 搜索「AiToolActivityInline」', [
      '工具活动 UI',
      '在 D:/repo/src 搜索「AiToolActivityInline」',
    ]);

    const rows = wrapper.findAll('.ai-tool-run-item');

    expect(rows).toHaveLength(3);
    expect(rows[0]?.classes()).toContain('ai-tool-run-current');
    expect(rows[0]?.text()).toContain('在 D:/repo/src 搜索「AiToolActivityInline」');
    expect(wrapper.text()).toContain('工具活动 UI');
    expect(wrapper.text()).toContain('在 D:/repo/src 搜索「AiToolActivityInline」');
    expect(rows[1]?.text()).toContain('目录：D:/repo/src');
    expect(rows[2]?.text()).toContain('搜索：AiToolActivityInline');
    expect(wrapper.find('.ai-tool-run-overview').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('2 个工具');
    expect(wrapper.text()).not.toContain('已完成 1/2');
  });

  it('根节点默认展开，工具二级节点默认关闭', () => {
    const wrapper = mountActivity([
      {
        id: 'tool-call-search',
        name: 'tavily_search',
        status: 'succeeded',
        summary: '伊朗 核设施',
        targetPreview: '伊朗 核设施',
        detailItems: [
          '平台：Tavily',
          '查询：伊朗 核设施',
        ],
      },
    ], '联网搜索「伊朗 核设施」');

    expect(wrapper.get('.ai-tool-root-details').attributes()).toHaveProperty('open');
    expect(wrapper.get('.ai-tool-tool-list .ai-tool-node-details').attributes()).not.toHaveProperty('open');
  });

  it('优先渲染 AG-UI 风格 Activity 树，并在展开节点里显示真实字段', () => {
    const wrapper = mountActivity([], undefined, undefined, [
      {
        id: 'run-root',
        runId: 'run-1',
        kind: 'run',
        status: 'running',
        title: '联网搜索「伊朗 核设施」',
      },
      {
        id: 'summary-1',
        runId: 'run-1',
        parentId: 'run-root',
        kind: 'reasoning_summary',
        status: 'running',
        title: '正在核对最近公开信息',
      },
      {
        id: 'tool-1',
        runId: 'run-1',
        parentId: 'run-root',
        kind: 'search',
        status: 'success',
        title: '联网搜索',
        description: '伊朗 核设施 战争 2026年最新',
        details: [
          {
            label: '平台',
            value: 'Tavily',
            priority: 82,
          },
          {
            label: '查询',
            value: '伊朗 核设施 战争 2026年最新',
            priority: 100,
          },
          {
            label: '站点',
            value: 'understandingwar.org',
            priority: 88,
          },
        ],
      },
    ]);

    expect(wrapper.get('.ai-tool-root-details').attributes()).toHaveProperty('open');
    expect(wrapper.get('.ai-tool-tool-list .ai-tool-node-details').attributes()).not.toHaveProperty('open');
    expect(wrapper.text()).toContain('联网搜索「伊朗 核设施」');
    expect(wrapper.text()).toContain('正在核对最近公开信息');
    expect(wrapper.text()).toContain('联网搜索');
    expect(wrapper.text()).toContain('伊朗 核设施 战争 2026年最新');
    expect(wrapper.text()).toContain('平台：Tavily');
    expect(wrapper.text()).toContain('查询：伊朗 核设施 战争 2026年最新');
    expect(wrapper.text()).toContain('站点：understandingwar.org');
  });

  it('没有预构建 activities 时也能从 activityEvents 还原活动树', () => {
    const wrapper = mountActivity([], undefined, undefined, undefined, [
      {
        type: 'ACTIVITY_SNAPSHOT',
        timestamp: 1_746_217_200_000,
        messageId: 'run-root',
        activityType: 'RUN',
        replace: true,
        content: {
          id: 'run-root',
          runId: 'run-1',
          kind: 'run',
          status: 'running',
          title: '验证内部 AG-UI event log',
        },
      },
      {
        type: 'ACTIVITY_SNAPSHOT',
        timestamp: 1_746_217_200_001,
        messageId: 'summary-1',
        activityType: 'REASONING_SUMMARY',
        replace: true,
        content: {
          id: 'summary-1',
          runId: 'run-1',
          parentId: 'run-root',
          kind: 'reasoning_summary',
          status: 'running',
          title: '正在从 event log 还原活动树',
        },
      },
      {
        type: 'ACTIVITY_SNAPSHOT',
        timestamp: 1_746_217_200_002,
        messageId: 'tool-1',
        activityType: 'SEARCH',
        replace: true,
        content: {
          id: 'tool-1',
          runId: 'run-1',
          parentId: 'run-root',
          kind: 'search',
          status: 'running',
          title: '文件搜索',
          description: 'AgentActivityFeed · src/components',
          details: [
            {
              label: '搜索',
              value: 'AgentActivityFeed',
              priority: 96,
            },
          ],
        },
      },
    ]);

    expect(wrapper.text()).toContain('验证内部 AG-UI event log');
    expect(wrapper.text()).toContain('正在从 event log 还原活动树');
    expect(wrapper.text()).toContain('文件搜索');
    expect(wrapper.text()).toContain('AgentActivityFeed · src/components');
  });
});
