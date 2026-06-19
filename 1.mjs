// scripts/codemod/step6-render-from-entries.mjs
//
// Step 6 — 渲染路径切换 (Strategy A: 按 entry 虚拟化, 对齐 Zed acp_thread 的 flat Vec<AgentThreadEntry>)
//
// 作用:
//   把 threadEntriesToTimeline(activeEntries) 接入实时可见渲染链:
//     AiAssistantPanel(shell) -> AiChatThread(chat, DynamicScroller)
//   新增按 entry 的虚拟项 (item.type === 'entry'),由 <AiThreadEntryView> 渲染单个 entry。
//   渲染默认仍走旧的 per-message 路径,仅当 store.renderFromEntries === true 时切换到 entries 路径(灰度开关)。
//
// 设计要点:
//   - 行为等价、可逆、最小侵入旧路径(默认 false);新路径为骨架(Step 7+ 补全 plan/terminal/awaiting/inline diff)。
//   - 锚点全部在 LF 归一化内容上匹配, 写回时还原原始 EOL (Windows/CRLF 安全)。
//   - 每个 replaceOnce 严格要求命中次数 === 1, 否则抛错中止, 避免静默错改。
//   - 新文件 createFile 若已存在则抛错 (重复运行保护)。
//
// 用法:
//   node scripts/codemod/step6-render-from-entries.mjs
//
// 不做 git 提交。本地验证通过后由你提交到 main。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ */
/* 0. 路径与根目录                                                      */
/* ------------------------------------------------------------------ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// scripts/codemod/ -> 仓库根
const ROOT = resolve(__dirname, '..', '..');

const abs = (p) => join(ROOT, p);

const P = {
  // 现有文件 (edit)
  chatThread: 'src/components/business/ai/chat/AiChatThread.vue',
  assistantPanel: 'src/components/business/ai/shell/AiAssistantPanel.vue',
  projectionIndex: 'src/components/business/ai/thread/projection/index.ts',
  // 现有文件 (full rewrite)
  timeline: 'src/components/business/ai/thread/AiThreadTimeline.vue',
  singleTimeline:
    'src/components/business/ai/chat/AiThreadSingleMessageTimeline.vue',
  // 新文件 (create)
  entryView: 'src/components/business/ai/thread/AiThreadEntryView.vue',
  entryViewSpec: 'src/components/business/ai/thread/AiThreadEntryView.spec.ts',
  useEntriesTimeline:
    'src/components/business/ai/thread/projection/use-entries-timeline.ts',
  useEntriesTimelineSpec:
    'src/components/business/ai/thread/projection/use-entries-timeline.spec.ts',
};

// 根目录校验: 关键文件必须存在
if (!existsSync(abs(P.chatThread))) {
  throw new Error(
    `[step6] 未找到 ${P.chatThread}, 请在仓库根目录运行: node scripts/codemod/step6-render-from-entries.mjs`,
  );
}

/* ------------------------------------------------------------------ */
/* 1. EOL 自适应 + 编辑工具                                            */
/* ------------------------------------------------------------------ */

function detectEol(raw) {
  // 优先判定 CRLF; 只要存在任意 \r\n 即按 CRLF 写回
  return /\r\n/.test(raw) ? '\r\n' : '\n';
}

const toLf = (raw) => raw.replace(/\r\n/g, '\n');

function readLf(relPath) {
  const full = abs(relPath);
  if (!existsSync(full)) {
    throw new Error(`[step6] 文件不存在: ${relPath}`);
  }
  const raw = readFileSync(full, 'utf8');
  return { raw, eol: detectEol(raw), lf: toLf(raw) };
}

function writeWithEol(relPath, lfContent, eol) {
  const out = eol === '\r\n' ? lfContent.replace(/\n/g, '\r\n') : lfContent;
  writeFileSync(abs(relPath), out, 'utf8');
}

/**
 * 在 content (LF 归一化) 中把 anchor 精确替换为 replacement, 命中次数必须为 1。
 */
function replaceOnce(content, anchor, replacement, label) {
  const parts = content.split(anchor);
  const occurrences = parts.length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `[step6] 锚点命中 ${occurrences} 次 (期望 1): ${label}\n` +
        `--- anchor ---\n${anchor}\n--------------`,
    );
  }
  return parts.join(replacement);
}

/** 读文件 -> LF -> 链式 replaceOnce -> 还原 EOL -> 写回 */
function editFile(relPath, edits) {
  const { eol, lf } = readLf(relPath);
  let next = lf;
  for (const e of edits) {
    next = replaceOnce(next, e.anchor, e.replacement, `${relPath} :: ${e.label}`);
  }
  writeWithEol(relPath, next, eol);
  console.log(`  edit  ${relPath} (${edits.length} ops, eol=${eol === '\r\n' ? 'CRLF' : 'LF'})`);
}

/** 整文件覆盖, 保留原 EOL */
function rewriteFile(relPath, lfContent) {
  const { eol } = readLf(relPath);
  writeWithEol(relPath, lfContent, eol);
  console.log(`  rewrite ${relPath} (eol=${eol === '\r\n' ? 'CRLF' : 'LF'})`);
}

/** 新建文件 (LF), 已存在则抛错 — 重复运行保护 */
function createFile(relPath, lfContent) {
  const full = abs(relPath);
  if (existsSync(full)) {
    throw new Error(
      `[step6] 目标文件已存在, 拒绝覆盖 (脚本似乎已运行过): ${relPath}\n` +
        `如需重跑, 请先用 git 还原工作区。`,
    );
  }
  writeFileSync(full, lfContent, 'utf8');
  console.log(`  create  ${relPath}`);
}

/* ================================================================== */
/* 2. 新文件内容                                                       */
/* ================================================================== */

/* ---- projection/use-entries-timeline.ts ---- */
const USE_ENTRIES_TIMELINE_TS = `import { computed, type Ref } from 'vue';

import type { TAiThreadEntry } from './entry-types';
import {
  threadEntriesToTimeline,
  type TAiThreadTimelineItem,
} from './thread-entries-to-timeline';

export interface IUseEntriesTimelineOptions {
  /** 当前正在流式输出的 assistant message id (用于标记 streaming entry)。 */
  streamingMessageId?: Ref<string | null | undefined>;
}

/**
 * 把响应式 entries 投影成 timeline items。
 * 纯包装 threadEntriesToTimeline, 不引入额外状态, 便于在多个渲染点复用。
 */
export function useEntriesTimeline(
  entries: Ref<readonly TAiThreadEntry[]>,
  options: IUseEntriesTimelineOptions = {},
): Ref<TAiThreadTimelineItem[]> {
  return computed(() =>
    threadEntriesToTimeline(entries.value, {
      streamingMessageId: options.streamingMessageId?.value ?? null,
    }),
  );
}
`;

/* ---- projection/use-entries-timeline.spec.ts ---- */
const USE_ENTRIES_TIMELINE_SPEC_TS = `import { ref } from 'vue';
import { describe, expect, it } from 'vitest';

import type { TAiThreadEntry } from './entry-types';
import { useEntriesTimeline } from './use-entries-timeline';

function userEntry(id: string, text: string): TAiThreadEntry {
  return {
    kind: 'user-message',
    id,
    messageId: id,
    markdown: text,
    references: [],
  };
}

function assistantEntry(id: string, text: string, streaming = false): TAiThreadEntry {
  return {
    kind: 'assistant-text',
    id,
    messageId: id,
    markdown: text,
    streaming,
  };
}

describe('useEntriesTimeline', () => {
  it('projects entries into timeline items reactively', () => {
    const entries = ref<TAiThreadEntry[]>([
      userEntry('u1', 'hi'),
      assistantEntry('a1', 'hello'),
    ]);
    const timeline = useEntriesTimeline(entries);
    expect(timeline.value.length).toBe(2);

    entries.value = [...entries.value, assistantEntry('a2', 'more')];
    expect(timeline.value.length).toBe(3);
  });

  it('passes streamingMessageId through to the projection', () => {
    const entries = ref<TAiThreadEntry[]>([assistantEntry('a1', 'partial', true)]);
    const streamingMessageId = ref<string | null>('a1');
    const timeline = useEntriesTimeline(entries, { streamingMessageId });
    expect(timeline.value.length).toBe(1);

    // 切到 null 不应抛错, 仍返回同样数量的 item
    streamingMessageId.value = null;
    expect(timeline.value.length).toBe(1);
  });
});
`;

/* ---- thread/AiThreadEntryView.vue ---- */
const ENTRY_VIEW_VUE = `<script setup lang="ts">
import { computed } from 'vue';

import type { IAiThreadEntry } from '@/types/ai/thread';

import AiThreadReasoningView from './AiThreadReasoningView.vue';
import AiThreadToolCallView from './AiThreadToolCallView.vue';
import AiThreadPlanControlView from './AiThreadPlanControlView.vue';
import AiThreadChangedFilesSummaryView from './AiThreadChangedFilesSummaryView.vue';
import AiThreadContextCompactionView from './AiThreadContextCompactionView.vue';
import AiThreadUserMessageView from './AiThreadUserMessageView.vue';
import AiThreadAssistantTextView from './AiThreadAssistantTextView.vue';

const props = withDefaults(
  defineProps<{
    entry: IAiThreadEntry;
    pinningChangedFilesSummaryId?: string | null;
  }>(),
  {
    pinningChangedFilesSummaryId: null,
  },
);

const emit = defineEmits<{
  changedFilesRollback: [summaryId: string];
  changedFilesPin: [summaryId: string];
  planApprove: [];
  planUpdateStepTitle: [stepId: string, title: string];
  planRemoveStep: [stepId: string];
}>();

const kind = computed(() => props.entry.kind);

function onRollback(summaryId: string) {
  emit('changedFilesRollback', summaryId);
}
function onPin(summaryId: string) {
  emit('changedFilesPin', summaryId);
}
function onPlanApprove() {
  emit('planApprove');
}
function onPlanUpdateStepTitle(stepId: string, title: string) {
  emit('planUpdateStepTitle', stepId, title);
}
function onPlanRemoveStep(stepId: string) {
  emit('planRemoveStep', stepId);
}
</script>

<template>
  <div class="ai-thread-entry" :data-entry-kind="kind">
    <AiThreadUserMessageView
      v-if="entry.kind === 'user-message'"
      :entry="entry"
    />
    <AiThreadAssistantTextView
      v-else-if="entry.kind === 'assistant-text'"
      :entry="entry"
    />
    <AiThreadReasoningView
      v-else-if="entry.kind === 'reasoning'"
      :entry="entry"
    />
    <AiThreadToolCallView
      v-else-if="entry.kind === 'tool-call'"
      :entry="entry"
    />
    <AiThreadPlanControlView
      v-else-if="entry.kind === 'plan-control'"
      :entry="entry"
      @plan-approve="onPlanApprove"
      @plan-update-step-title="onPlanUpdateStepTitle"
      @plan-remove-step="onPlanRemoveStep"
    />
    <AiThreadContextCompactionView
      v-else-if="entry.kind === 'context-compaction'"
      :entry="entry"
    />
    <AiThreadChangedFilesSummaryView
      v-else-if="entry.kind === 'changed-files-summary'"
      :entry="entry"
      :pinning="pinningChangedFilesSummaryId === entry.summary.id"
      @rollback="onRollback"
      @pin="onPin"
    />
  </div>
</template>
`;

/* ---- thread/AiThreadEntryView.spec.ts ---- */
const ENTRY_VIEW_SPEC_TS = `import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { IAiThreadEntry } from '@/types/ai/thread';

import AiThreadEntryView from './AiThreadEntryView.vue';

const stubs = {
  AiThreadUserMessageView: { props: ['entry'], template: '<div class="stub-user" />' },
  AiThreadAssistantTextView: { props: ['entry'], template: '<div class="stub-assistant" />' },
  AiThreadReasoningView: { props: ['entry'], template: '<div class="stub-reasoning" />' },
  AiThreadToolCallView: { props: ['entry'], template: '<div class="stub-tool" />' },
  AiThreadPlanControlView: { props: ['entry'], template: '<div class="stub-plan" />' },
  AiThreadContextCompactionView: { props: ['entry'], template: '<div class="stub-compaction" />' },
  AiThreadChangedFilesSummaryView: {
    props: ['entry', 'pinning'],
    template: '<div class="stub-summary" />',
  },
};

function userEntry(): IAiThreadEntry {
  return { kind: 'user-message', id: 'u1', messageId: 'u1', markdown: 'hi', references: [] };
}
function assistantEntry(): IAiThreadEntry {
  return { kind: 'assistant-text', id: 'a1', messageId: 'a1', markdown: 'hello', streaming: false };
}
function summaryEntry(): IAiThreadEntry {
  return {
    kind: 'changed-files-summary',
    id: 's1',
    messageId: 's1',
    summary: {
      id: 'sum-1',
      runId: 'run-1',
      stepId: 'step-1',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      patchRef: 'patch-1',
    },
  };
}

describe('AiThreadEntryView', () => {
  it('renders the user message view for user-message entries', () => {
    const wrapper = mount(AiThreadEntryView, {
      props: { entry: userEntry() },
      global: { stubs },
    });
    expect(wrapper.find('.stub-user').exists()).toBe(true);
    expect(wrapper.attributes('data-entry-kind')).toBe('user-message');
  });

  it('renders the assistant text view for assistant-text entries', () => {
    const wrapper = mount(AiThreadEntryView, {
      props: { entry: assistantEntry() },
      global: { stubs },
    });
    expect(wrapper.find('.stub-assistant').exists()).toBe(true);
  });

  it('forwards rollback/pin events for changed-files-summary entries', async () => {
    const wrapper = mount(AiThreadEntryView, {
      props: { entry: summaryEntry(), pinningChangedFilesSummaryId: 'sum-1' },
      global: { stubs },
    });
    const summary = wrapper.findComponent({ name: 'AiThreadChangedFilesSummaryView' });
    expect(summary.props('pinning')).toBe(true);

    summary.vm.$emit('rollback', 'sum-1');
    summary.vm.$emit('pin', 'sum-1');
    expect(wrapper.emitted('changedFilesRollback')?.[0]).toEqual(['sum-1']);
    expect(wrapper.emitted('changedFilesPin')?.[0]).toEqual(['sum-1']);
  });
});
`;

/* ================================================================== */
/* 3. 整文件重写: AiThreadTimeline.vue / AiThreadSingleMessageTimeline.vue */
/*    两者把 per-entry 的渲染统一委托给 <AiThreadEntryView>            */
/* ================================================================== */

const TIMELINE_VUE = `<script setup lang="ts">
import { computed } from 'vue';

import type { IAiThreadEntry, IAiThreadMessage } from '@/types/ai/thread';
import { useAiThreadStore } from '@/store/aiThread';
import { storeToRefs } from 'pinia';

import AiThreadEntryView from './AiThreadEntryView.vue';
import { useEntriesTimeline } from './projection/use-entries-timeline';
import { buildThreadEntries } from './projection/build-thread-entries';

const props = withDefaults(
  defineProps<{
    messages: IAiThreadMessage[];
    threadEntries?: IAiThreadEntry[] | null;
    renderFromEntries?: boolean;
    streamingMessageId?: string | null;
    pinningChangedFilesSummaryId?: string | null;
  }>(),
  {
    threadEntries: null,
    renderFromEntries: false,
    streamingMessageId: null,
    pinningChangedFilesSummaryId: null,
  },
);

const emit = defineEmits<{
  changedFilesRollback: [summaryId: string];
  changedFilesPin: [summaryId: string];
  planApprove: [];
  planUpdateStepTitle: [stepId: string, title: string];
  planRemoveStep: [stepId: string];
}>();

const aiThreadStore = useAiThreadStore();
const { renderFromEntries: storeRenderFromEntries } = storeToRefs(aiThreadStore);

const renderFromEntries = computed(
  () => props.renderFromEntries || storeRenderFromEntries.value,
);

const explicitEntries = computed<IAiThreadEntry[]>(() =>
  props.threadEntries ?? buildThreadEntries(props.messages),
);

const streamingMessageId = computed(() => props.streamingMessageId);
const timeline = useEntriesTimeline(explicitEntries, { streamingMessageId });

const entries = computed<IAiThreadEntry[]>(() =>
  renderFromEntries.value ? timeline.value : explicitEntries.value,
);
</script>

<template>
  <div class="ai-thread-timeline">
    <AiThreadEntryView
      v-for="entry in entries"
      :key="entry.id"
      :entry="entry"
      :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
      @changed-files-rollback="emit('changedFilesRollback', $event)"
      @changed-files-pin="emit('changedFilesPin', $event)"
      @plan-approve="emit('planApprove')"
      @plan-update-step-title="(stepId, title) => emit('planUpdateStepTitle', stepId, title)"
      @plan-remove-step="emit('planRemoveStep', $event)"
    />
  </div>
</template>
`;

const SINGLE_TIMELINE_VUE = `<script setup lang="ts">
import { computed } from 'vue';

import type { IAiThreadEntry, IAiThreadMessage } from '@/types/ai/thread';

import AiThreadEntryView from '../thread/AiThreadEntryView.vue';
import { buildSingleMessageThreadEntries } from '../thread/projection/build-single-message-thread-entries';

const props = withDefaults(
  defineProps<{
    message: IAiThreadMessage;
    streaming?: boolean;
    pinningChangedFilesSummaryId?: string | null;
  }>(),
  {
    streaming: false,
    pinningChangedFilesSummaryId: null,
  },
);

const emit = defineEmits<{
  changedFilesRollback: [summaryId: string];
  changedFilesPin: [summaryId: string];
  planApprove: [];
  planUpdateStepTitle: [stepId: string, title: string];
  planRemoveStep: [stepId: string];
}>();

const entries = computed<IAiThreadEntry[]>(() =>
  buildSingleMessageThreadEntries(props.message, { streaming: props.streaming }),
);
</script>

<template>
  <div class="ai-thread-single-message-timeline">
    <AiThreadEntryView
      v-for="entry in entries"
      :key="entry.id"
      :entry="entry"
      :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
      @changed-files-rollback="emit('changedFilesRollback', $event)"
      @changed-files-pin="emit('changedFilesPin', $event)"
      @plan-approve="emit('planApprove')"
      @plan-update-step-title="(stepId, title) => emit('planUpdateStepTitle', stepId, title)"
      @plan-remove-step="emit('planRemoveStep', $event)"
    />
  </div>
</template>
`;

/* ================================================================== */
/* 4. 现有文件编辑                                                     */
/* ================================================================== */

/* ---- 4a. projection/index.ts: 追加 barrel 导出 (字母序在末尾) ---- */
editFile(P.projectionIndex, [
  {
    label: 'export use-entries-timeline',
    anchor: `export * from './tool-view';`,
    replacement:
      `export * from './tool-view';\n` +
      `export * from './use-entries-timeline';`,
  },
]);

/* ---- 4b. AiChatThread.vue (12 ops) ---- */
editFile(P.chatThread, [
  // (1) import 块: 新增 AiThreadEntryView / projection / useThreadEntryExpansion / IAiThreadEntry
  {
    label: 'imports',
    anchor: `import AiThreadVirtualMessageItem from './AiThreadVirtualMessageItem.vue';`,
    replacement:
      `import AiThreadVirtualMessageItem from './AiThreadVirtualMessageItem.vue';\n` +
      `import AiThreadEntryView from '../thread/AiThreadEntryView.vue';\n` +
      `import {\n` +
      `  type TAiThreadEntry,\n` +
      `  useEntriesTimeline,\n` +
      `} from '../thread/projection';\n` +
      `import { useThreadEntryExpansion } from '../thread/useThreadEntryExpansion';\n` +
      `import type { IAiThreadEntry } from '@/types/ai/thread';`,
  },

  // (2) TAiThreadVirtualItem: 新增 entry 变体
  {
    label: 'TAiThreadVirtualItem entry variant',
    anchor: `type TAiThreadVirtualItem =\n  | { type: 'message'; id: string; message: IAiThreadMessage }\n  | { type: 'typing'; id: string };`,
    replacement:
      `type TAiThreadVirtualItem =\n` +
      `  | { type: 'message'; id: string; message: IAiThreadMessage }\n` +
      `  | { type: 'entry'; id: string; entry: IAiThreadEntry }\n` +
      `  | { type: 'typing'; id: string };`,
  },

  // (3) props 类型
  {
    label: 'props type add entries props',
    anchor: `    pinningChangedFilesSummaryId?: string | null;\n  }>(),`,
    replacement:
      `    pinningChangedFilesSummaryId?: string | null;\n` +
      `    renderFromEntries?: boolean;\n` +
      `    threadEntries?: IAiThreadEntry[] | null;\n` +
      `    streamingMessageId?: string | null;\n` +
      `  }>(),`,
  },

  // (4) props defaults
  {
    label: 'props defaults add entries props',
    anchor: `    pinningChangedFilesSummaryId: null,\n  },\n);`,
    replacement:
      `    pinningChangedFilesSummaryId: null,\n` +
      `    renderFromEntries: false,\n` +
      `    threadEntries: null,\n` +
      `    streamingMessageId: null,\n` +
      `  },\n);`,
  },

  // (5) entries setup 块: 紧跟 emit 定义之后
  {
    label: 'entries setup block',
    anchor: `  planRemoveStep: [stepId: string];\n}>();`,
    replacement:
      `  planRemoveStep: [stepId: string];\n}>();\n\n` +
      `// ----- Step 6: entries 渲染路径 (灰度, 默认走旧 per-message 路径) -----\n` +
      `const threadEntriesRef = computed<IAiThreadEntry[]>(\n` +
      `  () => props.threadEntries ?? [],\n` +
      `);\n` +
      `const streamingMessageIdRef = computed(() => props.streamingMessageId);\n` +
      `const entryTimeline = useEntriesTimeline(threadEntriesRef, {\n` +
      `  streamingMessageId: streamingMessageIdRef,\n` +
      `});\n` +
      `const entryExpansion = useThreadEntryExpansion(entryTimeline);\n` +
      `const entryMessagesById = computed(() => {\n` +
      `  const map = new Map<string, IAiThreadEntry>();\n` +
      `  for (const entry of entryTimeline.value) {\n` +
      `    map.set(entry.id, entry);\n` +
      `  }\n` +
      `  return map;\n` +
      `});\n` +
      `const entryLastIdByMessage = computed(() => {\n` +
      `  const map = new Map<string, string>();\n` +
      `  for (const entry of entryTimeline.value) {\n` +
      `    map.set(entry.messageId, entry.id);\n` +
      `  }\n` +
      `  return map;\n` +
      `});\n` +
      `const afterUserEntryIds = computed(() => {\n` +
      `  const ids = new Set<string>();\n` +
      `  const list = entryTimeline.value;\n` +
      `  for (let i = 0; i < list.length; i += 1) {\n` +
      `    const prev = list[i - 1];\n` +
      `    if (prev && prev.kind === 'user-message') {\n` +
      `      ids.add(list[i].id);\n` +
      `    }\n` +
      `  }\n` +
      `  return ids;\n` +
      `});\n` +
      `const entryBoundaryMessage = computed(\n` +
      `  () => entryTimeline.value.find((entry) => entry.kind === 'user-message') ?? null,\n` +
      `);\n` +
      `const hasInlineProgressEntry = computed(() =>\n` +
      `  entryTimeline.value.some(\n` +
      `    (entry) =>\n` +
      `      (entry.kind === 'assistant-text' && entry.streaming) ||\n` +
      `      (entry.kind === 'reasoning' && entry.streaming),\n` +
      `  ),\n` +
      `);`,
  },

  // (6) rewire shouldRenderStandaloneTyping
  {
    label: 'shouldRenderStandaloneTyping rewire',
    anchor: `const shouldRenderStandaloneTyping = computed(\n  () => props.isTyping && !hasInlineProgressMessage.value,\n);`,
    replacement:
      `const shouldRenderStandaloneTyping = computed(() => {\n` +
      `  if (!props.isTyping) {\n` +
      `    return false;\n` +
      `  }\n` +
      `  return props.renderFromEntries\n` +
      `    ? !hasInlineProgressEntry.value\n` +
      `    : !hasInlineProgressMessage.value;\n` +
      `});`,
  },

  // (7) isThreadEmpty + rewire shouldRenderEmptyState
  {
    label: 'isThreadEmpty + shouldRenderEmptyState',
    anchor: `const shouldRenderEmptyState = computed(\n  () => visibleMessages.value.length === 0 && !props.isTyping,\n);`,
    replacement:
      `const isThreadEmpty = computed(() =>\n` +
      `  props.renderFromEntries\n` +
      `    ? entryTimeline.value.length === 0\n` +
      `    : visibleMessages.value.length === 0,\n` +
      `);\n` +
      `const shouldRenderEmptyState = computed(\n` +
      `  () => isThreadEmpty.value && !props.isTyping,\n` +
      `);`,
  },

  // (8) rewire virtualItems (含模板字面量 -> 转义反引号与 ${)
  {
    label: 'virtualItems rewire',
    anchor:
      `const virtualItems = computed<TAiThreadVirtualItem[]>(() => {\n` +
      `  const items: TAiThreadVirtualItem[] = visibleMessages.value.map((message) => ({\n` +
      `    type: 'message',\n` +
      `    id: message.id,\n` +
      `    message,\n` +
      `  }));\n` +
      `  if (shouldRenderStandaloneTyping.value) {\n` +
      `    items.push({ type: 'typing', id: \`typing:\${conversationId.value ?? 'active'}\` });\n` +
      `  }\n` +
      `  return items;\n` +
      `});`,
    replacement:
      `const virtualItems = computed<TAiThreadVirtualItem[]>(() => {\n` +
      `  const items: TAiThreadVirtualItem[] = props.renderFromEntries\n` +
      `    ? entryTimeline.value.map((entry) => ({\n` +
      `        type: 'entry' as const,\n` +
      `        id: entry.id,\n` +
      `        entry,\n` +
      `      }))\n` +
      `    : visibleMessages.value.map((message) => ({\n` +
      `        type: 'message' as const,\n` +
      `        id: message.id,\n` +
      `        message,\n` +
      `      }));\n` +
      `  if (shouldRenderStandaloneTyping.value) {\n` +
      `    items.push({ type: 'typing', id: \`typing:\${conversationId.value ?? 'active'}\` });\n` +
      `  }\n` +
      `  return items;\n` +
      `});`,
  },

  // (9) entry size helpers (含 \\u0001 / \\u001f -> 双重转义)
  {
    label: 'entry size dependency helpers',
    anchor: `  return values;\n}\n\n// ----- end getMessageSizeDependencies -----`,
    replacement:
      `  return values;\n}\n\n// ----- end getMessageSizeDependencies -----\n\n` +
      `const entrySizeDependencyCache = new Map<string, TMessageSizeDependencyCacheEntry>();\n` +
      `function trimEntrySizeDependencyCache() {\n` +
      `  if (entrySizeDependencyCache.size <= 300) {\n` +
      `    return;\n` +
      `  }\n` +
      `  const overflow = entrySizeDependencyCache.size - 300;\n` +
      `  let removed = 0;\n` +
      `  for (const key of entrySizeDependencyCache.keys()) {\n` +
      `    if (removed >= overflow) {\n` +
      `      break;\n` +
      `    }\n` +
      `    entrySizeDependencyCache.delete(key);\n` +
      `    removed += 1;\n` +
      `  }\n` +
      `}\n` +
      `function buildEntrySizeDependencyValues(entry: IAiThreadEntry): string {\n` +
      `  switch (entry.kind) {\n` +
      `    case 'user-message':\n` +
      `      return ['user', entry.markdown.length, entry.references.length].join('\\u001f');\n` +
      `    case 'assistant-text':\n` +
      `      return ['assistant', entry.markdown.length, entry.streaming ? 1 : 0].join('\\u001f');\n` +
      `    case 'reasoning':\n` +
      `      return [\n` +
      `        'reasoning',\n` +
      `        entry.segments.length,\n` +
      `        entry.segments.reduce((acc, s) => acc + s.length, 0),\n` +
      `        entry.isLong ? 1 : 0,\n` +
      `        entry.streaming ? 1 : 0,\n` +
      `      ].join('\\u001f');\n` +
      `    case 'tool-call':\n` +
      `      return [\n` +
      `        'tool-call',\n` +
      `        entry.toolCall.status,\n` +
      `        entry.awaiting ? 1 : 0,\n` +
      `        JSON.stringify(entry.toolCall.content ?? []).length,\n` +
      `      ].join('\\u001f');\n` +
      `    case 'plan-control':\n` +
      `      return ['plan-control', entry.phase, entry.goal.length, entry.references.length].join('\\u001f');\n` +
      `    case 'context-compaction':\n` +
      `      return ['context-compaction', entry.text.length].join('\\u001f');\n` +
      `    case 'changed-files-summary':\n` +
      `      return ['changed-files-summary', JSON.stringify(entry.summary).length].join('\\u001f');\n` +
      `    default: {\n` +
      `      const _exhaustive: never = entry;\n` +
      `      return String(_exhaustive);\n` +
      `    }\n` +
      `  }\n` +
      `}\n` +
      `function getEntrySizeDependencies(entry: IAiThreadEntry): unknown[] {\n` +
      `  const signature = buildEntrySizeDependencyValues(entry);\n` +
      `  const cached = entrySizeDependencyCache.get(entry.id);\n` +
      `  if (cached && cached.signature === signature) {\n` +
      `    return cached.values;\n` +
      `  }\n` +
      `  const values: unknown[] = [entry.id, signature];\n` +
      `  entrySizeDependencyCache.set(entry.id, { signature, values });\n` +
      `  trimEntrySizeDependencyCache();\n` +
      `  return values;\n` +
      `}`,
  },

  // (10) rewire bottomFollowSignature (entries 分支; streaming 收窄安全)
  {
    label: 'bottomFollowSignature rewire',
    anchor: `const bottomFollowSignature = computed(() => {\n  const last = visibleMessages.value.at(-1);\n  return [visibleMessages.value.length, last?.id ?? '', props.isTyping ? 1 : 0].join('|');\n});`,
    replacement:
      `const bottomFollowSignature = computed(() => {\n` +
      `  if (props.renderFromEntries) {\n` +
      `    const list = entryTimeline.value;\n` +
      `    const lastEntry = list.at(-1);\n` +
      `    const lastEntryStreaming =\n` +
      `      lastEntry &&\n` +
      `      ((lastEntry.kind === 'assistant-text' && lastEntry.streaming) ||\n` +
      `        (lastEntry.kind === 'reasoning' && lastEntry.streaming))\n` +
      `        ? 1\n` +
      `        : 0;\n` +
      `    return [\n` +
      `      'entries',\n` +
      `      list.length,\n` +
      `      lastEntry?.id ?? '',\n` +
      `      lastEntryStreaming,\n` +
      `      props.isTyping ? 1 : 0,\n` +
      `    ].join('|');\n` +
      `  }\n` +
      `  const last = visibleMessages.value.at(-1);\n` +
      `  return [\n` +
      `    'messages',\n` +
      `    visibleMessages.value.length,\n` +
      `    last?.id ?? '',\n` +
      `    props.isTyping ? 1 : 0,\n` +
      `  ].join('|');\n` +
      `});`,
  },

  // (11) 模板 :size-dependencies 三路三元
  {
    label: 'template size-dependencies 3-way',
    anchor: `:size-dependencies="item.type === 'message' ? getMessageSizeDependencies(item.message) : [props.isTyping]"`,
    replacement: `:size-dependencies="item.type === 'message' ? getMessageSizeDependencies(item.message) : item.type === 'entry' ? getEntrySizeDependencies(item.entry) : [props.isTyping]"`,
  },

  // (12) 模板插入 entry 分支
  {
    label: 'template entry branch',
    anchor: `          <Message v-else from="assistant"`,
    replacement:
      `          <template v-else-if="item.type === 'entry'">\n` +
      `            <AiThreadEntryView\n` +
      `              :entry="item.entry"\n` +
      `              :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"\n` +
      `              @changed-files-rollback="handleChangedFilesRollback"\n` +
      `              @changed-files-pin="handleChangedFilesPin"\n` +
      `              @plan-approve="emit('planApprove')"\n` +
      `              @plan-update-step-title="handlePlanUpdateStepTitle"\n` +
      `              @plan-remove-step="handlePlanRemoveStep"\n` +
      `            />\n` +
      `          </template>\n` +
      `          <Message v-else from="assistant"`,
  },
]);

/* ---- 4c. AiAssistantPanel.vue (3 ops) ---- */
editFile(P.assistantPanel, [
  // D1 import useAiThreadStore
  {
    label: 'import useAiThreadStore',
    anchor: `import { aiConfigService } from '@/services/ai-config.service';`,
    replacement:
      `import { aiConfigService } from '@/services/ai-config.service';\n` +
      `import { useAiThreadStore } from '@/store/aiThread';`,
  },
  // D2 setup: store + 派生 props
  {
    label: 'setup aiThreadStore derivations',
    anchor: `const webSources = useAiWebSources();\nconst suggestionPool`,
    replacement:
      `const webSources = useAiWebSources();\n` +
      `const aiThreadStore = useAiThreadStore();\n` +
      `const renderThreadFromEntries = computed(() => aiThreadStore.renderFromEntries);\n` +
      `const renderThreadEntries = computed(() =>\n` +
      `  aiThreadStore.renderFromEntries ? aiThreadStore.activeEntries : [],\n` +
      `);\n` +
      `const streamingThreadMessageId = computed(\n` +
      `  () => aiThreadStore.activeThread?.streamingMessageId ?? null,\n` +
      `);\n` +
      `const suggestionPool`,
  },
  // D3 模板: 传入新 props
  {
    label: 'AiChatThread props wiring',
    anchor: `      <AiChatThread\n`,
    replacement:
      `      <AiChatThread\n` +
      `        :render-from-entries="renderThreadFromEntries"\n` +
      `        :thread-entries="renderThreadEntries"\n` +
      `        :streaming-message-id="streamingThreadMessageId"\n`,
  },
]);

/* ================================================================== */
/* 5. 整文件重写 + 新建文件                                            */
/* ================================================================== */

rewriteFile(P.timeline, TIMELINE_VUE);
rewriteFile(P.singleTimeline, SINGLE_TIMELINE_VUE);

createFile(P.useEntriesTimeline, USE_ENTRIES_TIMELINE_TS);
createFile(P.useEntriesTimelineSpec, USE_ENTRIES_TIMELINE_SPEC_TS);
createFile(P.entryView, ENTRY_VIEW_VUE);
createFile(P.entryViewSpec, ENTRY_VIEW_SPEC_TS);

/* ================================================================== */
/* 6. 自检                                                            */
/* ================================================================== */

function assertContains(relPath, marker, label) {
  const raw = toLf(readFileSync(abs(relPath), 'utf8'));
  if (!raw.includes(marker)) {
    throw new Error(`[step6][self-test] 未找到标记 "${marker}" (${label}) in ${relPath}`);
  }
}

console.log('\n[step6] self-test ...');

for (const f of [
  P.entryView,
  P.entryViewSpec,
  P.useEntriesTimeline,
  P.useEntriesTimelineSpec,
]) {
  if (!existsSync(abs(f))) {
    throw new Error(`[step6][self-test] 新文件缺失: ${f}`);
  }
}

assertContains(P.projectionIndex, `use-entries-timeline`, 'projection barrel export');
assertContains(P.useEntriesTimeline, 'useEntriesTimeline', 'composable export');
assertContains(P.chatThread, `item.type === 'entry'`, 'AiChatThread entry branch');
assertContains(P.chatThread, 'getEntrySizeDependencies', 'AiChatThread size deps');
assertContains(P.chatThread, 'AiThreadEntryView', 'AiChatThread entry view import');
assertContains(P.assistantPanel, 'useAiThreadStore', 'AiAssistantPanel store import');
assertContains(P.assistantPanel, ':render-from-entries', 'AiAssistantPanel props wiring');
assertContains(P.timeline, 'AiThreadEntryView', 'AiThreadTimeline delegation');
assertContains(P.singleTimeline, 'AiThreadEntryView', 'AiThreadSingleMessageTimeline delegation');

console.log('[step6] self-test OK\n');

/* ================================================================== */
/* 7. 后续步骤提示                                                     */
/* ================================================================== */

console.log('[step6] done. 该脚本不做 git 提交。请本地验证:');
console.log('  pnpm test');
console.log('  pnpm typecheck');
console.log('  pnpm lint');
console.log('全部通过后再提交到 main。');