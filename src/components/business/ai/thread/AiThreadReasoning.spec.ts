import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import AiThreadReasoning from './AiThreadReasoning.vue';
import type { IAiThreadReasoningEntry } from './projection';

// 轻量替身:仅把命名插槽原样铺出,以便断言 title/meta 插槽内容,绕开 Collapsible 依赖。
const ThreadEntryDisclosureStub = {
  name: 'ThreadEntryDisclosure',
  props: ['open', 'title', 'disabled', 'leadingChevron'],
  template:
    '<div class="disclosure"><slot name="leading" /><slot name="title" /><slot name="meta" /><slot name="content" /></div>',
};

const stubs = {
  ThreadEntryDisclosure: ThreadEntryDisclosureStub,
  AiMarkdown: true,
  BrainCircuit: true,
  Brain: true,
};

const makeEntry = (
  overrides: Partial<IAiThreadReasoningEntry> = {},
): IAiThreadReasoningEntry => ({
  kind: 'reasoning',
  id: 'r1',
  messageId: 'm1',
  segments: ['思考中'],
  isLong: false,
  streaming: false,
  ...overrides,
});

describe('AiThreadReasoning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('流式时标题做微光(shimmer)并显示“Thinking”', () => {
    const wrapper = mount(AiThreadReasoning, {
      props: { entry: makeEntry({ streaming: true }), open: false },
      global: { stubs },
    });
    const title = wrapper.find('.ai-thread-reasoning__title');
    expect(title.classes()).toContain('is-streaming');
    expect(title.text()).toBe('Thinking');
  });

  it('完成态标题不再微光,显示“Thinking”,且不显示用时', () => {
    const wrapper = mount(AiThreadReasoning, {
      props: { entry: makeEntry({ streaming: false }), open: false },
      global: { stubs },
    });
    const title = wrapper.find('.ai-thread-reasoning__title');
    expect(title.classes()).not.toContain('is-streaming');
    expect(title.text()).toBe('Thinking');
    expect(wrapper.find('.ai-thread-reasoning__elapsed').exists()).toBe(false);
  });

  it('流式期间逐秒显示推理用时', async () => {
    const wrapper = mount(AiThreadReasoning, {
      props: { entry: makeEntry({ streaming: true }), open: false },
      global: { stubs },
    });
    expect(wrapper.find('.ai-thread-reasoning__elapsed').exists()).toBe(false);
    vi.advanceTimersByTime(3000);
    await nextTick();
    const elapsed = wrapper.find('.ai-thread-reasoning__elapsed');
    expect(elapsed.exists()).toBe(true);
    expect(elapsed.text()).toBe('用时 3s');
  });

  it('历史重载(从未流式)不显示推理用时', async () => {
    const wrapper = mount(AiThreadReasoning, {
      props: { entry: makeEntry({ streaming: false }), open: false },
      global: { stubs },
    });
    vi.advanceTimersByTime(5000);
    await nextTick();
    expect(wrapper.find('.ai-thread-reasoning__elapsed').exists()).toBe(false);
  });
});
