import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import AiChatThread from '@/components/business/ai/AiChatThread.vue';
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
  });

  it('forwards message actions with both payload arguments intact', async () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [createMessage({
          actions: [{
            id: 'allow-agent-execution',
            label: '鍏佽鎵ц',
          }],
        })],
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMessageItem: {
            props: ['message'],
            emits: ['messageAction'],
            template: '<button class="message-action-stub" @click="$emit(\'messageAction\', message.id, \'allow-agent-execution\')">action</button>',
          },
        },
      },
    });

    await wrapper.find('.message-action-stub').trigger('click');

    expect(wrapper.emitted('messageAction')).toEqual([
      ['message-1', 'allow-agent-execution'],
    ]);
  });

  it('renders realtime provider tool activity inside the assistant message without standalone dots', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [
          createMessage({
            content: 'AI 姝ｅ湪鑷姩浣跨敤宸ュ叿锛歳ead_file',
            toolCalls: [{
              id: 'tool-call-read-file',
              name: 'read_file',
              status: 'running',
              summary: 'test.sh',
            }],
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
});
