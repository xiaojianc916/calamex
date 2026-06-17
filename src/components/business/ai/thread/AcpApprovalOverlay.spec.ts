import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AcpApprovalOverlay from './AcpApprovalOverlay.vue';

const hoisted = vi.hoisted(() => ({
  resolve: vi.fn(),
  dismiss: vi.fn(),
  store: { current: null as unknown },
}));

vi.mock('@/composables/ai/useAcpApproval', async () => {
  const { computed } = await import('vue');
  return {
    useAcpApproval: () => ({
      current: computed(() => hoisted.store.current),
      hasPending: computed(() => hoisted.store.current !== null),
      pending: computed(() => (hoisted.store.current ? [hoisted.store.current] : [])),
      resolve: hoisted.resolve,
      dismiss: hoisted.dismiss,
    }),
  };
});

interface IApprovalOptionStub {
  id: string;
  label: string;
  shortcut?: string;
  tone?: 'default' | 'danger';
}

const buildPending = (overrides: {
  toolCallId?: string;
  options?: IApprovalOptionStub[];
  title?: string;
  summary?: string | null;
  impact?: string | null;
} = {}) => ({
  sessionId: 'session-1',
  toolCallId: overrides.toolCallId ?? 'tool-1',
  request: { sessionId: 'session-1', toolCallId: overrides.toolCallId ?? 'tool-1', options: [] },
  approval: {
    title: overrides.title ?? '是否允许此工具调用？',
    summary: overrides.summary ?? null,
    impact: overrides.impact ?? null,
    options: overrides.options ?? [
      { id: 'allow', label: '允许一次', shortcut: 'y' },
      { id: 'reject', label: '拒绝', shortcut: 'n', tone: 'danger' },
    ],
  },
});

describe('AcpApprovalOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.store.current = null;
    hoisted.resolve.mockResolvedValue(undefined);
  });

  it('无待决审批时不渲染浮层', () => {
    const wrapper = mount(AcpApprovalOverlay);
    expect(wrapper.find('.approval-prompt').exists()).toBe(false);
  });

  it('渲染队首审批的标题与选项', () => {
    hoisted.store.current = buildPending();
    const wrapper = mount(AcpApprovalOverlay);

    expect(wrapper.find('.approval-prompt__title').text()).toBe('是否允许此工具调用？');
    expect(wrapper.findAll('.approval-prompt__option')).toHaveLength(2);
  });

  it('点击选项逐字回投 optionId', async () => {
    hoisted.store.current = buildPending();
    const wrapper = mount(AcpApprovalOverlay);

    await wrapper.findAll('.approval-prompt__option')[0]?.trigger('click');
    expect(hoisted.resolve).toHaveBeenCalledWith('tool-1', 'allow');
  });

  it('Esc 在有拒绝类选项时明确回投拒绝', async () => {
    hoisted.store.current = buildPending();
    const wrapper = mount(AcpApprovalOverlay);

    await wrapper.find('.approval-prompt').trigger('keydown', { key: 'Escape' });
    expect(hoisted.resolve).toHaveBeenCalledWith('tool-1', 'reject');
    expect(hoisted.dismiss).not.toHaveBeenCalled();
  });

  it('Esc 在无拒绝类选项时仅本地消隐', async () => {
    hoisted.store.current = buildPending({ options: [{ id: 'ok', label: '好' }] });
    const wrapper = mount(AcpApprovalOverlay);

    await wrapper.find('.approval-prompt').trigger('keydown', { key: 'Escape' });
    expect(hoisted.dismiss).toHaveBeenCalledWith('tool-1');
    expect(hoisted.resolve).not.toHaveBeenCalled();
  });

  it('impact 有值时经 context 插槽呈现', () => {
    hoisted.store.current = buildPending({ impact: '将写入工作区文件' });
    const wrapper = mount(AcpApprovalOverlay);

    expect(wrapper.find('.acp-approval-overlay__impact').text()).toBe('将写入工作区文件');
  });
});
