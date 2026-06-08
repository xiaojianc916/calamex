import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { IAiToolConfirmationRequest } from '@/types/ai';

import RunStatusBar from './RunStatusBar.vue';

const buildConfirmation = (
  overrides: Partial<IAiToolConfirmationRequest> = {},
): IAiToolConfirmationRequest => ({
  id: 'conf-1',
  runId: 'run-1',
  stepId: 'step-1',
  toolName: 'auto_apply_patch',
  question: '是否允许写入文件？',
  summary: '将修改 2 个文件',
  riskLevel: 'medium',
  impact: '编辑 src/a.ts、src/b.ts',
  reversible: true,
  createdAt: '2026-06-08T00:00:00.000Z',
  options: [
    { id: 'allow-once', label: '允许', tone: 'primary' },
    { id: 'view-details', label: '了解更多', tone: 'secondary' },
    { id: 'stop', label: '停止', tone: 'danger' },
  ],
  ...overrides,
});

describe('RunStatusBar', () => {
  it('renders header, elapsed, progress and detail while running', () => {
    const wrapper = mount(RunStatusBar, {
      props: {
        phase: 'running',
        header: '执行中',
        elapsedSeconds: 65,
        progress: { done: 1, total: 3 },
        detail: '正在编辑 src/app.ts',
      },
    });

    expect(wrapper.text()).toContain('执行中');
    expect(wrapper.text()).toContain('1m 05s');
    expect(wrapper.text()).toContain('1/3');
    expect(wrapper.text()).toContain('正在编辑 src/app.ts');
  });

  it('emits pause and cancel while running', async () => {
    const wrapper = mount(RunStatusBar, {
      props: { phase: 'running', header: '执行中', canPause: true, canCancel: true },
    });

    await wrapper.get('button[aria-label="暂停"]').trigger('click');
    await wrapper.get('button[aria-label="取消"]').trigger('click');

    expect(wrapper.emitted('pause')).toHaveLength(1);
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('emits resume when paused', async () => {
    const wrapper = mount(RunStatusBar, {
      props: { phase: 'paused', header: '已暂停', canResume: true },
    });

    await wrapper.get('button[aria-label="继续"]').trigger('click');

    expect(wrapper.emitted('resume')).toHaveLength(1);
  });

  it('等待确认时呈现 Codex 风格审批列表并回传决定', async () => {
    const wrapper = mount(RunStatusBar, {
      props: {
        phase: 'awaiting-confirmation',
        header: '等待确认',
        confirmation: buildConfirmation(),
      },
    });

    expect(wrapper.text()).toContain('是否允许写入文件？');
    expect(wrapper.text()).toContain('将修改 2 个文件');

    const options = wrapper.findAll('.approval-prompt__option');
    const labels = options.map((option) => option.text());
    expect(labels.some((text) => text.includes('允许'))).toBe(true);
    expect(labels.some((text) => text.includes('停止'))).toBe(true);
    expect(labels.some((text) => text.includes('了解更多'))).toBe(false);

    const allowOption = options.find((option) => option.text().includes('允许'));
    await allowOption?.trigger('click');

    expect(wrapper.emitted('resolve')?.[0]).toEqual(['allow-once']);
  });

  it('在审批列表上按 Esc 等价于停止', async () => {
    const wrapper = mount(RunStatusBar, {
      props: {
        phase: 'awaiting-confirmation',
        header: '等待确认',
        confirmation: buildConfirmation(),
      },
    });

    await wrapper.find('.approval-prompt').trigger('keydown', { key: 'Escape' });

    expect(wrapper.emitted('resolve')?.[0]).toEqual(['stop']);
  });

  it('hides run controls while awaiting confirmation', () => {
    const wrapper = mount(RunStatusBar, {
      props: {
        phase: 'awaiting-confirmation',
        header: '等待确认',
        confirmation: buildConfirmation({
          options: [{ id: 'stop', label: '停止', tone: 'danger' }],
        }),
        canPause: true,
        canCancel: true,
      },
    });

    expect(wrapper.find('button[aria-label="暂停"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="取消"]').exists()).toBe(false);
  });
});
