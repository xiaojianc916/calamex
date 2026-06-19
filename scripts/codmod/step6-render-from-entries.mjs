// scripts/codemod/step6-render-from-entries.mjs
// Step 6 渲染路径切换(策略 A:逐 entry 虚拟化 + 抽共享 AiThreadEntryView)
// 用法: node scripts/codemod/step6-render-from-entries.mjs   (在仓库根目录执行)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const REPO_ROOT = process.cwd();
const abs = (p) => resolve(REPO_ROOT, p);
const toLf = (t) => t.replace(/\r\n/g, '\n');
const detectEol = (t) => (/\r\n/.test(t) ? '\r\n' : '\n');
const fromLf = (t, eol) => (eol === '\r\n' ? t.replace(/\n/g, '\r\n') : t);

const reads = new Map();
const loadFile = (p) => {
  if (!reads.has(p)) {
    const raw = readFileSync(abs(p), 'utf8');
    reads.set(p, { lf: toLf(raw), eol: detectEol(raw) });
  }
  return reads.get(p);
};

const replaceOnce = (hayLf, anchorLf, replLf, label) => {
  const parts = hayLf.split(anchorLf);
  const hits = parts.length - 1;
  if (hits !== 1) {
    throw new Error(
      `[step6] 锚点命中 ${hits} 次 (期望 1): ${label}\n--- anchor ---\n${anchorLf}\n--------------`,
    );
  }
  return parts.join(replLf);
};

const writes = [];
const planEdit = (p, ops) => {
  const f = loadFile(p);
  let cur = f.lf;
  for (const op of ops) cur = replaceOnce(cur, toLf(op.from), toLf(op.to), `${p} :: ${op.label}`);
  writes.push({ path: p, lf: cur, eol: f.eol });
};
const planRewrite = (p, contentLf) => {
  const f = loadFile(p);
  writes.push({ path: p, lf: toLf(contentLf), eol: f.eol });
};
const planCreate = (p, contentLf) => {
  if (existsSync(abs(p))) throw new Error(`[step6] 目标已存在,拒绝覆盖: ${p}`);
  writes.push({ path: p, lf: toLf(contentLf), eol: '\n', create: true });
};

// ════════════════════════════════════════════════════════════════════════════
// 1) 新建共享逐条目渲染组件 AiThreadEntryView.vue
// ════════════════════════════════════════════════════════════════════════════
planCreate(
  'src/components/business/ai/thread/AiThreadEntryView.vue',
  `<script setup lang="ts">
import type { IAiPatchSet } from '@/types/ai';
import AiThreadAssistantText from './AiThreadAssistantText.vue';
import AiThreadChangedFilesSummary from './AiThreadChangedFilesSummary.vue';
import AiThreadContextCompaction from './AiThreadContextCompaction.vue';
import AiThreadPlanControl from './AiThreadPlanControl.vue';
import AiThreadReasoning from './AiThreadReasoning.vue';
import AiThreadToolCall from './AiThreadToolCall.vue';
import AiThreadUserMessage from './AiThreadUserMessage.vue';
import type { TAiThreadEntry } from './projection';
import type { IAiThreadPlanDetails } from './types';

// 单条平铺时间线条目的渲染分派。三处调用方(AiThreadTimeline / AiThreadSingleMessageTimeline /
// AiChatThread 的逐 entry 虚拟化路径)共用本组件;按 kind 差异化的 patches / workspace 透传
// 经独立 props 承载,以保持各调用方既有行为不变。
withDefaults(
  defineProps<{
    entry: TAiThreadEntry;
    open?: boolean;
    afterUser?: boolean;
    planDetails?: IAiThreadPlanDetails;
    workspaceRootPath?: string | null;
    summaryPatches?: readonly IAiPatchSet[];
    toolCallPatches?: readonly IAiPatchSet[];
    toolCallWorkspaceRootPath?: string | null;
    revertingChangedFilesSummaryId?: string | null;
    pinningChangedFilesSummaryId?: string | null;
  }>(),
  {
    open: false,
    afterUser: false,
    planDetails: undefined,
    workspaceRootPath: null,
    summaryPatches: undefined,
    toolCallPatches: undefined,
    toolCallWorkspaceRootPath: null,
    revertingChangedFilesSummaryId: null,
    pinningChangedFilesSummaryId: null,
  },
);

const emit = defineEmits<{
  'update:open': [open: boolean];
  changedFilesRollback: [messageId: string, summaryId: string];
  changedFilesPin: [messageId: string, summaryId: string, pinned: boolean];
  planApprove: [];
  planReject: [];
  planRegenerate: [];
  planUpdateStepTitle: [stepId: string, title: string];
  planRemoveStep: [stepId: string];
}>();

// 仅 AI 助手发送的条目(正文 / 推理 / 工具调用)注入 Zed One Light 调色板,经由
// ai-thread-onelight 作用域类局部覆盖 design token;用户消息与其它面板不受影响。
const ASSISTANT_MESSAGE_KINDS: ReadonlySet<TAiThreadEntry['kind']> = new Set([
  'assistant-text',
  'reasoning',
  'tool-call',
]);
</script>

<template>
  <div
    class="ai-thread-entry"
    :class="{
      'ai-thread-entry--after-user': afterUser,
      'ai-thread-onelight': ASSISTANT_MESSAGE_KINDS.has(entry.kind),
    }"
  >
    <AiThreadUserMessage v-if="entry.kind === 'user-message'" :entry="entry" />

    <AiThreadAssistantText v-else-if="entry.kind === 'assistant-text'" :entry="entry" />

    <AiThreadReasoning
      v-else-if="entry.kind === 'reasoning'"
      :entry="entry"
      :open="open"
      @update:open="emit('update:open', $event)"
    />

    <AiThreadToolCall
      v-else-if="entry.kind === 'tool-call'"
      :entry="entry"
      :open="open"
      :patches="toolCallPatches"
      :workspace-root-path="toolCallWorkspaceRootPath"
      @update:open="emit('update:open', $event)"
    />

    <AiThreadPlanControl
      v-else-if="entry.kind === 'plan-control'"
      :entry="entry"
      :details="planDetails"
      @approve="emit('planApprove')"
      @reject="emit('planReject')"
      @regenerate="emit('planRegenerate')"
      @update-step-title="
        (stepId: string, title: string) => emit('planUpdateStepTitle', stepId, title)
      "
      @remove-step="emit('planRemoveStep', $event)"
    />

    <AiThreadContextCompaction v-else-if="entry.kind === 'context-compaction'" :entry="entry" />

    <AiThreadChangedFilesSummary
      v-else-if="entry.kind === 'changed-files-summary'"
      :entry="entry"
      :patches="summaryPatches ?? []"
      :workspace-root-path="workspaceRootPath"
      :is-reverting="revertingChangedFilesSummaryId === entry.summary.id"
      :is-pinning="pinningChangedFilesSummaryId === entry.summary.id"
      @undo="
        (messageId: string, summaryId: string) =>
          emit('changedFilesRollback', messageId, summaryId)
      "
      @pin="
        (messageId: string, summaryId: string, pinned: boolean) =>
          emit('changedFilesPin', messageId, summaryId, pinned)
      "
    />
  </div>
</template>

<style scoped>
.ai-thread-entry {
  min-width: 0;
  max-width: 100%;
}

.ai-thread-entry--after-user {
  margin-top: 8px;
}
</style>
`,
);

// ════════════════════════════════════════════════════════════════════════════
// 2) AiThreadEntryView 单元 spec
// ════════════════════════════════════════════════════════════════════════════
planCreate(
  'src/components/business/ai/thread/AiThreadEntryView.spec.ts',
  `import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type {
  IAiThreadAssistantTextEntry,
  IAiThreadChangedFilesSummaryEntry,
  IAiThreadContextCompactionEntry,
  IAiThreadPlanControlEntry,
  IAiThreadReasoningEntry,
  IAiThreadToolCallEntry,
  IAiThreadUserMessageEntry,
} from './projection';
import AiThreadAssistantText from './AiThreadAssistantText.vue';
import AiThreadChangedFilesSummary from './AiThreadChangedFilesSummary.vue';
import AiThreadContextCompaction from './AiThreadContextCompaction.vue';
import AiThreadEntryView from './AiThreadEntryView.vue';
import AiThreadPlanControl from './AiThreadPlanControl.vue';
import AiThreadReasoning from './AiThreadReasoning.vue';
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
`,
);

// ════════════════════════════════════════════════════════════════════════════
// 3) 重写 AiThreadTimeline.vue:逐 kind 渲染下沉到 AiThreadEntryView
// ════════════════════════════════════════════════════════════════════════════
planRewrite(
  'src/components/business/ai/thread/AiThreadTimeline.vue',
  `<script setup lang="ts">
import { computed } from 'vue';
import type { IAiChatMessage, IAiPatchSet } from '@/types/ai';
import type { IAiThreadEntry } from '@/types/ai/thread';
import AiThreadEntryView from './AiThreadEntryView.vue';
import { buildThreadEntries, type TAiThreadEntry, threadEntriesToTimeline } from './projection';
import type { IAiThreadPlanDetails } from './types';
import { useThreadEntryExpansion } from './useThreadEntryExpansion';

const props = defineProps<{
  messages: readonly IAiChatMessage[];
  workspaceRootPath?: string | null;
  planDetails?: IAiThreadPlanDetails;
  revertingChangedFilesSummaryId?: string | null;
  pinningChangedFilesSummaryId?: string | null;
  renderFromEntries?: boolean;
  threadEntries?: readonly IAiThreadEntry[];
}>();

const emit = defineEmits<{
  changedFilesRollback: [messageId: string, summaryId: string];
  changedFilesPin: [messageId: string, summaryId: string, pinned: boolean];
  planApprove: [];
  planReject: [];
  planRegenerate: [];
  planUpdateStepTitle: [stepId: string, title: string];
  planRemoveStep: [stepId: string];
}>();

const entries = computed<TAiThreadEntry[]>(() =>
  props.renderFromEntries
    ? threadEntriesToTimeline(props.threadEntries ?? [])
    : buildThreadEntries(props.messages),
);

const expansion = useThreadEntryExpansion(entries);

const messagesById = computed(() => {
  const map = new Map<string, IAiChatMessage>();

  for (const message of props.messages) {
    map.set(message.id, message);
  }

  return map;
});

// 每条来源消息的“最后一个条目”id 集合;平铺渲染时据此在消息边界注入逐消息附加内容
// (如对话检查点),与 Zed acp_thread 把检查点挂在消息末尾的做法一致,而不破坏单一线性时间线。
const lastEntryIdByMessage = computed(() => {
  const lastById = new Map<string, string>();

  for (const entry of entries.value) {
    lastById.set(entry.messageId, entry.id);
  }

  return new Set(lastById.values());
});

const isMessageBoundary = (entry: TAiThreadEntry): boolean =>
  lastEntryIdByMessage.value.has(entry.id);

const patchesFor = (messageId: string): readonly IAiPatchSet[] =>
  messagesById.value.get(messageId)?.patches ?? [];

const shouldAddUserReplyGap = (entry: TAiThreadEntry, index: number): boolean => {
  const previousEntry = entries.value[index - 1];

  return previousEntry?.kind === 'user-message' && entry.kind !== 'user-message';
};
</script>

<template>
  <div class="ai-thread-timeline">
    <template v-for="(entry, index) in entries" :key="entry.id">
      <AiThreadEntryView
        :entry="entry"
        :open="expansion.isExpanded(entry)"
        :after-user="shouldAddUserReplyGap(entry, index)"
        :plan-details="planDetails"
        :workspace-root-path="workspaceRootPath"
        :summary-patches="patchesFor(entry.messageId)"
        :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
        :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
        @update:open="expansion.setExpanded(entry, $event)"
        @changed-files-rollback="
          (messageId: string, summaryId: string) =>
            emit('changedFilesRollback', messageId, summaryId)
        "
        @changed-files-pin="
          (messageId: string, summaryId: string, pinned: boolean) =>
            emit('changedFilesPin', messageId, summaryId, pinned)
        "
        @plan-approve="emit('planApprove')"
        @plan-reject="emit('planReject')"
        @plan-regenerate="emit('planRegenerate')"
        @plan-update-step-title="
          (stepId: string, title: string) => emit('planUpdateStepTitle', stepId, title)
        "
        @plan-remove-step="emit('planRemoveStep', $event)"
      />
      <slot
        v-if="isMessageBoundary(entry) && messagesById.get(entry.messageId)"
        name="after-message"
        :message="messagesById.get(entry.messageId)"
      />
    </template>
  </div>
</template>

<style scoped>
.ai-thread-timeline {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  min-width: 0;
}
</style>
`,
);

// ════════════════════════════════════════════════════════════════════════════
// 4) 重写 AiThreadSingleMessageTimeline.vue(tool-call 仍带 patches+workspace)
// ════════════════════════════════════════════════════════════════════════════
planRewrite(
  'src/components/business/ai/chat/AiThreadSingleMessageTimeline.vue',
  `<script setup lang="ts">
import { computed } from 'vue';
import AiThreadEntryView from '@/components/business/ai/thread/AiThreadEntryView.vue';
import {
  buildSingleMessageThreadEntries,
  type TAiThreadEntry,
} from '@/components/business/ai/thread/projection';
import type { IAiThreadPlanDetails } from '@/components/business/ai/thread/types';
import { useThreadEntryExpansion } from '@/components/business/ai/thread/useThreadEntryExpansion';
import type { IAiChatMessage, IAiPatchSet } from '@/types/ai';

const props = defineProps<{
  message: IAiChatMessage;
  workspaceRootPath?: string | null;
  planDetails?: IAiThreadPlanDetails;
  revertingChangedFilesSummaryId?: string | null;
  pinningChangedFilesSummaryId?: string | null;
}>();

const emit = defineEmits<{
  changedFilesRollback: [messageId: string, summaryId: string];
  changedFilesPin: [messageId: string, summaryId: string, pinned: boolean];
  planApprove: [];
  planReject: [];
  planRegenerate: [];
  planUpdateStepTitle: [stepId: string, title: string];
  planRemoveStep: [stepId: string];
}>();

const entries = computed<TAiThreadEntry[]>(() => buildSingleMessageThreadEntries(props.message));

const expansion = useThreadEntryExpansion(entries);

const lastEntryId = computed(() => entries.value.at(-1)?.id ?? null);

const isMessageBoundary = (entry: TAiThreadEntry): boolean => entry.id === lastEntryId.value;

const patchesForMessage = computed<readonly IAiPatchSet[]>(() => props.message.patches ?? []);

const shouldAddUserReplyGap = (entry: TAiThreadEntry, index: number): boolean => {
  const previousEntry = entries.value[index - 1];

  return previousEntry?.kind === 'user-message' && entry.kind !== 'user-message';
};

const handlePlanUpdateStepTitle = (stepId: string, title: string): void => {
  emit('planUpdateStepTitle', stepId, title);
};

const handlePlanRemoveStep = (stepId: string): void => {
  emit('planRemoveStep', stepId);
};

const handleChangedFilesRollback = (messageId: string, summaryId: string): void => {
  emit('changedFilesRollback', messageId, summaryId);
};

const handleChangedFilesPin = (messageId: string, summaryId: string, pinned: boolean): void => {
  emit('changedFilesPin', messageId, summaryId, pinned);
};
</script>

<template>
  <div class="ai-thread-single-message">
    <template v-for="(entry, index) in entries" :key="entry.id">
      <AiThreadEntryView
        :entry="entry"
        :open="expansion.isExpanded(entry)"
        :after-user="shouldAddUserReplyGap(entry, index)"
        :plan-details="planDetails"
        :workspace-root-path="workspaceRootPath"
        :summary-patches="patchesForMessage"
        :tool-call-patches="patchesForMessage"
        :tool-call-workspace-root-path="workspaceRootPath"
        :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
        :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
        @update:open="expansion.setExpanded(entry, $event)"
        @changed-files-rollback="handleChangedFilesRollback"
        @changed-files-pin="handleChangedFilesPin"
        @plan-approve="emit('planApprove')"
        @plan-reject="emit('planReject')"
        @plan-regenerate="emit('planRegenerate')"
        @plan-update-step-title="handlePlanUpdateStepTitle"
        @plan-remove-step="handlePlanRemoveStep"
      />

      <slot v-if="isMessageBoundary(entry)" name="after-message" :message="message" />
    </template>
  </div>
</template>

<style scoped>
.ai-thread-single-message {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}
</style>
`,
);

// ════════════════════════════════════════════════════════════════════════════
// 5) 外科手术式修改 AiChatThread.vue(E1~E11)
// ════════════════════════════════════════════════════════════════════════════
planEdit('src/components/business/ai/chat/AiChatThread.vue', [
  {
    label: 'E1a 引入 EntryView / projection / expansion',
    from: `import type { IAiThreadPlanDetails } from '@/components/business/ai/thread/types';
import type { TAiServicePlatformId } from '@/constants/ai/providers';`,
    to: `import AiThreadEntryView from '@/components/business/ai/thread/AiThreadEntryView.vue';
import {
  type TAiThreadEntry,
  threadEntriesToTimeline,
} from '@/components/business/ai/thread/projection';
import type { IAiThreadPlanDetails } from '@/components/business/ai/thread/types';
import { useThreadEntryExpansion } from '@/components/business/ai/thread/useThreadEntryExpansion';
import type { TAiServicePlatformId } from '@/constants/ai/providers';`,
  },
  {
    label: 'E1b 引入 IAiThreadEntry 数据模型类型',
    from: `import type { IAiChatMessage } from '@/types/ai';
import AiThinkingStatus from './AiThinkingStatus.vue';`,
    to: `import type { IAiChatMessage } from '@/types/ai';
import type { IAiThreadEntry } from '@/types/ai/thread';
import AiThinkingStatus from './AiThinkingStatus.vue';`,
  },
  {
    label: 'E2 TAiThreadVirtualItem 增加 entry 变体',
    from: `type TAiThreadVirtualItem =
  | {
      type: 'message';
      id: string;
      message: IAiChatMessage;
    }
  | {
      type: 'typing';
      id: string;
    };`,
    to: `type TAiThreadVirtualItem =
  | {
      type: 'message';
      id: string;
      message: IAiChatMessage;
    }
  | {
      type: 'entry';
      id: string;
      entry: TAiThreadEntry;
    }
  | {
      type: 'typing';
      id: string;
    };`,
  },
  {
    label: 'E3 新增 props 声明',
    from: `    revertingChangedFilesSummaryId?: string | null;
    pinningChangedFilesSummaryId?: string | null;
  }>(),`,
    to: `    revertingChangedFilesSummaryId?: string | null;
    pinningChangedFilesSummaryId?: string | null;
    renderFromEntries?: boolean;
    threadEntries?: readonly IAiThreadEntry[];
    streamingMessageId?: string | null;
  }>(),`,
  },
  {
    label: 'E4 新增 props 默认值',
    from: `    revertingChangedFilesSummaryId: null,
    pinningChangedFilesSummaryId: null,
  },
);`,
    to: `    revertingChangedFilesSummaryId: null,
    pinningChangedFilesSummaryId: null,
    renderFromEntries: false,
    threadEntries: () => [],
    streamingMessageId: null,
  },
);`,
  },
  {
    label: 'E5 entryTimeline / entryExpansion / standalone typing',
    from: `const shouldRenderStandaloneTyping = computed(
  () => props.isTyping && !hasInlineProgressMessage.value,
);`,
    to: `const entryTimeline = computed<TAiThreadEntry[]>(() =>
  threadEntriesToTimeline(props.threadEntries ?? [], {
    streamingMessageId: props.streamingMessageId,
  }),
);

const entryExpansion = useThreadEntryExpansion(entryTimeline);

const hasInlineProgressEntry = computed(() => {
  const lastEntry = entryTimeline.value.at(-1);

  if (!lastEntry) {
    return false;
  }

  return (
    (lastEntry.kind === 'assistant-text' && lastEntry.streaming) ||
    (lastEntry.kind === 'reasoning' && lastEntry.streaming)
  );
});

const shouldRenderStandaloneTyping = computed(() => {
  if (!props.isTyping) {
    return false;
  }

  return props.renderFromEntries
    ? !hasInlineProgressEntry.value
    : !hasInlineProgressMessage.value;
});`,
  },
  {
    label: 'E6 空态判定兼容 entries 路径',
    from: `const shouldRenderEmptyState = computed(
  () =>
    visibleMessages.value.length === 0 &&
    !props.hasExtraContent &&
    !shouldRenderStandaloneTyping.value,
);`,
    to: `const isThreadEmpty = computed(() =>
  props.renderFromEntries
    ? entryTimeline.value.length === 0
    : visibleMessages.value.length === 0,
);

const shouldRenderEmptyState = computed(
  () => isThreadEmpty.value && !props.hasExtraContent && !shouldRenderStandaloneTyping.value,
);`,
  },
  {
    label: 'E7 virtualItems 兼容 entries 路径',
    from: `const virtualItems = computed<TAiThreadVirtualItem[]>(() => {
  const items: TAiThreadVirtualItem[] = visibleMessages.value.map((message) => ({
    type: 'message',
    id: message.id,
    message,
  }));

  if (shouldRenderStandaloneTyping.value) {
    items.push({
      type: 'typing',
      id: \`typing:\${props.conversationId ?? 'active'}\`,
    });
  }

  return items;
});`,
    to: `const virtualItems = computed<TAiThreadVirtualItem[]>(() => {
  const items: TAiThreadVirtualItem[] = props.renderFromEntries
    ? entryTimeline.value.map((entry) => ({
        type: 'entry' as const,
        id: entry.id,
        entry,
      }))
    : visibleMessages.value.map((message) => ({
        type: 'message' as const,
        id: message.id,
        message,
      }));

  if (shouldRenderStandaloneTyping.value) {
    items.push({
      type: 'typing',
      id: \`typing:\${props.conversationId ?? 'active'}\`,
    });
  }

  return items;
});`,
  },
  {
    label: 'E8 追加逐 entry 尺寸依赖缓存',
    from: `  trimMessageSizeDependencyCache(message.id);
  messageSizeDependencyCache.set(message.id, { signature, dependencies });
  return dependencies;
};`,
    to: `  trimMessageSizeDependencyCache(message.id);
  messageSizeDependencyCache.set(message.id, { signature, dependencies });
  return dependencies;
};

const entrySizeDependencyCache = new Map<string, TMessageSizeDependencyCacheEntry>();

const trimEntrySizeDependencyCache = (currentEntryId: string): void => {
  if (
    entrySizeDependencyCache.size < MESSAGE_SIZE_DEPENDENCY_CACHE_LIMIT ||
    entrySizeDependencyCache.has(currentEntryId)
  ) {
    return;
  }

  const firstKey = entrySizeDependencyCache.keys().next().value;
  if (typeof firstKey === 'string') {
    entrySizeDependencyCache.delete(firstKey);
  }
};

const buildEntrySizeSignature = (entry: TAiThreadEntry): string => {
  switch (entry.kind) {
    case 'user-message':
      return ['user-message', entry.markdown.length, entry.references.length].join(':');
    case 'assistant-text':
      return ['assistant-text', entry.markdown.length, entry.streaming ? 1 : 0].join(':');
    case 'reasoning':
      return [
        'reasoning',
        entry.segments.length,
        entry.segments.reduce((total, segment) => total + segment.length, 0),
        entry.isLong ? 1 : 0,
        entry.streaming ? 1 : 0,
        entryExpansion.isExpanded(entry) ? 1 : 0,
      ].join(':');
    case 'tool-call':
      return [
        'tool-call',
        entry.toolCall.status,
        entry.awaiting ? 1 : 0,
        Object.keys(entry.terminals).length,
        entryExpansion.isExpanded(entry) ? 1 : 0,
      ].join(':');
    case 'plan-control':
      return ['plan-control', entry.phase, entry.goal.length, planSizeSignature.value].join(':');
    case 'context-compaction':
      return ['context-compaction', entry.text.length].join(':');
    case 'changed-files-summary':
      return [
        'changed-files-summary',
        entry.summary.id,
        entry.summary.files.length,
        entry.summary.totalAdditions,
        entry.summary.totalDeletions,
        props.revertingChangedFilesSummaryId === entry.summary.id ? 1 : 0,
        props.pinningChangedFilesSummaryId === entry.summary.id ? 1 : 0,
      ].join(':');
    default: {
      const exhaustive: never = entry;
      return String(exhaustive);
    }
  }
};

const getEntrySizeDependencies = (entry: TAiThreadEntry): unknown[] => {
  const signature = buildEntrySizeSignature(entry);
  const cached = entrySizeDependencyCache.get(entry.id);

  if (cached?.signature === signature) {
    return cached.dependencies;
  }

  const dependencies: unknown[] = [entry.id, signature];
  trimEntrySizeDependencyCache(entry.id);
  entrySizeDependencyCache.set(entry.id, { signature, dependencies });
  return dependencies;
};`,
  },
  {
    label: 'E9 bottomFollowSignature 兼容 entries 路径',
    from: `const bottomFollowSignature = computed(() => {
  const lastMessage = visibleMessages.value.at(-1);

  return [
    props.conversationId ?? '',
    visibleMessages.value.length,
    lastMessage?.id ?? '',
    lastMessage?.content.length ?? 0,
    lastMessage?.stream?.status ?? '',
    lastMessage?.toolCalls?.length ?? 0,
    lastMessage?.actions?.length ?? 0,
    props.isTyping ? 'typing' : 'idle',
  ].join(':');
});`,
    to: `const bottomFollowSignature = computed(() => {
  if (props.renderFromEntries) {
    const lastEntry = entryTimeline.value.at(-1);
    const lastEntryStreaming =
      lastEntry &&
      ((lastEntry.kind === 'assistant-text' && lastEntry.streaming) ||
        (lastEntry.kind === 'reasoning' && lastEntry.streaming))
        ? 'streaming'
        : 'idle';

    return [
      'entries',
      props.conversationId ?? '',
      entryTimeline.value.length,
      lastEntry?.id ?? '',
      lastEntryStreaming,
      props.isTyping ? 'typing' : 'idle',
    ].join(':');
  }

  const lastMessage = visibleMessages.value.at(-1);

  return [
    'messages',
    props.conversationId ?? '',
    visibleMessages.value.length,
    lastMessage?.id ?? '',
    lastMessage?.content.length ?? 0,
    lastMessage?.stream?.status ?? '',
    lastMessage?.toolCalls?.length ?? 0,
    lastMessage?.actions?.length ?? 0,
    props.isTyping ? 'typing' : 'idle',
  ].join(':');
});`,
  },
  {
    label: 'E10 size-dependencies 增加 entry 分支',
    from: `          :size-dependencies="
            item.type === 'message' ? getMessageSizeDependencies(item.message) : [props.isTyping]
          "`,
    to: `          :size-dependencies="
            item.type === 'message'
              ? getMessageSizeDependencies(item.message)
              : item.type === 'entry'
                ? getEntrySizeDependencies(item.entry)
                : [props.isTyping]
          "`,
  },
  {
    label: 'E11 模板新增 entry 渲染分支',
    from: `            </AiThreadVirtualMessageItem>

            <Message
              v-else
              from="assistant"
              class="ai-message-typing"
              :aria-label="typingLabel"
            >`,
    to: `            </AiThreadVirtualMessageItem>

            <AiThreadEntryView
              v-else-if="item.type === 'entry'"
              :entry="item.entry"
              :open="entryExpansion.isExpanded(item.entry)"
              :workspace-root-path="workspaceRootPath"
              :plan-details="planDetails"
              :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
              :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
              @update:open="entryExpansion.setExpanded(item.entry, $event)"
              @changed-files-rollback="handleChangedFilesRollback"
              @changed-files-pin="handleChangedFilesPin"
              @plan-approve="emit('planApprove')"
              @plan-reject="emit('planReject')"
              @plan-regenerate="emit('planRegenerate')"
              @plan-update-step-title="handlePlanUpdateStepTitle"
              @plan-remove-step="handlePlanRemoveStep"
            />

            <Message
              v-else
              from="assistant"
              class="ai-message-typing"
              :aria-label="typingLabel"
            >`,
  },
]);

// ════════════════════════════════════════════════════════════════════════════
// 6) AiAssistantPanel.vue 接线(D1~D3)
// ════════════════════════════════════════════════════════════════════════════
planEdit('src/components/business/ai/shell/AiAssistantPanel.vue', [
  {
    label: 'D1 引入 useAiThreadStore',
    from: `import { cloneAiConfigPayload, resolveDefaultAiBaseUrl } from '@/services/ipc/ai-config.service';
import type {
  IAiAgentRun,`,
    to: `import { cloneAiConfigPayload, resolveDefaultAiBaseUrl } from '@/services/ipc/ai-config.service';
import { useAiThreadStore } from '@/store/aiThread';
import type {
  IAiAgentRun,`,
  },
  {
    label: 'D2 派生 renderFromEntries / activeEntries',
    from: `const webSources = useAiWebSources();
const suggestionPool = useCopilotSuggestions();`,
    to: `const webSources = useAiWebSources();
const aiThreadStore = useAiThreadStore();
const renderThreadFromEntries = computed(() => aiThreadStore.renderFromEntries);
const renderThreadEntries = computed(() =>
  aiThreadStore.renderFromEntries ? aiThreadStore.activeEntries : [],
);
const suggestionPool = useCopilotSuggestions();`,
  },
  {
    label: 'D3 向 AiChatThread 传递 entries props',
    from: `      <AiChatThread :messages="visibleThreadMessages" :is-typing="assistant.isSending.value"
        :platform-id="aiIconPlatformId" :provider-label="aiIconTitle"`,
    to: `      <AiChatThread :messages="visibleThreadMessages" :is-typing="assistant.isSending.value"
        :render-from-entries="renderThreadFromEntries" :thread-entries="renderThreadEntries"
        :platform-id="aiIconPlatformId" :provider-label="aiIconTitle"`,
  },
]);

// ════════════════════════════════════════════════════════════════════════════
// 7) 新建 AiChatThread 的 entries 渲染路径 spec(不动现有 AiChatThread.spec)
// ════════════════════════════════════════════════════════════════════════════
planCreate(
  'src/components/business/ai/chat/AiChatThread.entries.spec.ts',
  `import { mount } from '@vue/test-utils';
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
});
`,
);

// ════════════════════════════════════════════════════════════════════════════
// 落盘(全部规划成功后才写)+ 自检
// ════════════════════════════════════════════════════════════════════════════
for (const w of writes) {
  if (w.create) mkdirSync(dirname(abs(w.path)), { recursive: true });
  writeFileSync(abs(w.path), fromLf(w.lf, w.eol), 'utf8');
  console.log(`${w.create ? 'create' : 'edit  '}  ${w.path} (eol=${w.eol === '\r\n' ? 'CRLF' : 'LF'})`);
}

const expectContains = (p, needle) => {
  const txt = toLf(readFileSync(abs(p), 'utf8'));
  if (!txt.includes(needle)) {
    throw new Error(`[step6][self-test] ${p} 缺少预期标记: ${needle}`);
  }
};

expectContains('src/components/business/ai/thread/AiThreadEntryView.vue', "ASSISTANT_MESSAGE_KINDS");
expectContains('src/components/business/ai/thread/AiThreadTimeline.vue', "import AiThreadEntryView from './AiThreadEntryView.vue'");
expectContains('src/components/business/ai/chat/AiThreadSingleMessageTimeline.vue', 'tool-call-patches');
expectContains('src/components/business/ai/chat/AiChatThread.vue', "item.type === 'entry'");
expectContains('src/components/business/ai/chat/AiChatThread.vue', 'getEntrySizeDependencies');
expectContains('src/components/business/ai/shell/AiAssistantPanel.vue', 'renderThreadFromEntries');

console.log('[step6] 完成:策略 A 渲染路径切换已应用。请运行 pnpm typecheck && pnpm lint && pnpm test 验证。');