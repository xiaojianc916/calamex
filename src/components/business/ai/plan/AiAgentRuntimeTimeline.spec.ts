import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AiAgentRuntimeTimeline from '@/components/business/ai/plan/AiAgentRuntimeTimeline.vue';

import type { TAgentRuntimeEvent } from '@/types/ai/sidecar';

const createEvent = (overrides: Partial<TAgentRuntimeEvent>): TAgentRuntimeEvent =>
  ({
    id: overrides.id ?? 'event-1',
    type: overrides.type ?? 'agent.tool.started',
    runId: overrides.runId ?? 'run-1',
    sessionId: overrides.sessionId ?? 'session-1',
    agentId: overrides.agentId ?? 'agent-1',
    timestamp: overrides.timestamp ?? '2026-05-03T10:00:00.000Z',
    seq: overrides.seq ?? 1,
    schemaVersion: 1,
    redacted: true,
    visibility: overrides.visibility ?? 'user',
    level: overrides.level ?? 'info',
    toolName: 'search_project_files',
    inputPreview: '{"pattern":"useAiAssistant","path":"src"}',
    ...(overrides as object),
  }) as TAgentRuntimeEvent;

describe('AiAgentRuntimeTimeline', () => {
  it('把 reasoning 原文与工具事件按顺序穿插渲染', () => {
    const events: TAgentRuntimeEvent[] = [
      createEvent({
        id: 'reasoning-1',
        type: 'agent.reasoning.delta',
        text: '我先确认 sidecar 是否是旧进程。',
      }),
      createEvent({
        id: 'tool-start-1',
        type: 'agent.tool.started',
        toolUseId: 'tool-use-1',
        toolName: 'grep_search',
        inputPreview: '{"query":"agent-sidecar|39871"}',
      }),
      createEvent({
        id: 'tool-completed-1',
        type: 'agent.tool.completed',
        toolUseId: 'tool-use-1',
        toolName: 'grep_search',
        ok: true,
        resultPreview: '{"matches":200}',
      }),
    ];

    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events,
      },
    });

    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(true);
    expect(wrapper.findAll('.agent-line')).toHaveLength(1);
    expect(wrapper.text()).toContain('我先确认 sidecar 是否是旧进程。');
    expect(wrapper.findAll('.ai-runtime-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('搜索完成');
    expect(wrapper.text()).not.toContain('完成调用 grep_search');
    expect(wrapper.text()).not.toContain('开始调用 grep_search');
  });

  it('工具 started 事件到达后立即出现节点', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'tool-start-immediate',
            type: 'agent.tool.started',
            toolName: 'read_file',
            inputPreview: '{"path":"src/main.ts"}',
          }),
        ],
      },
    });

    expect(wrapper.find('.ai-runtime-step.is-task').exists()).toBe(true);
    expect(wrapper.text()).toContain('正在查看 main.ts');
  });

  it('命令执行节点展开后显示真实终端输入与输出', async () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'command-start',
            type: 'agent.tool.started',
            toolUseId: 'command-1',
            toolName: 'mastra_workspace_execute_command',
            inputPreview: '{"command":"pnpm test","cwd":"D:/repo"}',
          }),
          createEvent({
            id: 'command-stdout',
            type: 'agent.tool.progress',
            toolUseId: 'command-1',
            toolName: 'mastra_workspace_execute_command',
            dataPreview: '{"stream":"stdout","output":"PASS src/app.spec.ts\\n"}',
          }),
          createEvent({
            id: 'command-exit',
            type: 'agent.tool.progress',
            toolUseId: 'command-1',
            toolName: 'mastra_workspace_execute_command',
            dataPreview: '{"stream":"exit","exitCode":0,"success":true,"executionTimeMs":128}',
          }),
          createEvent({
            id: 'command-completed',
            type: 'agent.tool.completed',
            toolUseId: 'command-1',
            toolName: 'mastra_workspace_execute_command',
            ok: true,
            resultPreview:
              '{"command":"pnpm test","stdout":"PASS src/app.spec.ts\\n","stderr":"","exitCode":0}',
          }),
        ],
      },
    });

    await wrapper.get('.ai-runtime-terminal-toggle').trigger('click');

    expect(wrapper.find('.ai-runtime-terminal').exists()).toBe(true);
    expect(wrapper.text()).toContain('> pnpm test');
    expect(wrapper.text()).toContain('PASS src/app.spec.ts');
    expect(wrapper.text()).toContain('exit 0');
    expect(wrapper.text()).not.toContain('[工具参数已收敛显示]');
  });

  it('命令完成节点不把结果 JSON 当作标题', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'command-start-json-title',
            type: 'agent.tool.started',
            toolUseId: 'command-json-title-1',
            toolName: 'mastra_workspace_execute_command',
            inputPreview: '{"command":"dir"}',
          }),
          createEvent({
            id: 'command-completed-json-title',
            type: 'agent.tool.completed',
            toolUseId: 'command-json-title-1',
            toolName: 'mastra_workspace_execute_command',
            ok: true,
            resultPreview: '{"command":"dir","stdout":"目录内容","exitCode":0}',
          }),
        ],
      },
    });

    expect(wrapper.text()).toContain('执行完成 dir');
    expect(wrapper.text()).not.toContain('执行完成 {"command":"dir"');
    expect(wrapper.text()).not.toContain('运行 目录内容');
  });

  it('mcp_list_tools 状态在同一节点内从查找更新为成功', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'mcp-list-start',
            type: 'agent.tool.started',
            toolUseId: 'mcp-list-1',
            toolName: 'mcp_list_tools',
            inputPreview: '{}',
          }),
          createEvent({
            id: 'mcp-list-complete',
            type: 'agent.tool.completed',
            toolUseId: 'mcp-list-1',
            toolName: 'mcp_list_tools',
            ok: true,
            resultPreview: '{"serverCount":10,"toolCount":42}',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('成功获取MCP工具集');
    expect(wrapper.text()).not.toContain('正在查找MCP工具集');
    expect(wrapper.find('.ai-runtime-step-icon.is-icon-catalog').exists()).toBe(true);
  });

  it('多个 mcp_list_tools 调用在时间线中合并为一个状态节点', () => {
    const events = Array.from({ length: 10 }, (_, index) =>
      createEvent({
        id: `mcp-list-complete-${index}`,
        type: 'agent.tool.completed',
        toolUseId: `mcp-list-${index}`,
        toolName: 'mcp_list_tools',
        ok: true,
        resultPreview: `{"serverName":"server-${index}","toolCount":1}`,
        seq: index + 1,
      }),
    );
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: { events },
    });

    expect(wrapper.findAll('.ai-runtime-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('成功获取MCP工具集');
  });

  it('read_text_file 在完成后原地替换为已查看文案', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'read-start',
            type: 'agent.tool.started',
            toolUseId: 'read-1',
            toolName: 'read_text_file',
            inputPreview: '{"path":"D:\\\\test\\\\test.sh"}',
          }),
          createEvent({
            id: 'read-complete',
            type: 'agent.tool.completed',
            toolUseId: 'read-1',
            toolName: 'read_text_file',
            ok: true,
            resultPreview: '{"content":"echo 1"}',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('已查看 test.sh');
    expect(wrapper.text()).not.toContain('正在查看 test.sh');
    expect(wrapper.find('.ai-runtime-task-content').exists()).toBe(false);
  });

  it('shellcheck 通过时显示通过结果和校验图标', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'shellcheck-pass',
            type: 'agent.tool.completed',
            toolName: 'shellcheck',
            ok: true,
            resultPreview: 'D:/test/test.sh：ShellCheck 通过（bash）',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('语法校验已通过');
    expect(wrapper.text()).not.toContain('完成调用 shellcheck');
    expect(wrapper.find('.ai-runtime-step-icon.is-icon-check').exists()).toBe(true);
  });

  it('shellcheck 有问题时显示问题编号和告警图标', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'shellcheck-warning',
            type: 'agent.tool.completed',
            toolName: 'shellcheck',
            ok: true,
            resultPreview:
              'D:/test/test.sh：ShellCheck 1 警告、1 提示；问题编号 SC2086、SC1091；首个问题 L1:1 Double quote to prevent globbing',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('语法存在一些问题：SC2086、SC1091');
    expect(wrapper.text()).not.toContain('完成调用 shellcheck');
    expect(wrapper.find('.ai-runtime-step-icon.is-icon-alert').exists()).toBe(true);
  });

  it('write_file 在完成后原地替换为编辑完成文案', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'write-start',
            type: 'agent.tool.started',
            toolUseId: 'write-1',
            toolName: 'write_file',
            inputPreview: '{"path":"D:\\\\test\\\\test.sh","content":"echo 1"}',
          }),
          createEvent({
            id: 'write-complete',
            type: 'agent.tool.completed',
            toolUseId: 'write-1',
            toolName: 'write_file',
            ok: true,
            resultPreview: '{"written":true}',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('编辑完成 test.sh');
    expect(wrapper.text()).not.toContain('正在编辑 test.sh');
    expect(wrapper.find('.ai-runtime-task-content').exists()).toBe(false);
  });

  it('write_file 预览为嵌套对象时也能提取路径并显示编辑完成文案', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'write-nested-start',
            type: 'agent.tool.started',
            toolUseId: 'write-nested-1',
            toolName: 'write_file',
            inputPreview: '{"args":{"path":"D:\\\\test\\\\nested.sh","content":"echo 1"}}',
          }),
          createEvent({
            id: 'write-nested-complete',
            type: 'agent.tool.completed',
            toolUseId: 'write-nested-1',
            toolName: 'write_file',
            ok: true,
            resultPreview: '{"result":{"ok":true}}',
          }),
        ],
      },
    });

    expect(wrapper.text()).toContain('编辑完成 nested.sh');
    expect(wrapper.text()).not.toContain('完成调用 write_file');
  });

  it('web_search 完成后原地改成联网搜索完成，并保留真实来源胶囊', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'web-search-start',
            type: 'agent.tool.started',
            toolUseId: 'web-search-1',
            toolName: 'web_search',
            inputPreview:
              '{"query":"profiles for Emmanuel Raymond","intent":"general","maxResults":3}',
          }),
          createEvent({
            id: 'web-search-complete',
            type: 'agent.tool.completed',
            toolUseId: 'web-search-1',
            toolName: 'web_search',
            ok: true,
            resultPreview:
              '[{"title":"X profile","url":"https://x.com/emmanuelraymond","snippet":"...","sourceType":"unknown","fetchedAt":"2026-05-03T10:00:02.000Z"},{"title":"Instagram profile","url":"https://www.instagram.com/emmanuelraymond/","snippet":"...","sourceType":"unknown","fetchedAt":"2026-05-03T10:00:03.000Z"},{"title":"GitHub profile","url":"https://github.com/emmanuelraymond","snippet":"...","sourceType":"github","fetchedAt":"2026-05-03T10:00:04.000Z"}]',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('联网搜索完成');
    expect(wrapper.text()).not.toContain('正在联网搜索 profiles for Emmanuel Raymond');

    const pills = wrapper.findAll('.ai-runtime-web-source-pill');
    expect(pills).toHaveLength(3);
    expect(wrapper.text()).toContain('x.com');
    expect(wrapper.text()).toContain('instagram.com');
    expect(wrapper.text()).toContain('github.com');
    expect(wrapper.text()).not.toContain('https://x.com/emmanuelraymond');
    expect(wrapper.findAll('.ai-runtime-web-source-icon')[0]?.attributes('src')).toBe(
      'http://favicon.localhost/x.com',
    );
    expect(wrapper.findAll('.ai-runtime-web-source-icon')[1]?.attributes('src')).toBe(
      'http://favicon.localhost/instagram.com',
    );
  });

  it('web_search 开始时显示正在联网搜索查询文案', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'web-search-only-start',
            type: 'agent.tool.started',
            toolUseId: 'web-search-2',
            toolName: 'web_search',
            inputPreview: '{"query":"recent work","intent":"general","maxResults":2}',
          }),
        ],
      },
    });

    expect(wrapper.text()).toContain('正在联网搜索 recent work');
    expect(wrapper.text()).not.toContain('联网搜索完成');
  });

  it('web_search 开始时如果带站点范围会立即显示来源胶囊', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'web-search-site-start',
            type: 'agent.tool.started',
            toolUseId: 'web-search-site-1',
            toolName: 'web_search',
            inputPreview: '{"query":"trending open source","site":"github.com"}',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('正在联网搜索 trending open source');
    expect(wrapper.text()).toContain('github.com');
    expect(wrapper.text()).not.toContain('联网搜索完成');
  });

  it('web_search progress 出现 URL 时会在同一个节点实时补充来源胶囊', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'web-search-progress-start',
            type: 'agent.tool.started',
            toolUseId: 'web-search-progress-1',
            toolName: 'web_search',
            inputPreview: '{"query":"github trending"}',
          }),
          createEvent({
            id: 'web-search-progress-source',
            type: 'agent.tool.progress',
            dataPreview: '{"result":{"url":"https://github.com/trending"}}',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('正在联网搜索 github trending');
    expect(wrapper.text()).toContain('github.com');
    expect(wrapper.text()).not.toContain('工具执行中');
  });

  it('tavily-search 完成后也会原地替换为联网搜索完成', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'tavily-start',
            type: 'agent.tool.started',
            toolUseId: 'tavily-1',
            toolName: 'tavily-search',
            inputPreview: '{"query":"today sports news"}',
          }),
          createEvent({
            id: 'tavily-complete',
            type: 'agent.tool.completed',
            toolUseId: 'tavily-1',
            toolName: 'tavily-search',
            ok: true,
            resultPreview: '{"results":[{"url":"https://www.espn.com/","sourceType":"unknown"}]}',
          }),
        ],
      },
    });

    expect(wrapper.text()).toContain('联网搜索完成');
    expect(wrapper.text()).not.toContain('正在联网搜索 today sports news');
  });

  it('web_search 完成结果为嵌套文本时也能提取完整 URL 来源胶囊', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'nested-web-start',
            type: 'agent.tool.started',
            toolUseId: 'nested-web-1',
            toolName: 'tavily-search',
            inputPreview: '{"query":"tauri release notes"}',
          }),
          createEvent({
            id: 'nested-web-complete',
            type: 'agent.tool.completed',
            toolUseId: 'nested-web-1',
            toolName: 'tavily-search',
            ok: true,
            resultPreview:
              '{"toolResult":{"content":[{"type":"text","text":"Title: Tauri releases\\nURL: https://tauri.app/release-notes/?utm_source=test"}]}}',
          }),
        ],
      },
    });

    const pills = wrapper.findAll('.ai-runtime-web-source-pill');
    expect(pills).toHaveLength(1);
    expect(wrapper.text()).toContain('tauri.app');
    expect(wrapper.text()).not.toContain('https://tauri.app/release-notes/?utm_source=test');
  });

  it('web_search 来源胶囊按站点去重', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'same-site-web-start',
            type: 'agent.tool.started',
            toolUseId: 'same-site-web-1',
            toolName: 'web_search',
            inputPreview: '{"query":"github release"}',
          }),
          createEvent({
            id: 'same-site-web-complete',
            type: 'agent.tool.completed',
            toolUseId: 'same-site-web-1',
            toolName: 'web_search',
            ok: true,
            resultPreview:
              '[{"url":"https://www.github.com/openai/codex"},{"url":"https://github.com/openai/codex/releases"}]',
          }),
        ],
      },
    });

    const pills = wrapper.findAll('.ai-runtime-web-source-pill');
    expect(pills).toHaveLength(1);
    expect(pills[0]?.text()).toBe('github.com');
  });

  it('相邻多次 web_search 会合并为同一个搜索节点', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'web-search-a-start',
            type: 'agent.tool.started',
            toolUseId: 'web-search-a',
            toolName: 'tavily-search',
            inputPreview: '{"query":"mastra agent"}',
          }),
          createEvent({
            id: 'web-search-a-complete',
            type: 'agent.tool.completed',
            toolUseId: 'web-search-a',
            toolName: 'tavily-search',
            ok: true,
            resultPreview: '{"results":[{"url":"https://decisioncrafters.com/mastra"}]}',
          }),
          createEvent({
            id: 'web-search-b-start',
            type: 'agent.tool.started',
            toolUseId: 'web-search-b',
            toolName: 'tavily-search',
            inputPreview: '{"query":"mastra ecosystem"}',
          }),
          createEvent({
            id: 'web-search-b-complete',
            type: 'agent.tool.completed',
            toolUseId: 'web-search-b',
            toolName: 'tavily-search',
            ok: true,
            resultPreview: '{"results":[{"url":"https://xavidop.me/mastra"}]}',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.findAll('.ai-runtime-web-source-pill')).toHaveLength(2);
    expect(wrapper.text()).toContain('decisioncrafters.com');
    expect(wrapper.text()).toContain('xavidop.me');
  });

  it('get_current_time 完成后原地改成当前时间读取完成', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'time-start',
            type: 'agent.tool.started',
            toolUseId: 'time-1',
            toolName: 'get_current_time',
            inputPreview: '{}',
          }),
          createEvent({
            id: 'time-complete',
            type: 'agent.tool.completed',
            toolUseId: 'time-1',
            toolName: 'get_current_time',
            ok: true,
            resultPreview: '{"timezone":"Asia/Shanghai","currentTime":"2026-05-09T22:00:00+08:00"}',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('当前时间读取完成');
    expect(wrapper.text()).not.toContain('正在读取当前时间');
    expect(wrapper.find('.ai-runtime-task-content').exists()).toBe(false);
  });

  it('get_current_time 开始时显示正在读取当前时间', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'time-only-start',
            type: 'agent.tool.started',
            toolUseId: 'time-2',
            toolName: 'get_current_time',
            inputPreview: '{}',
          }),
        ],
      },
    });

    expect(wrapper.text()).toContain('正在读取当前时间');
    expect(wrapper.text()).not.toContain('当前时间读取完成');
  });

  it('read_current_file 完成后原地替换为当前文件读取完成', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'current-file-start',
            type: 'agent.tool.started',
            toolUseId: 'current-file-1',
            toolName: 'read_current_file',
            inputPreview: '{}',
          }),
          createEvent({
            id: 'current-file-complete',
            type: 'agent.tool.completed',
            toolUseId: 'current-file-1',
            toolName: 'read_current_file',
            ok: true,
            resultPreview: '{"path":"D:\\\\test\\\\xiaojianc.sh"}',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('当前文件读取完成');
    expect(wrapper.text()).not.toContain('正在读取当前文件');
    expect(wrapper.text()).not.toContain('完成调用 read_current_file');
  });

  it('list_dir 完成后原地替换为工作区目录读取完成', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'list-dir-start',
            type: 'agent.tool.started',
            toolUseId: 'list-dir-1',
            toolName: 'list_dir',
            inputPreview: '{"path":"D:\\\\test"}',
          }),
          createEvent({
            id: 'list-dir-complete',
            type: 'agent.tool.completed',
            toolUseId: 'list-dir-1',
            toolName: 'list_dir',
            ok: true,
            resultPreview: '{"entries":["test.sh"]}',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('工作区目录读取完成');
    expect(wrapper.text()).not.toContain('正在读取工作区目录');
  });

  it('grep_in_files 根据结果原地显示读取到或未读取到搜索词', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'grep-start',
            type: 'agent.tool.started',
            toolUseId: 'grep-1',
            toolName: 'grep_in_files',
            inputPreview: '{"pattern":"test.sh"}',
          }),
          createEvent({
            id: 'grep-complete',
            type: 'agent.tool.completed',
            toolUseId: 'grep-1',
            toolName: 'grep_in_files',
            ok: true,
            resultPreview: '{"matches":[{"path":"test.sh","line":30}]}',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('成功读取到 test.sh');
    expect(wrapper.text()).not.toContain('正在搜索 test.sh');
  });

  it('grep_in_files 无结果时原地显示未读取到搜索词', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'grep-empty-start',
            type: 'agent.tool.started',
            toolUseId: 'grep-empty-1',
            toolName: 'grep_in_files',
            inputPreview: '{"query":"missing"}',
          }),
          createEvent({
            id: 'grep-empty-complete',
            type: 'agent.tool.completed',
            toolUseId: 'grep-empty-1',
            toolName: 'grep_in_files',
            ok: true,
            resultPreview: '{"matches":[]}',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('未读取到 missing');
  });

  it('apply_file_edits 完成后显示编辑完成和文件名', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'apply-edits-start',
            type: 'agent.tool.started',
            toolUseId: 'apply-edits-1',
            toolName: 'apply_file_edits',
            inputPreview: '{"path":"D:\\\\test\\\\test.sh"}',
          }),
          createEvent({
            id: 'apply-edits-complete',
            type: 'agent.tool.completed',
            toolUseId: 'apply-edits-1',
            toolName: 'apply_file_edits',
            ok: true,
            resultPreview: '{"ok":true}',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('编辑完成 test.sh');
    expect(wrapper.text()).not.toContain('正在编辑 test.sh');
  });

  it('search_symbols 根据结构化搜索结果原地显示搜索状态', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'symbol-start',
            type: 'agent.tool.started',
            toolUseId: 'symbol-1',
            toolName: 'search_symbols',
            inputPreview: '{"query":"main"}',
          }),
          createEvent({
            id: 'symbol-complete',
            type: 'agent.tool.completed',
            toolUseId: 'symbol-1',
            toolName: 'search_symbols',
            ok: true,
            resultPreview: '{"symbols":[{"name":"main"}]}',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
    expect(wrapper.text()).toContain('成功搜索到 main');
    expect(wrapper.text()).not.toContain('正在结构化搜索 main');
  });

  it('按具体工具名选择更贴合的图标，而不是只用通用分类图标', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'multi-read',
            type: 'agent.tool.started',
            toolName: 'read_multiple_files',
          }),
          createEvent({
            id: 'directory-tree',
            type: 'agent.tool.started',
            toolName: 'directory_tree',
          }),
          createEvent({
            id: 'docs',
            type: 'agent.tool.started',
            toolName: 'query-docs',
          }),
          createEvent({
            id: 'browser-evaluate',
            type: 'agent.tool.started',
            toolName: 'browser_evaluate',
          }),
        ],
      },
    });

    const icons = wrapper.findAll('.ai-runtime-step-icon');

    expect(icons.some((icon) => icon.classes().includes('is-icon-files'))).toBe(true);
    expect(icons.some((icon) => icon.classes().includes('is-icon-folder'))).toBe(true);
    expect(icons.some((icon) => icon.classes().includes('is-icon-book'))).toBe(true);
    expect(icons.some((icon) => icon.classes().includes('is-icon-play'))).toBe(true);
  });

  it('会合并连续 reasoning delta，避免一词一行', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'reasoning-word-1',
            type: 'agent.reasoning.delta',
            text: 'Given ',
          }),
          createEvent({
            id: 'reasoning-word-2',
            type: 'agent.reasoning.delta',
            text: 'the ',
          }),
          createEvent({
            id: 'reasoning-word-3',
            type: 'agent.reasoning.delta',
            text: 'file ',
          }),
          createEvent({
            id: 'reasoning-word-4',
            type: 'agent.reasoning.delta',
            text: 'extension ',
          }),
          createEvent({
            id: 'reasoning-word-5',
            type: 'agent.reasoning.delta',
            text: 'is .sh',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.agent-line')).toHaveLength(1);
    expect(wrapper.text()).toContain('Given the file extension is .sh');
  });

  it('不会把最终正文 delta 当成活动树思考文字渲染', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'tool-completed-before-text',
            type: 'agent.tool.completed',
            toolName: 'web_search',
            ok: true,
          }),
          createEvent({
            id: 'visible-text-after-tool',
            type: 'agent.text.delta',
            text: '根据搜索结果，先整理上周的关键金融新闻。',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.agent-line')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('根据搜索结果，先整理上周的关键金融新闻。');
  });

  it('兼容累计快照式 reasoning，避免前缀重复堆叠', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'reasoning-cumulative-1',
            type: 'agent.reasoning.delta',
            text: 'The',
          }),
          createEvent({
            id: 'reasoning-cumulative-2',
            type: 'agent.reasoning.delta',
            text: 'The user',
          }),
          createEvent({
            id: 'reasoning-cumulative-3',
            type: 'agent.reasoning.delta',
            text: 'The user is asking',
          }),
          createEvent({
            id: 'reasoning-cumulative-4',
            type: 'agent.reasoning.delta',
            text: 'The user is asking me to explain',
          }),
        ],
      },
    });

    expect(wrapper.findAll('.agent-line')).toHaveLength(1);
    const renderedText = wrapper.find('.agent-line').text();
    expect(renderedText).toContain('The user is asking me to explain');
    expect(renderedText).not.toContain('TheThe user');
  });

  it('流式思考开始时立即显示带 shimmer 的折叠头', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [],
        isStreaming: true,
      },
    });

    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(true);
    expect(wrapper.text()).toContain('正在思考');
    expect(wrapper.find('.ai-runtime-chain-label--thinking').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('思考过程');
  });

  it('思考完成后显示完成态头部，并隐藏 run 开始结束文案', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'run-start',
            type: 'agent.run.started',
          }),
          createEvent({
            id: 'reasoning-finished',
            type: 'agent.reasoning.delta',
            text: '我已经确认问题根因。',
          }),
          createEvent({
            id: 'run-completed',
            type: 'agent.run.completed',
            stopReason: 'end_turn',
          }),
        ],
      },
    });

    expect(wrapper.text()).toContain('思考完成');
    expect(wrapper.text()).toContain('我已经确认问题根因。');
    expect(wrapper.text()).not.toContain('已开始执行 Agent 流程');
    expect(wrapper.text()).not.toContain('Agent 执行完成');
  });

  it('超长 reasoning 直接完整展示，不再提供收起按钮', () => {
    const longReasoning = Array.from({ length: 980 }, () => '思').join('');
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'long-reasoning',
            type: 'agent.reasoning.delta',
            text: longReasoning,
          }),
        ],
      },
    });

    expect(wrapper.findAll('.agent-line__segment').length).toBeGreaterThan(1);
    expect(wrapper.find('.agent-line__toggle').exists()).toBe(false);
  });

  it('上下文预算事件不再暴露到用户时间线', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'token-budget-1',
            type: 'acontext.token.checked',
            visibility: 'debug',
            projectedInputTokensAvailable: true,
            projectedInputTokens: 12_345,
            systemPromptCharCount: 1_200,
            messageCharCount: 2_400,
            contextCharCount: 800,
            toolSchemaCharCount: 9_900,
            toolCount: 19,
            mcpToolCount: 15,
          }),
        ],
      },
    });

    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(false);
    expect(wrapper.text()).toBe('');
  });

  it('provider payload 诊断事件不再暴露到用户时间线', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'provider-payload-1',
            type: 'acontext.provider_payload.checked',
            visibility: 'debug',
            provider: 'deepseek',
            requestIndex: 2,
            requestBodyCharCount: 4_800,
            projectedInputTokens: 1_240,
            projectedInputTokensAvailable: true,
            messageCharCount: 3_100,
            systemMessageCharCount: 600,
            userMessageCharCount: 900,
            assistantMessageCharCount: 1_000,
            toolMessageCharCount: 600,
            reasoningReplayCharCount: 120,
            toolSchemaCharCount: 900,
            toolCount: 2,
            responseFormatCharCount: 300,
            reasoningInjected: true,
            tokenEstimateMethod: 'char_heuristic',
          }),
        ],
      },
    });

    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(false);
    expect(wrapper.text()).toBe('');
  });

  it('对 reasoning 文本做轻量行内 Markdown 渲染', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'reasoning-markdown',
            type: 'agent.reasoning.delta',
            text: '推荐 **城市的时间层叠**，并记录 `24h` 观察点，保持 *开放*。',
          }),
        ],
      },
    });

    expect(wrapper.text()).toContain('城市的时间层叠');
    expect(wrapper.get('.agent-line__strong').text()).toBe('城市的时间层叠');
    expect(wrapper.get('.agent-line__code').text()).toBe('24h');
    expect(wrapper.get('.agent-line__emphasis').text()).toBe('开放');
  });

  it('对 reasoning 文本做轻量块级 Markdown 渲染', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'reasoning-markdown-blocks',
            type: 'agent.reasoning.delta',
            text: [
              'Key Facts:',
              '- GitHub Stars: ~23,600',
              '- Downloads: 1.8M/month',
              '',
              'Timeline:',
              '- Oct 2024: Initial open-source launch',
            ].join('\\n'),
          }),
        ],
      },
    });

    const headings = wrapper.findAll('.agent-line__heading');
    const lists = wrapper.findAll('ul.agent-line__list');
    const listItems = wrapper.findAll('ul.agent-line__list li');

    expect(headings.map((heading) => heading.text())).toEqual(['Key Facts:', 'Timeline:']);
    expect(lists).toHaveLength(2);
    expect(listItems.map((item) => item.text())).toEqual([
      'GitHub Stars: ~23,600',
      'Downloads: 1.8M/month',
      'Oct 2024: Initial open-source launch',
    ]);
    expect(listItems.at(-1)?.text()).not.toContain('- Oct 2024');
  });

  it('对 reasoning fenced code block 使用与 AI 回复一致的代码块外观', () => {
    const wrapper = mount(AiAgentRuntimeTimeline, {
      props: {
        events: [
          createEvent({
            id: 'reasoning-code-block',
            type: 'agent.reasoning.delta',
            text: [
              '先检查脚本：',
              '',
              '```bash path:scripts/check.sh',
              'echo "start"',
              'pnpm exec vitest --run src/components/business/ai/AiAgentRuntimeTimeline.spec.ts',
              '```',
            ].join('\\n'),
          }),
        ],
      },
    });

    const codeBlock = wrapper.get('.ai-reasoning-code-block');

    expect(wrapper.text()).toContain('先检查脚本：');
    expect(wrapper.text()).not.toContain('```bash');
    expect(codeBlock.text()).toContain('scripts/check.sh');
    expect(codeBlock.text()).toContain('Bash');
    expect(codeBlock.text()).toContain('echo "start"');
    expect(codeBlock.find('button[aria-label="复制代码"]').exists()).toBe(true);
    expect(codeBlock.find('button[aria-label="折叠代码块"]').exists()).toBe(true);
  });
});
