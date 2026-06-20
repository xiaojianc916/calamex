import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type PropType } from 'vue';

import type { TAiThreadEntry } from '@/components/business/ai/thread/projection';

const { threadEntriesToTimelineMock } = vi.hoisted(() => ({
  threadEntriesToTimelineMock: vi.fn(),
}));

vi.mock('@/components/business/ai/thread/projection', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/business/ai/thread/projection')>();

  return {
    ...actual,
    threadEntriesToTimeline: threadEntriesToTimelineMock,
  };
});

import AiChatThread from '@/components/business/ai/chat/AiChatThread.vue';

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

const userEntry: TAiThreadEntry = {
  kind: 'user-message',
  id: 'u1',
  messageId: 'u1',
  markdown: '你好',
  references: [],
};
const assistantEntry: TAiThreadEntry = {
  kind: 'assistant-text',
  id: 'a1',
  messageId: 'a1',
  markdown: '回复',
  streaming: false,
};

const DynamicScrollerStub = defineComponent({
  name: 'DynamicScroller',
  props: {
    items: { type: Array as PropType<readonly unknown[]>, required: true },
  },
  setup(props, { slots }) {
    return () =>
      h(
        'div',
        { class: 'ai-chat-list__scroller' },
        props.items.flatMap((item, index) => slots.default?.({ item, index, active: true }) ?? []),
      );
  },
});

const DynamicScrollerItemStub = defineComponent({
  name: 'DynamicScrollerItem',
  props: {
    item: { type: Object as PropType<unknown>, required: true },
    active: { type: Boolean, default: true },
    sizeDependencies: { type: Array as PropType<readonly unknown[]>, default: () => [] },
    emitResize: { type: Boolean, default: false },
  },
  setup(_props, { slots }) {
    return () => h('div', { class: 'vue-recycle-scroller__item-view' }, slots.default?.());
  },
});

const EntryViewStub = defineComponent({
  name: 'AiThreadEntryView',
  props: {
    entry: { type: Object as PropType<TAiThreadEntry>, required: true },
  },
  setup(props) {
    return () => h('div', { class: 'entry-stub', 'data-entry-kind': props.entry.kind });
  },
});

const VirtualMessageItemStub = defineComponent({
  name: 'AiThreadVirtualMessageItem',
  props: {
    message: { type: Object as PropType<{ id: string }>, required: true },
  },
  setup(props) {
    return () => h('div', { class: 'message-stub', 'data-message-id': props.message.id });
  },
});

const stubs = {
  DynamicScroller: DynamicScrollerStub,
  DynamicScrollerItem: DynamicScrollerItemStub,
  AiThreadEntryView: EntryViewStub,
  AiThreadVirtualMessageItem: VirtualMessageItemStub,
};

describe('AiChatThread(entries 渲染路径)', () => {
  beforeEach(() => {
    threadEntriesToTimelineMock.mockReset();
    threadEntriesToTimelineMock.mockReturnValue([userEntry, assistantEntry]);
  });

  it('renderFromEntries 为 true 时按投影时间线逐条目渲染,而非按消息', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [
          { id: 'legacy', role: 'assistant', content: '旧路径', createdAt: '', references: [] },
        ],
        isTyping: false,
        renderFromEntries: true,
        threadEntries: [],
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: { stubs },
    });

    expect(threadEntriesToTimelineMock).toHaveBeenCalled();
    expect(wrapper.findAll('.entry-stub')).toHaveLength(2);
    expect(wrapper.findAll('.message-stub')).toHaveLength(0);
    expect(
      wrapper.findAll('.entry-stub').map((node) => node.attributes('data-entry-kind')),
    ).toEqual(['user-message', 'assistant-text']);
  });

  it('entries 为空时渲染空态', () => {
    threadEntriesToTimelineMock.mockReturnValue([]);

    const wrapper = mount(AiChatThread, {
      props: {
        messages: [],
        isTyping: false,
        renderFromEntries: true,
        threadEntries: [],
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: { stubs },
    });

    expect(wrapper.text()).toContain('还没有对话');
  });

  it('entries 模式下按消息边界渲染 after-message 插槽(检查点)', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [{ id: 'a1', role: 'assistant', content: '回复', createdAt: '', references: [] }],
        isTyping: false,
        renderFromEntries: true,
        threadEntries: [],
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      slots: {
        'after-message': (slotProps: { message: { id: string } }) =>
          h('div', { class: 'after-msg', 'data-message-id': slotProps.message.id }, 'checkpoint'),
      },
      global: { stubs },
    });

    const afterNodes = wrapper.findAll('.after-msg');
    expect(afterNodes).toHaveLength(1);
    expect(afterNodes[0]?.attributes('data-message-id')).toBe('a1');
  });
});
