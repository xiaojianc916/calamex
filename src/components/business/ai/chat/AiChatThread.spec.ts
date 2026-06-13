import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type PropType } from 'vue';

import AiChatThread from '@/components/business/ai/chat/AiChatThread.vue';
import type { IAiThreadPlanDetails } from '@/components/business/ai/thread/types';
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

// 轻量替身：真实滚动与逐条消息渲染分别在组件自身测试中覆盖；此处只验证
// AiChatThread 传入的可见消息、逐消息 after-message 插槽与事件转发。
const DynamicScrollerStub = defineComponent({
  name: 'DynamicScroller',
  props: {
    items: {
      type: Array as PropType<readonly unknown[]>,
      required: true,
    },
  },
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'ai-chat-list__scroller' }, [
        ...props.items.flatMap(
          (item, index) => slots.default?.({ item, index, active: true }) ?? [],
        ),
        ...(slots.after?.() ?? []),
      ]);
  },
});

const DynamicScrollerItemStub = defineComponent({
  name: 'DynamicScrollerItem',
  props: {
    item: {
      type: Object as PropType<unknown>,
      required: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    sizeDependencies: {
      type: Array as PropType<readonly unknown[]>,
      default: () => [],
    },
    emitResize: {
      type: Boolean,
      default: false,
    },
  },
  setup(_props, { slots }) {
    return () => h('div', { class: 'vue-recycle-scroller__item-view' }, slots.default?.());
  },
});

const VirtualMessageItemStub = {
  name: 'AiThreadVirtualMessageItem',
  props: [
    'message',
    'workspaceRootPath',
    'planDetails',
    'revertingChangedFilesSummaryId',
    'pinningChangedFilesSummaryId',
  ],
  emits: [
    'changedFilesRollback',
    'changedFilesPin',
    'planApprove',
    'planReject',
    'planRegenerate',
    'planUpdateStepTitle',
    'planRemoveStep',
  ],
  template: `
    <div class="timeline-msg-stub" :data-message-id="message.id">
      <span class="timeline-msg-content" v-text="message.content"></span>
      <slot name="after-message" :message="message" />
      <button class="cf-rollback" @click="$emit('changedFilesRollback', 'm1', 'sum1')"></button>
      <button class="cf-pin" @click="$emit('changedFilesPin', 'm1', 'sum1', true)"></button>
      <button class="plan-approve" @click="$emit('planApprove')"></button>
      <button class="plan-reject" @click="$emit('planReject')"></button>
      <button class="plan-regenerate" @click="$emit('planRegenerate')"></button>
      <button class="plan-update" @click="$emit('planUpdateStepTitle', 'step-1', '新标题')"></button>
      <button class="plan-remove" @click="$emit('planRemoveStep', 'step-2')"></button>
    </div>
  `,
};

const threadStubs = {
  DynamicScroller: DynamicScrollerStub,
  DynamicScrollerItem: DynamicScrollerItemStub,
  AiThreadVirtualMessageItem: VirtualMessageItemStub,
};

describe('AiChatThread', () => {
  it('hides the standalone typing bubble when the last assistant message is already streaming', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [createMessage({ stream: { status: 'streaming' } })],
        isTyping: true,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: { stubs: threadStubs },
    });

    expect(wrapper.find('.ai-message-typing').exists()).toBe(false);
  });

  it('keeps the standalone typing bubble for non-streaming loading states', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [createMessage({ role: 'user', content: '你好', stream: undefined })],
        isTyping: true,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: { stubs: threadStubs },
    });

    expect(wrapper.find('.ai-message-typing').exists()).toBe(true);
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
      global: { stubs: threadStubs },
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
      global: { stubs: threadStubs },
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
      global: { stubs: threadStubs },
    });

    expect(wrapper.findComponent({ name: 'DynamicScrollerItem' }).props('emitResize')).toBe(true);
  });

  it('uses instant resize after typing ends so late layout changes do not animate the viewport', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [createMessage({ content: '生成完成' })],
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: { stubs: threadStubs },
    });

    expect(wrapper.findComponent({ name: 'DynamicScroller' }).exists()).toBe(true);
  });

  it('renders the empty state when there is nothing to show', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [],
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: { stubs: threadStubs },
    });

    expect(wrapper.text()).toContain('还没有对话');
  });

  it('passes the per-message after-message slot through the flat timeline', () => {
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
      global: { stubs: threadStubs },
    });

    expect(wrapper.findAll('.after-message-stub')).toHaveLength(2);
    expect(wrapper.findAll('.after-message-stub').map((node) => node.text())).toEqual([
      'message-1',
      'message-2',
    ]);
  });

  it('does not render Plan execution synthetic messages in the chat thread', () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [
          createMessage({ id: 'user-1', role: 'user', content: '执行这个计划' }),
          createMessage({ id: 'agent-flow:run-1', content: 'AI 正在自动使用工具：读取文件' }),
        ],
        hasExtraContent: true,
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: { stubs: threadStubs },
    });

    expect(wrapper.findAll('.timeline-msg-stub')).toHaveLength(1);
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
      global: { stubs: threadStubs },
    });

    expect(wrapper.findAll('.timeline-msg-stub')).toHaveLength(1);
    expect(wrapper.text()).toContain('帮我跑一下');
    expect(wrapper.text()).not.toContain('Agent 执行失败');
  });

  it('forwards changed-files rollback and pin events from the timeline', async () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [createMessage({ content: '改动汇总' })],
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          ...threadStubs,
          AiThreadVirtualMessageItem: {
            name: 'AiThreadVirtualMessageItem',
            emits: ['changedFilesRollback', 'changedFilesPin'],
            template:
              "<div><button class=\"cf-rollback\" @click=\"$emit('changedFilesRollback', 'm1', 'sum1')\"></button><button class=\"cf-pin\" @click=\"$emit('changedFilesPin', 'm1', 'sum1', true)\"></button></div>",
          },
        },
      },
    });

    await wrapper.find('.cf-rollback').trigger('click');
    await wrapper.find('.cf-pin').trigger('click');

    expect(wrapper.emitted('changedFilesRollback')?.[0]).toEqual(['m1', 'sum1']);
    expect(wrapper.emitted('changedFilesPin')?.[0]).toEqual(['m1', 'sum1', true]);
  });

  it('forwards plan details to the flat timeline so plan approval renders inline', () => {
    const planDetails = createPlanDetails({ summary: '内联计划明细' });
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [createMessage({ id: 'thread-plan-control', content: '' })],
        isTyping: false,
        planDetails,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          ...threadStubs,
          AiThreadVirtualMessageItem: {
            name: 'AiThreadVirtualMessageItem',
            props: ['message', 'planDetails'],
            template: '<div class="timeline-stub" />',
          },
        },
      },
    });

    expect(
      wrapper.findComponent({ name: 'AiThreadVirtualMessageItem' }).props('planDetails'),
    ).toEqual(planDetails);
  });

  it('forwards plan approval and edit events from the timeline to the panel', async () => {
    const wrapper = mount(AiChatThread, {
      props: {
        messages: [createMessage({ id: 'thread-plan-control', content: '' })],
        isTyping: false,
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          ...threadStubs,
          AiThreadVirtualMessageItem: {
            name: 'AiThreadVirtualMessageItem',
            emits: [
              'planApprove',
              'planReject',
              'planRegenerate',
              'planUpdateStepTitle',
              'planRemoveStep',
            ],
            template: `
              <div>
                <button class="plan-approve" @click="$emit('planApprove')"></button>
                <button class="plan-reject" @click="$emit('planReject')"></button>
                <button class="plan-regenerate" @click="$emit('planRegenerate')"></button>
                <button class="plan-update" @click="$emit('planUpdateStepTitle', 'step-1', '新标题')"></button>
                <button class="plan-remove" @click="$emit('planRemoveStep', 'step-2')"></button>
              </div>
            `,
          },
        },
      },
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
