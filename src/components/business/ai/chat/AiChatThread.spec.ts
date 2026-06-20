import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type PropType } from 'vue';

import type { TAiThreadEntry } from '@/components/business/ai/thread/projection';
import type { IAiThreadPlanDetails } from '@/components/business/ai/thread/types';
import type { TAiServicePlatformId } from '@/constants/ai/providers';

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

// 轻量替身:真实虚拟化依赖布局测量,jsdom/happy-dom 下无意义。这里让虚拟器把全部条目作为
// 可见行返回,并补齐聊天专用方法(isAtEnd/getDistanceFromEnd/scrollToEnd),只验证渲染与事件逻辑。
vi.mock('@tanstack/vue-virtual', () => ({
  useVirtualizer: (optionsInput: unknown) => {
    const resolveOptions = (): { count: number } => {
      if (typeof optionsInput === 'function') {
        return (optionsInput as () => { count: number })();
      }
      if (optionsInput && typeof optionsInput === 'object' && 'value' in optionsInput) {
        return (optionsInput as { value: { count: number } }).value;
      }
      return optionsInput as { count: number };
    };

    const buildRows = () => {
      const { count } = resolveOptions();
      return Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 96,
        size: 96,
        end: (index + 1) * 96,
        lane: 0,
      }));
    };

    return {
      value: {
        getVirtualItems: buildRows,
        getTotalSize: () => buildRows().length * 96,
        measureElement: () => {},
        measure: () => {},
        isAtEnd: () => true,
        getDistanceFromEnd: () => 0,
        scrollToEnd: () => {},
      },
    };
  },
}));

import AiChatThread from '@/components/business/ai/chat/AiChatThread.vue';

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

const baseProps: { platformId: TAiServicePlatformId; providerLabel: string } = {
  platformId: 'deepseek',
  providerLabel: 'DeepSeek',
};

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

const streamingAssistantEntry: TAiThreadEntry = {
  kind: 'assistant-text',
  id: 'a1',
  messageId: 'a1',
  markdown: '回复',
  streaming: true,
};

const createPlanDetails = (
  overrides: Partial<IAiThreadPlanDetails> = {},
): IAiThreadPlanDetails => ({
  summary: '重构面板接线',
  status: 'pending_approval',
  steps: [],
  isPlanning: false,
  isApproving: false,
  canEdit: true,
  canApprove: true,
  approvedAt: null,
  ...overrides,
});

const EntryViewStub = defineComponent({
  name: 'AiThreadEntryView',
  props: {
    entry: { type: Object as PropType<TAiThreadEntry>, required: true },
    planDetails: { type: Object as PropType<IAiThreadPlanDetails>, default: undefined },
  },
  emits: [
    'update:open',
    'changedFilesRollback',
    'changedFilesPin',
    'planApprove',
    'planReject',
    'planRegenerate',
    'planUpdateStepTitle',
    'planRemoveStep',
  ],
  setup(props, { emit }) {
    const buttons: Array<[string, () => void]> = [
      ['cf-rollback', () => emit('changedFilesRollback', 'm1', 'sum1')],
      ['cf-pin', () => emit('changedFilesPin', 'm1', 'sum1', true)],
      ['plan-approve', () => emit('planApprove')],
      ['plan-reject', () => emit('planReject')],
      ['plan-regenerate', () => emit('planRegenerate')],
      ['plan-update', () => emit('planUpdateStepTitle', 'step-1', '新标题')],
      ['plan-remove', () => emit('planRemoveStep', 'step-2')],
    ];

    return () =>
      h(
        'div',
        { class: 'entry-stub', 'data-entry-kind': props.entry.kind },
        buttons.map(([className, onClick]) => h('button', { class: className, onClick })),
      );
  },
});

const stubs = {
  AiThreadEntryView: EntryViewStub,
};

describe('AiChatThread（entries 渲染路径）', () => {
  beforeEach(() => {
    threadEntriesToTimelineMock.mockReset();
    threadEntriesToTimelineMock.mockReturnValue([userEntry, assistantEntry]);
  });

  it('按投影时间线逐条目渲染', () => {
    const wrapper = mount(AiChatThread, {
      props: { ...baseProps, messages: [], isTyping: false, threadEntries: [] },
      global: { stubs },
    });

    expect(threadEntriesToTimelineMock).toHaveBeenCalled();
    const entryNodes = wrapper.findAll('.entry-stub');
    expect(entryNodes).toHaveLength(2);
    expect(entryNodes.map((node) => node.attributes('data-entry-kind'))).toEqual([
      'user-message',
      'assistant-text',
    ]);
  });

  it('时间线为空时渲染空态', () => {
    threadEntriesToTimelineMock.mockReturnValue([]);

    const wrapper = mount(AiChatThread, {
      props: { ...baseProps, messages: [], isTyping: false, threadEntries: [] },
      global: { stubs },
    });

    expect(wrapper.text()).toContain('还没有对话');
  });

  it('按消息边界渲染单条 after-message 插槽（检查点）', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        ...baseProps,
        messages: [{ id: 'a1', role: 'assistant', content: '回复', createdAt: '', references: [] }],
        isTyping: false,
        threadEntries: [],
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

  it('为每条来源消息分别渲染 after-message 插槽', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        ...baseProps,
        messages: [
          { id: 'u1', role: 'user', content: '你好', createdAt: '', references: [] },
          { id: 'a1', role: 'assistant', content: '回复', createdAt: '', references: [] },
        ],
        isTyping: false,
        threadEntries: [],
      },
      slots: {
        'after-message': (slotProps: { message: { id: string } }) =>
          h('div', { class: 'after-msg', 'data-message-id': slotProps.message.id }, 'checkpoint'),
      },
      global: { stubs },
    });

    const afterNodes = wrapper.findAll('.after-msg');
    expect(afterNodes).toHaveLength(2);
    expect(afterNodes.map((node) => node.attributes('data-message-id'))).toEqual(['u1', 'a1']);
  });

  it('末条 entry 正在流式时隐藏独立 typing 气泡', () => {
    threadEntriesToTimelineMock.mockReturnValue([streamingAssistantEntry]);

    const wrapper = mount(AiChatThread, {
      props: { ...baseProps, messages: [], isTyping: true, threadEntries: [] },
      global: { stubs },
    });

    expect(wrapper.find('.ai-message-typing').exists()).toBe(false);
  });

  it('末条 entry 非流式时保留独立 typing 气泡', () => {
    threadEntriesToTimelineMock.mockReturnValue([userEntry]);

    const wrapper = mount(AiChatThread, {
      props: { ...baseProps, messages: [], isTyping: true, threadEntries: [] },
      global: { stubs },
    });

    expect(wrapper.find('.ai-message-typing').exists()).toBe(true);
  });

  it('使用传入的 typing 文案', () => {
    threadEntriesToTimelineMock.mockReturnValue([userEntry]);

    const wrapper = mount(AiChatThread, {
      props: {
        ...baseProps,
        messages: [],
        isTyping: true,
        typingLabel: '正在生成计划',
        threadEntries: [],
      },
      global: { stubs },
    });

    expect(wrapper.find('.ai-message-typing').attributes('aria-label')).toBe('正在生成计划');
    expect(wrapper.text()).toContain('正在生成计划');
  });

  it('锁定容器横向溢出，不暴露底部滑块', () => {
    const wrapper = mount(AiChatThread, {
      props: { ...baseProps, messages: [], isTyping: false, threadEntries: [] },
      global: { stubs },
    });

    expect(wrapper.find('.ai-chat-list').classes()).toContain('overflow-x-hidden');
  });

  it('为虚拟行挂载 data-index 以驱动 TanStack 动态测量', () => {
    threadEntriesToTimelineMock.mockReturnValue([userEntry, assistantEntry]);

    const wrapper = mount(AiChatThread, {
      props: { ...baseProps, messages: [], isTyping: false, threadEntries: [] },
      global: { stubs },
    });

    const rows = wrapper.findAll('.ai-chat-list__row');
    expect(rows).toHaveLength(2);
    expect(rows.map((node) => node.attributes('data-index'))).toEqual(['0', '1']);
  });

  it('将 planDetails 透传给 AiThreadEntryView', () => {
    threadEntriesToTimelineMock.mockReturnValue([assistantEntry]);
    const planDetails = createPlanDetails({ summary: '内联计划明细' });

    const wrapper = mount(AiChatThread, {
      props: { ...baseProps, messages: [], isTyping: false, planDetails, threadEntries: [] },
      global: { stubs },
    });

    expect(wrapper.findComponent({ name: 'AiThreadEntryView' }).props('planDetails')).toEqual(
      planDetails,
    );
  });

  it('从时间线转发 changed-files 回滚与固定事件', async () => {
    threadEntriesToTimelineMock.mockReturnValue([assistantEntry]);

    const wrapper = mount(AiChatThread, {
      props: { ...baseProps, messages: [], isTyping: false, threadEntries: [] },
      global: { stubs },
    });

    await wrapper.find('.cf-rollback').trigger('click');
    await wrapper.find('.cf-pin').trigger('click');

    expect(wrapper.emitted('changedFilesRollback')?.[0]).toEqual(['m1', 'sum1']);
    expect(wrapper.emitted('changedFilesPin')?.[0]).toEqual(['m1', 'sum1', true]);
  });

  it('从时间线转发 plan 审批与编辑事件', async () => {
    threadEntriesToTimelineMock.mockReturnValue([assistantEntry]);

    const wrapper = mount(AiChatThread, {
      props: { ...baseProps, messages: [], isTyping: false, threadEntries: [] },
      global: { stubs },
    });

    await wrapper.find('.plan-approve').trigger('click');
    await wrapper.find('.plan-reject').trigger('click');
    await wrapper.find('.plan-regenerate').trigger('click');
    await wrapper.find('.plan-update').trigger('click');
    await wrapper.find('.plan-remove').trigger('click');

    expect(wrapper.emitted('planApprove')).toHaveLength(1);
    expect(wrapper.emitted('planReject')).toHaveLength(1);
    expect(wrapper.emitted('planRegenerate')).toHaveLength(1);
    expect(wrapper.emitted('planUpdateStepTitle')?.[0]).toEqual(['step-1', '新标题']);
    expect(wrapper.emitted('planRemoveStep')?.[0]).toEqual(['step-2']);
  });
});
