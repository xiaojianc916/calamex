import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AiAgentRuntimeTimeline from '@/components/business/ai/AiAgentRuntimeTimeline.vue';

import type { TAgentRuntimeEvent } from '@/types/agent-sidecar';

const createEvent = (overrides: Partial<TAgentRuntimeEvent>): TAgentRuntimeEvent => ({
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
        expect(wrapper.text()).toContain('完成调用 grep_search');
        expect(wrapper.text()).not.toContain('开始调用 grep_search');
    });

    it('工具 started 事件到达后立即出现节点', () => {
        const wrapper = mount(AiAgentRuntimeTimeline, {
            props: {
                events: [createEvent({
                    id: 'tool-start-immediate',
                    type: 'agent.tool.started',
                    toolName: 'read_file',
                    inputPreview: '{"path":"src/main.ts"}',
                })],
            },
        });

        expect(wrapper.find('.ai-runtime-task').exists()).toBe(true);
        expect(wrapper.text()).toContain('开始调用 read_file');
    });

    it('read_text_file 在完成后原地替换为读取完成文案', () => {
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
        expect(wrapper.text()).toContain('读取完成 D:\\test\\test.sh');
        expect(wrapper.text()).not.toContain('正在读取 D:\\test\\test.sh');
        expect(wrapper.find('.ai-runtime-task-content').exists()).toBe(false);
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
        expect(wrapper.text()).toContain('编辑完成 D:\\test\\test.sh');
        expect(wrapper.text()).not.toContain('正在编辑 D:\\test\\test.sh');
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

        expect(wrapper.text()).toContain('编辑完成 D:\\test\\nested.sh');
        expect(wrapper.text()).not.toContain('完成调用 write_file');
    });

    it('web_search 完成后原地改成 Complete Search，并保留真实来源胶囊', () => {
        const wrapper = mount(AiAgentRuntimeTimeline, {
            props: {
                events: [
                    createEvent({
                        id: 'web-search-start',
                        type: 'agent.tool.started',
                        toolUseId: 'web-search-1',
                        toolName: 'web_search',
                        inputPreview: '{"query":"profiles for Emmanuel Raymond","intent":"general","maxResults":3}',
                    }),
                    createEvent({
                        id: 'web-search-complete',
                        type: 'agent.tool.completed',
                        toolUseId: 'web-search-1',
                        toolName: 'web_search',
                        ok: true,
                        resultPreview: '[{"title":"X profile","url":"https://x.com/emmanuelraymond","snippet":"...","sourceType":"unknown","fetchedAt":"2026-05-03T10:00:02.000Z"},{"title":"Instagram profile","url":"https://www.instagram.com/emmanuelraymond/","snippet":"...","sourceType":"unknown","fetchedAt":"2026-05-03T10:00:03.000Z"},{"title":"GitHub profile","url":"https://github.com/emmanuelraymond","snippet":"...","sourceType":"github","fetchedAt":"2026-05-03T10:00:04.000Z"}]',
                    }),
                ],
            },
        });

        expect(wrapper.findAll('.ai-runtime-step.is-task')).toHaveLength(1);
        expect(wrapper.text()).toContain('Complete Search');
        expect(wrapper.text()).not.toContain('Searching for profiles for Emmanuel Raymond');

        const pills = wrapper.findAll('.ai-runtime-web-source-pill');
        expect(pills).toHaveLength(3);
        expect(wrapper.text()).toContain('www.x.com');
        expect(wrapper.text()).toContain('www.instagram.com');
        expect(wrapper.text()).toContain('www.github.com');
    });

    it('web_search 开始时显示 Searching for 查询文案', () => {
        const wrapper = mount(AiAgentRuntimeTimeline, {
            props: {
                events: [createEvent({
                    id: 'web-search-only-start',
                    type: 'agent.tool.started',
                    toolUseId: 'web-search-2',
                    toolName: 'web_search',
                    inputPreview: '{"query":"recent work","intent":"general","maxResults":2}',
                })],
            },
        });

        expect(wrapper.text()).toContain('Searching for recent work');
        expect(wrapper.text()).not.toContain('Complete Search');
    });

    it('tavily-search 完成后也会原地替换为 Complete Search', () => {
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

        expect(wrapper.text()).toContain('Complete Search');
        expect(wrapper.text()).not.toContain('Searching for today sports news');
    });

    it('tavily-search 结果包在嵌套 content 字符串里时也会渲染来源胶囊', () => {
        const wrapper = mount(AiAgentRuntimeTimeline, {
            props: {
                events: [
                    createEvent({
                        id: 'tavily-nested-start',
                        type: 'agent.tool.started',
                        toolUseId: 'tavily-nested-1',
                        toolName: 'tavily-search',
                        inputPreview: '{"query":"latest sports"}',
                    }),
                    createEvent({
                        id: 'tavily-nested-complete',
                        type: 'agent.tool.completed',
                        toolUseId: 'tavily-nested-1',
                        toolName: 'tavily-search',
                        ok: true,
                        resultPreview: '{"toolResult":{"status":"success","content":"{\\"results\\":[{\\"title\\":\\"ESPN\\",\\"url\\":\\"https://www.espn.com/nba/\\"},{\\"title\\":\\"BBC Sport\\",\\"url\\":\\"https://www.bbc.com/sport\\"}]}","meta":{"provider":"tavily"}}}',
                    }),
                ],
            },
        });

        expect(wrapper.text()).toContain('Complete Search');
        expect(wrapper.text()).toContain('www.espn.com');
        expect(wrapper.text()).toContain('www.bbc.com');
        expect(wrapper.findAll('.ai-runtime-web-source-pill').length).toBeGreaterThanOrEqual(2);
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
                events: [createEvent({
                    id: 'long-reasoning',
                    type: 'agent.reasoning.delta',
                    text: longReasoning,
                })],
            },
        });

        expect(wrapper.findAll('.agent-line__segment').length).toBeGreaterThan(1);
        expect(wrapper.find('.agent-line__toggle').exists()).toBe(false);
    });

    it('对 reasoning 文本做轻量行内 Markdown 渲染', () => {
        const wrapper = mount(AiAgentRuntimeTimeline, {
            props: {
                events: [createEvent({
                    id: 'reasoning-markdown',
                    type: 'agent.reasoning.delta',
                    text: '推荐 **城市的时间层叠**，并记录 `24h` 观察点，保持 *开放*。',
                })],
            },
        });

        expect(wrapper.text()).toContain('城市的时间层叠');
        expect(wrapper.get('.agent-line__strong').text()).toBe('城市的时间层叠');
        expect(wrapper.get('.agent-line__code').text()).toBe('24h');
        expect(wrapper.get('.agent-line__emphasis').text()).toBe('开放');
    });
});
