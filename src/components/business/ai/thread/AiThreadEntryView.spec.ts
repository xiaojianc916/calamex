import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AiThreadAssistantText from './AiThreadAssistantText.vue';
import AiThreadChangedFilesSummary from './AiThreadChangedFilesSummary.vue';
import AiThreadContextCompaction from './AiThreadContextCompaction.vue';
import AiThreadEntryView from './AiThreadEntryView.vue';
import AiThreadPlanControl from './AiThreadPlanControl.vue';
import AiThreadReasoning from './AiThreadReasoning.vue';
import AiThreadToolCall from './AiThreadToolCall.vue';
import AiThreadUserMessage from './AiThreadUserMessage.vue';
import type {
  IAiThreadAssistantTextEntry,
  IAiThreadChangedFilesSummaryEntry,
  IAiThreadContextCompactionEntry,
  IAiThreadPlanControlEntry,
  IAiThreadReasoningEntry,
  IAiThreadToolCallEntry,
  IAiThreadUserMessageEntry,
} from './projection';

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
  toolCall: {
    type: 'tool_call',
    id: 't1',
    createdAt: '2026-04-28T10:00:00.000Z',
    title: '读取文件',
    kind: 'read',
    status: 'completed',
    content: [],
  },
  terminals: {},
  awaiting: false,
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

describe('AiThreadEntryView', () => {
  it('按条目类型分派到对应渲染组件', () => {
    expect(
      mount(AiThreadEntryView, { props: { entry: userEntry }, global: { stubs } })
        .findComponent(AiThreadUserMessage)
        .exists(),
    ).toBe(true);
    expect(
      mount(AiThreadEntryView, { props: { entry: assistantEntry }, global: { stubs } })
        .findComponent(AiThreadAssistantText)
        .exists(),
    ).toBe(true);
    expect(
      mount(AiThreadEntryView, { props: { entry: reasoningEntry }, global: { stubs } })
        .findComponent(AiThreadReasoning)
        .exists(),
    ).toBe(true);
    expect(
      mount(AiThreadEntryView, { props: { entry: toolEntry }, global: { stubs } })
        .findComponent(AiThreadToolCall)
        .exists(),
    ).toBe(true);
    expect(
      mount(AiThreadEntryView, { props: { entry: planEntry }, global: { stubs } })
        .findComponent(AiThreadPlanControl)
        .exists(),
    ).toBe(true);
    expect(
      mount(AiThreadEntryView, { props: { entry: compactionEntry }, global: { stubs } })
        .findComponent(AiThreadContextCompaction)
        .exists(),
    ).toBe(true);
    expect(
      mount(AiThreadEntryView, { props: { entry: summaryEntry }, global: { stubs } })
        .findComponent(AiThreadChangedFilesSummary)
        .exists(),
    ).toBe(true);
  });

  it('透传受控 open 给工具调用并向上冒泡 update:open', () => {
    const wrapper = mount(AiThreadEntryView, {
      props: { entry: toolEntry, open: true },
      global: { stubs },
    });
    const tool = wrapper.findComponent(AiThreadToolCall);

    expect(tool.props('open')).toBe(true);
    tool.vm.$emit('update:open', false);

    expect(wrapper.emitted('update:open')?.[0]).toEqual([false]);
  });

  it('改动汇总的撤销 / 钉住事件带 messageId 冒泡', () => {
    const wrapper = mount(AiThreadEntryView, { props: { entry: summaryEntry }, global: { stubs } });
    const summary = wrapper.findComponent(AiThreadChangedFilesSummary);

    summary.vm.$emit('undo', 'm4', 'sum1');
    summary.vm.$emit('pin', 'm4', 'sum1', true);

    expect(wrapper.emitted('changedFilesRollback')?.[0]).toEqual(['m4', 'sum1']);
    expect(wrapper.emitted('changedFilesPin')?.[0]).toEqual(['m4', 'sum1', true]);
  });

  it('Plan 控制条目的审批 / 编辑事件冒泡', () => {
    const wrapper = mount(AiThreadEntryView, { props: { entry: planEntry }, global: { stubs } });
    const plan = wrapper.findComponent(AiThreadPlanControl);

    plan.vm.$emit('approve');
    plan.vm.$emit('updateStepTitle', 'step-1', '新标题');
    plan.vm.$emit('removeStep', 'step-2');

    expect(wrapper.emitted('planApprove')).toHaveLength(1);
    expect(wrapper.emitted('planUpdateStepTitle')?.[0]).toEqual(['step-1', '新标题']);
    expect(wrapper.emitted('planRemoveStep')?.[0]).toEqual(['step-2']);
  });

  it('仅助手条目注入 onelight 作用域,用户回复后留出间距', () => {
    const assistant = mount(AiThreadEntryView, {
      props: { entry: assistantEntry, afterUser: true },
      global: { stubs },
    });
    expect(assistant.classes()).toContain('ai-thread-onelight');
    expect(assistant.classes()).toContain('ai-thread-entry--after-user');

    const user = mount(AiThreadEntryView, { props: { entry: userEntry }, global: { stubs } });
    expect(user.classes()).not.toContain('ai-thread-onelight');
  });
});
