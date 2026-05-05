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
                toolName: 'grep_search',
                inputPreview: '{"query":"agent-sidecar|39871"}',
            }),
            createEvent({
                id: 'tool-completed-1',
                type: 'agent.tool.completed',
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

        expect(wrapper.text()).toContain('Chain of Thought');
        expect(wrapper.findAll('.agent-line')).toHaveLength(1);
        expect(wrapper.text()).toContain('我先确认 sidecar 是否是旧进程。');
        expect(wrapper.findAll('.ai-runtime-task')).toHaveLength(2);
        expect(wrapper.text()).toContain('开始调用 grep_search');
        expect(wrapper.text()).toContain('完成调用 grep_search');
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

    it('超长 reasoning 默认展开，并支持收起与再次展开', async () => {
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

        const expandedSegmentCount = wrapper.findAll('.agent-line__segment').length;
        const toggle = wrapper.get('.agent-line__toggle');

        expect(expandedSegmentCount).toBeGreaterThan(1);
        expect(toggle.text()).toContain('收起长推理');

        await toggle.trigger('click');

        expect(wrapper.findAll('.agent-line__segment')).toHaveLength(1);
        expect(wrapper.get('.agent-line__toggle').text()).toContain('展开全部推理');

        await wrapper.get('.agent-line__toggle').trigger('click');

        expect(wrapper.findAll('.agent-line__segment').length).toBe(expandedSegmentCount);
    });
});
