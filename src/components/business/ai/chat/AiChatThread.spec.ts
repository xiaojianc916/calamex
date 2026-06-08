import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { h } from 'vue';

import { Conversation } from '@/components/ai-elements/conversation';
import AiChatThread from '@/components/business/ai/chat/AiChatThread.vue';
import type { IAiChatMessage } from '@/types/ai';

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

describe('AiChatThread', () => {
  it('hides the standalone typing bubble when the last assistant message is already streaming', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [
          createMessage({
            stream: {
              status: 'streaming',
            },
          }),
        ],
        isTyping: true,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: { template: '<div class="message-item-stub" />' },
        },
      },
    });

    expect(wrapper.find('.ai-message-typing').exists()).toBe(false);
  });

  it('keeps the standalone typing bubble for non-streaming loading states', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [createMessage({ role: 'user', content: '浣犲ソ', stream: undefined })],
        isTyping: true,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: { template: '<div class="message-item-stub" />' },
        },
      },
    });

    expect(wrapper.find('.ai-message-typing').exists()).toBe(true);
    expect(wrapper.find('.ai-logo').exists()).toBe(false);
  });

  it('uses the provided standalone typing label', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [createMessage({ role: 'user', content: '生成计划', stream: undefined })],
        isTyping: true,
        typingLabel: '正在生成计划',
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: { template: '<div class="message-item-stub" />' },
        },
      },
    });

    expect(wrapper.find('.ai-message-typing').attributes('aria-label')).toBe('正在生成计划');
    expect(wrapper.text()).toContain('正在生成计划');
  });

  it('locks horizontal overflow inside the thread container instead of exposing a bottom slider', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [createMessage({ content: '表格内容改为在局部区域滚动' })],
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: { template: '<div class="message-item-stub" />' },
        },
      },
    });

    expect(wrapper.find('.ai-chat-list').classes()).toContain('overflow-x-hidden');
  });

  it('keeps resize following responsive while the assistant is typing', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [createMessage({ content: '正在生成' })],
        isTyping: true,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: { template: '<div class="message-item-stub" />' },
        },
      },
    });

    expect(wrapper.findComponent(Conversation).props('resize')).toBeUndefined();
  });

  it('uses instant resize after typing ends so late layout changes do not animate the viewport', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [createMessage({ content: '生成完成' })],
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: { template: '<div class="message-item-stub" />' },
        },
      },
    });

    expect(wrapper.findComponent(Conversation).props('resize')).toBe('instant');
  });

  it('forwards message actions with both payload arguments intact', async () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [
          createMessage({
            actions: [
              {
                id: 'allow-agent-execution',
                label: '鱏佳銭鍊Ñ',
              },
            ],
          }),
        ],
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: {
            props: ['message'],
            emits: ['messageAction'],
            template:
              '<button class="message-action-stub" @click="$emit(\'messageAction\', message.id, \'allow-agent-execution\')">action</button>',
          },
        },
      },
    });

    await wrapper.find('.message-action-stub').trigger('click');

    expect(wrapper.emitted('messageAction')).toEqual([['message-1', 'allow-agent-execution']]);
  });

  it('renders the per-message trailing slot with the current message payload', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [
          createMessage({ id: 'message-1', content: '第一条消息' }),
          createMessage({ id: 'message-2', content: '第二条消息' }),
        ],
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      slots: {
        'after-message': ({ message }: { message: IAiChatMessage }) =>
          h('div', { class: 'after-message-stub' }, message.id),
      },
      global: {
        stubs: {
          AiMessageItem: { template: '<div class="message-item-stub" />' },
        },
      },
    });

    expect(wrapper.findAll('.after-message-stub')).toHaveLength(2);
    expect(wrapper.findAll('.after-message-stub').map((node) => node.text())).toEqual([
      'message-1',
      'message-2',
    ]);
  });

  it('renders realtime provider tool activity inside the assistant message without standalone dots', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [
          createMessage({
            content: 'AI 姝ｅ湺鮑妩浣跨敢宓ゥ叿锡ﾚread_file',
            toolCalls: [
              {
                id: 'tool-call-read-file',
                name: 'read_file',
                status: 'running',
                summary: 'test.sh',
              },
            ],
            stream: {
              status: 'streaming',
            },
          }),
        ],
        isTyping: true,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div />' },
        },
      },
    });

    expect(wrapper.text()).toContain('读取');
    expect(wrapper.text()).toContain('test.sh');
    expect(wrapper.find('.ai-tool-running-dots').exists()).toBe(false);
    expect(wrapper.find('.ai-message-typing').exists()).toBe(false);
  });

  it('hides the standalone typing bubble when agent progress is already visible', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [
          createMessage({
            content: 'Agent 正在调用工具…',
            stream: undefined,
          }),
        ],
        isTyping: true,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: { template: '<div class="message-item-stub" />' },
        },
      },
    });

    expect(wrapper.find('.ai-message-typing').exists()).toBe(false);
  });

  it('hides the standalone typing bubble for a silent agent placeholder', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [
          createMessage({
            content: '',
            stream: undefined,
          }),
        ],
        isTyping: true,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: { template: '<div class="message-item-stub" />' },
        },
      },
    });

    expect(wrapper.find('.ai-message-typing').exists()).toBe(false);
  });

  it('renders a Codex-like marker when Mastra compresses context automatically', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [
          createMessage({
            id: 'assistant-memory-1',
            content: '已继续处理。',
            stream: {
              status: 'completed',
              runtimeEvents: [
                {
                  id: 'memory-compressed-1',
                  type: 'acontext.memory.compressed',
                  runId: 'run-1',
                  sessionId: 'session-1',
                  agentId: 'agent-1',
                  timestamp: '2026-05-03T10:00:00.000Z',
                  seq: 0,
                  schemaVersion: 1,
                  redacted: true,
                  visibility: 'user',
                  level: 'info',
                  operationType: 'observation',
                  tokensActivated: 32_000,
                  observationTokens: 900,
                },
              ],
            },
          }),
        ],
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: { template: '<div class="message-item-stub" />' },
        },
      },
    });

    expect(wrapper.find('.ai-context-compression-divider').exists()).toBe(true);
    expect(wrapper.text()).toContain('上下文已自动压缩');
  });

  it('renders a Codex-like marker when Zed-style context compaction completes', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [
          createMessage({
            id: 'assistant-compaction-1',
            content: '继续执行。',
            stream: {
              status: 'completed',
              runtimeEvents: [
                {
                  id: 'context-compaction-completed-1',
                  type: 'acontext.context_compaction.completed',
                  runId: 'run-1',
                  sessionId: 'session-1',
                  agentId: 'agent-1',
                  timestamp: '2026-05-03T10:00:00.000Z',
                  seq: 0,
                  schemaVersion: 1,
                  redacted: true,
                  visibility: 'user',
                  level: 'info',
                  compactionId: 'compaction-1',
                  reason: 'budget',
                  summaryCharCount: 1200,
                },
              ],
            },
          }),
        ],
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: { template: '<div class="message-item-stub" />' },
        },
      },
    });

    expect(wrapper.find('.ai-context-compression-divider').exists()).toBe(true);
    expect(wrapper.text()).toContain('上下文已自动压缩');
  });

  it('does not render Plan execution synthetic messages in the chat thread', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [
          createMessage({ id: 'user-1', role: 'user', content: '执行这个计划' }),
          createMessage({
            id: 'agent-flow:run-1',
            content: 'AI 正在自动使用工具：读取文件',
            toolCalls: [
              {
                id: 'tool-call-1',
                name: 'read_file',
                status: 'running',
                summary: '读取文件',
              },
            ],
          }),
        ],
        hasExtraContent: true,
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: {
            props: ['message'],
            template: '<div class="message-item-stub" v-text="message.content" />',
          },
        },
      },
    });

    expect(wrapper.findAll('.message-item-stub')).toHaveLength(1);
    expect(wrapper.text()).toContain('执行这个计划');
    expect(wrapper.text()).not.toContain('AI 正在自动使用工具');
  });

  it('过滤掉以错误前缀开头的助手回复消息', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [
          createMessage({ id: 'user-1', role: 'user', content: '帮我跑一下' }),
          createMessage({
            id: 'assistant-error-1',
            content: 'Agent 执行失败：Node sidecar 未就绪',
          }),
        ],
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: {
            props: ['message'],
            template: '<div class="message-item-stub" v-text="message.content" />',
          },
        },
      },
    });

    expect(wrapper.findAll('.message-item-stub')).toHaveLength(1);
    expect(wrapper.text()).toContain('帮我跑一下');
    expect(wrapper.text()).not.toContain('Agent 执行失败');
  });
});
