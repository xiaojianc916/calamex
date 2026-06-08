import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type {
  IAiThreadAssistantTextEntry,
  IAiThreadChangedFilesSummaryEntry,
  IAiThreadContextCompactionEntry,
  IAiThreadPlanControlEntry,
  IAiThreadReasoningEntry,
  IAiThreadToolCallEntry,
  IAiThreadUserMessageEntry,
  TAiThreadEntry,
} from './projection';

const { buildThreadEntriesMock } = vi.hoisted(() => ({ buildThreadEntriesMock: vi.fn() }));

vi.mock('./projection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projection')>();

  return { ...actual, buildThreadEntries: buildThreadEntriesMock };
});

import AiThreadChangedFilesSummary from './AiThreadChangedFilesSummary.vue';
import AiThreadContextCompaction from './AiThreadContextCompaction.vue';
import AiThreadPlanControl from './AiThreadPlanControl.vue';
import AiThreadReasoning from './AiThreadReasoning.vue';
import AiThreadTimeline from './AiThreadTimeline.vue';
import AiThreadToolCall from './AiThreadToolCall.vue';
import AiThreadUserMessage from './AiThreadUserMessage.vue';

const userEntry: IAiThreadUserMessageEntry = {
  kind: 'user-message',
  id: 'u1',
  messageId: 'm1',
  markdown: 'hello',
  references: [],
};
const assistantEntry: IAiThreadAssistantTextEntry = {
  kind: 'assistant-text',
  id: 'a1',
  messageId: 'm1',
  markdown: 'hi',
  streaming: false,
};
const reasoningEntry: IAiThreadReasoningEntry = {
  kind: 'reasoning',
  id: 'r1',
  messageId: 'm1',
  segments: ['x'],
  isLong: false,
  streaming: false,
};
const toolEntry: IAiThreadToolCallEntry = {
  kind: 'tool-call',
  id: 't1',
  messageId: 'm1',
  icon: 'file',
  title: '读取文件',
  tags: ['src/a.ts'],
  status: 'succeeded',
  content: [{ type: 'text', id: 'c1', markdown: 'done' }],
};
const planEntry: IAiThreadPlanControlEntry = {
  kind: 'plan-control',
  id: 'p1',
  messageId: 'm2',
  goal: '目标',
  references: [],
  phase: 'awaiting-approval',
};
const compactionEntry: IAiThreadContextCompactionEntry = {
  kind: 'context-compaction',
  id: 'cc1',
  messageId: 'm3',
  text: '整理上下文',
};
const summaryEntry: IAiThreadChangedFilesSummaryEntry = {
  kind: 'changed-files-summary',
  id: 's1',
  messageId: 'm4',
  summary: {
    id: 'sum1',
    runId: 'run1',
    stepId: 'step1',
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
    patchRef: 'ref1',
  },
};

const allEntries: TAiThreadEntry[] = [
  userEntry,
  assistantEntry,
  reasoningEntry,
  toolEntry,
  planEntry,
  compactionEntry,
  summaryEntry,
];

const stubs = {
  AiMarkdown: true,
  AiChangedFilesSummary: true,
  AiPlanConfirmationMessage: true,
  Terminal: true,
  TerminalHeader: true,
  TerminalTitle: true,
  TerminalContent: true,
  ImageAttachmentPreviewGrid: true,
  CodeBlock: true,
};

const mountTimeline = () => mount(AiThreadTimeline, { props: { messages: [] }, global: { stubs } });

describe('AiThreadTimeline', () => {
  beforeEach(() => {
    buildThreadEntriesMock.mockReset();
    buildThreadEntriesMock.mockReturnValue(allEntries);
  });

  it('按条目类型分派渲染每一种条目组件', () => {
    const wrapper = mountTimeline();

    expect(wrapper.findComponent(AiThreadUserMessage).exists()).toBe(true);
    expect(wrapper.findComponent(AiThreadReasoning).exists()).toBe(true);
    expect(wrapper.findComponent(AiThreadToolCall).exists()).toBe(true);
    expect(wrapper.findComponent(AiThreadPlanControl).exists()).toBe(true);
    expect(wrapper.findComponent(AiThreadContextCompaction).exists()).toBe(true);
    expect(wrapper.findComponent(AiThreadChangedFilesSummary).exists()).toBe(true);
  });

  it('工具调用默认折叠，受控展开后回写 open', async () => {
    const wrapper = mountTimeline();
    const tool = wrapper.findComponent(AiThreadToolCall);

    expect(tool.props('open')).toBe(false);
    tool.vm.$emit('update:open', true);
    await nextTick();
    expect(wrapper.findComponent(AiThreadToolCall).props('open')).toBe(true);
  });

  it('推理条目可受控展开', async () => {
    const wrapper = mountTimeline();
    const reasoning = wrapper.findComponent(AiThreadReasoning);

    expect(reasoning.props('open')).toBe(false);
    reasoning.vm.$emit('update:open', true);
    await nextTick();
    expect(wrapper.findComponent(AiThreadReasoning).props('open')).toBe(true);
  });

  it('改动汇总的撤销 / 钉住事件带 messageId 冒泡', () => {
    const wrapper = mountTimeline();
    const summary = wrapper.findComponent(AiThreadChangedFilesSummary);

    summary.vm.$emit('undo', 'm4', 'sum1');
    summary.vm.$emit('pin', 'm4', 'sum1', true);

    expect(wrapper.emitted('changedFilesRollback')?.[0]).toEqual(['m4', 'sum1']);
    expect(wrapper.emitted('changedFilesPin')?.[0]).toEqual(['m4', 'sum1', true]);
  });

  it('Plan 控制条目的审批事件冒泡到时间线', () => {
    const wrapper = mountTimeline();
    const plan = wrapper.findComponent(AiThreadPlanControl);

    plan.vm.$emit('approve');
    plan.vm.$emit('updateStepTitle', 'step-1', '新标题');

    expect(wrapper.emitted('planApprove')).toHaveLength(1);
    expect(wrapper.emitted('planUpdateStepTitle')?.[0]).toEqual(['step-1', '新标题']);
  });
});
