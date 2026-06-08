import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import AiAgentModePanel from '@/components/business/ai/agent/AiAgentModePanel.vue';
import type { IAiChatMessage, IAiChatStreamRenderState } from '@/types/ai';

type AiRuntimeEvent = NonNullable<IAiChatStreamRenderState['runtimeEvents']>[number];

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

const createMessage = (overrides: Partial<IAiChatMessage>): IAiChatMessage => ({
  id: 'message-1',
  role: 'assistant',
  content: '',
  createdAt: '2026-04-28T10:00:00.000Z',
  references: [],
  ...overrides,
});

const createRuntimeEvent = (overrides: Partial<AiRuntimeEvent>): AiRuntimeEvent =>
  ({
    id: overrides.id ?? 'runtime-event-1',
    type: overrides.type ?? 'agent.reasoning.delta',
    runId: overrides.runId ?? 'run-1',
    sessionId: overrides.sessionId ?? 'session-1',
    agentId: overrides.agentId ?? 'agent-1',
    timestamp: overrides.timestamp ?? '2026-05-03T10:00:00.000Z',
    seq: overrides.seq ?? 1,
    schemaVersion: 1,
    redacted: true,
    visibility: overrides.visibility ?? 'user',
    level: overrides.level ?? 'info',
    text: '我先确认真实工具列表。',
    ...(overrides as object),
  }) as AiRuntimeEvent;

describe('AiAgentModePanel', () => {
  it('renders runtime timeline as the primary agent-mode surface', () => {
    const wrapper = mount(AiAgentModePanel, {
      props: {
        messages: [
          createMessage({ id: 'user-1', role: 'user', content: '检查项目结构' }),
          createMessage({
            id: 'assistant-1',
            content: '我会先查看目录。',
            stream: {
              status: 'streaming',
              runtimeEvents: [
                createRuntimeEvent({ id: 'reasoning-1', text: '我先确认项目结构。' }),
                createRuntimeEvent({
                  id: 'tool-start-1',
                  type: 'agent.tool.started',
                  toolUseId: 'tool-1',
                  toolName: 'list_dir',
                  inputPreview: '{"path":"src"}',
                }),
              ],
            },
          }),
        ],
        isTyping: true,
      },
      global: {
        stubs: {
          AiMarkdown: {
            props: ['content'],
            template: '<div class="markdown-stub" v-text="content" />',
          },
        },
      },
    });

    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(true);
    expect(wrapper.text()).toContain('检查项目结构');
    expect(wrapper.text()).toContain('我先确认项目结构。');
    expect(wrapper.find('.ai-agent-final-answer').exists()).toBe(false);
  });

  it('renders final answer after the execution timeline once final output starts', () => {
    const wrapper = mount(AiAgentModePanel, {
      props: {
        messages: [
          createMessage({
            id: 'assistant-1',
            content: '这是最终结论。',
            stream: {
              status: 'streaming',
              finalAnswerStarted: true,
              runtimeEvents: [createRuntimeEvent({ id: 'reasoning-1' })],
            },
          }),
        ],
        isTyping: true,
      },
      global: {
        stubs: {
          AiMarkdown: {
            props: ['content'],
            template: '<div class="markdown-stub" v-text="content" />',
          },
        },
      },
    });

    const runtimeTimeline = wrapper.find('.ai-runtime-timeline');
    const finalAnswer = wrapper.find('.ai-agent-final-answer');

    expect(runtimeTimeline.exists()).toBe(true);
    expect(finalAnswer.exists()).toBe(true);
    expect(wrapper.text()).toContain('这是最终结论。');
    expect(
      runtimeTimeline.element.compareDocumentPosition(finalAnswer.element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps debug-only budget events out of the visible agent timeline', () => {
    const wrapper = mount(AiAgentModePanel, {
      props: {
        messages: [
          createMessage({
            id: 'assistant-debug-1',
            stream: {
              status: 'streaming',
              runtimeEvents: [
                createRuntimeEvent({
                  id: 'token-budget-1',
                  type: 'acontext.token.checked',
                  visibility: 'debug',
                  projectedInputTokens: 3200,
                }),
              ],
            },
          }),
        ],
        isTyping: true,
      },
    });

    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(true);
    expect(wrapper.text()).toContain('正在思考');
    expect(wrapper.text()).not.toContain('上下文预算检查');
  });
});
