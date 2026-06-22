#!/usr/bin/env node
// scripts/s1-wire-plan-control-entry.mjs
//
// S1（Route B）：将 Plan 审批卡从“合成一条 assistant 消息塞进 messages”改为
// “渲染期 overlay 一条数据模型 plan_control entry 进 thread-entries”，由 AiChatThread 的
// threadEntriesToTimeline 投影为真正的 plan-control 渲染条目（reduce 不持久化审批临时态，
// 避免拒绝/重置后残留无法清除的幽灵卡）。同时把 AiAssistantPanel.spec.ts 的 AiChatThread
// 替身改为从 thread-entries 渲染审批卡，与真实组件契约对齐（此前替身从 messages 的
// thread-plan-control 合成消息渲染，属伪绿）。
//
// 行为变化仅限审批卡“喂入通道”（messages → thread-entries）；审批/拒绝/token 路径不变。
//
// 用法：
//   node scripts/s1-wire-plan-control-entry.mjs           # 预演（dry-run，不写盘）
//   node scripts/s1-wire-plan-control-entry.mjs --apply   # 实际写盘（保留原文件 EOL）

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apply = process.argv.includes('--apply');
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const specTemplateOld = String.raw`            '<section data-testid="chat-thread"><slot name="empty" /><template v-for="message in messages.filter((entry) => !entry.id.startsWith(\'agent-flow:\'))" :key="message.id"><div v-if="message.id === \'thread-plan-control\'" data-testid="plan-confirmation"><ol><li v-for="step in (planDetails?.steps ?? [])" :key="step.id" v-text="step.title" /></ol><button data-testid="approve-plan" :disabled="!planDetails?.canApprove" @click="$emit(\'planApprove\')">批准</button></div><article v-else :data-role="message.role" v-text="message.content" /><slot name="after-message" :message="message" /></template></section>',`;

const specTemplateNew = String.raw`            '<section data-testid="chat-thread"><slot name="empty" /><div v-if="(threadEntries ?? []).some((entry) => entry.type === \'plan_control\')" data-testid="plan-confirmation"><ol><li v-for="step in (planDetails?.steps ?? [])" :key="step.id" v-text="step.title" /></ol><button data-testid="approve-plan" :disabled="!planDetails?.canApprove" @click="$emit(\'planApprove\')">批准</button></div><template v-for="message in messages.filter((entry) => !entry.id.startsWith(\'agent-flow:\'))" :key="message.id"><article :data-role="message.role" v-text="message.content" /><slot name="after-message" :message="message" /></template></section>',`;

const plan = [
  {
    file: 'src/components/business/ai/shell/AiAssistantPanel.vue',
    edits: [
      {
        label: 'V1 收敛 projection import（移除 buildPlanControlMessage）',
        find: [
          'import {',
          '  buildPlanControlMessage,',
          '  deriveThreadPlanDetails,',
          "} from '@/components/business/ai/thread/projection';",
        ].join('\n'),
        replace:
          "import { deriveThreadPlanDetails } from '@/components/business/ai/thread/projection';",
      },
      {
        label: 'V2 新增 IAiThreadEntry 类型导入',
        find: [
          "import type { IAskUserResult } from '@/types/ai/sidecar';",
          'import type {',
          '  IActiveRunSummary,',
        ].join('\n'),
        replace: [
          "import type { IAskUserResult } from '@/types/ai/sidecar';",
          "import type { IAiThreadEntry } from '@/types/ai/thread';",
          'import type {',
          '  IActiveRunSummary,',
        ].join('\n'),
      },
      {
        label: 'V3 planControlMessage → planControlEntry（数据模型 plan_control 条目）',
        find: [
          '// Plan 审批不再是输入框上方的独立面板，而是平铺时间线里的一条 plan-control 条目：',
          '// 这里把它合成成一条 assistant 消息追加进可见时间线，运行态明细由投影层派生。',
          'const planControlMessage = computed(() =>',
          '  buildPlanControlMessage({',
          '    goal: planActiveGoal.value,',
          '    references: [],',
          '    isAwaitingApproval: planConfirmationVisible.value,',
          '    createdAt: planCreatedAt.value ?? new Date().toISOString(),',
          '  }),',
          ');',
        ].join('\n'),
        replace: [
          '// Plan 审批作为平铺时间线里的一条 plan-control 条目：等待批准时合成一条数据模型',
          '// plan_control entry，追加进喂给 AiChatThread 的 thread-entries，由 threadEntriesToTimeline',
          '// 投影为 plan-control 渲染条目。审批态是 planStore 派生的临时态，故只在渲染期 overlay，',
          '// 不落 reduce 持久化：批准/拒绝后它随 planConfirmationVisible 自然消失，不残留幽灵卡。',
          'const planControlEntry = computed<IAiThreadEntry | null>(() => {',
          '  if (!planConfirmationVisible.value) {',
          '    return null;',
          '  }',
          '',
          '  const goal = planActiveGoal.value.trim();',
          '',
          '  if (goal.length === 0) {',
          '    return null;',
          '  }',
          '',
          '  return {',
          "    type: 'plan_control',",
          "    id: 'thread-plan-control',",
          '    createdAt: planCreatedAt.value ?? new Date().toISOString(),',
          '    goal,',
          '    references: [],',
          "    phase: 'awaiting-approval',",
          '  };',
          '});',
        ].join('\n'),
      },
      {
        label: 'V4 visibleThreadMessages → visibleThreadEntries（entries + overlay）',
        find: [
          '// 真正喂给平铺时间线的消息：真实会话消息 + 可选的 plan-control 审批条目。',
          'const visibleThreadMessages = computed<IAiChatMessage[]>(() => {',
          '  const controlMessage = planControlMessage.value;',
          '',
          '  if (!controlMessage) {',
          '    return assistant.messages.value;',
          '  }',
          '',
          '  return [...assistant.messages.value, controlMessage];',
          '});',
        ].join('\n'),
        replace: [
          '// 真正喂给平铺时间线的 entries：reduce 真源 entries + 可选的 plan-control 审批条目（渲染期 overlay）。',
          'const visibleThreadEntries = computed<readonly IAiThreadEntry[]>(() => {',
          '  const controlEntry = planControlEntry.value;',
          '',
          '  if (!controlEntry) {',
          '    return renderThreadEntries.value;',
          '  }',
          '',
          '  return [...renderThreadEntries.value, controlEntry];',
          '});',
        ].join('\n'),
      },
      {
        label: 'V5 模板：messages 改喂真实消息，thread-entries 改喂 overlay 后的 entries',
        find: [
          '      <AiChatThread :messages="visibleThreadMessages" :is-typing="assistant.isSending.value"',
          '        :thread-entries="renderThreadEntries"',
        ].join('\n'),
        replace: [
          '      <AiChatThread :messages="assistant.messages.value" :is-typing="assistant.isSending.value"',
          '        :thread-entries="visibleThreadEntries"',
        ].join('\n'),
      },
    ],
    residues: ['planControlMessage', 'visibleThreadMessages', 'buildPlanControlMessage'],
  },
  {
    file: 'src/components/business/ai/shell/AiAssistantPanel.spec.ts',
    edits: [
      {
        label: 'S1a AiChatThread 替身注释 + props 增加 threadEntries',
        find: [
          '        // 平铺时间线替身:plan 审批不再是独立面板,而是 messages 里 id 为 thread-plan-control',
          '        // 的一条条目,步骤明细由 planDetails 传入并就地渲染,审批事件向上冒泡。',
          '        AiChatThread: defineComponent({',
          "          props: ['messages', 'isTyping', 'typingLabel', 'planDetails'],",
        ].join('\n'),
        replace: [
          '        // 平铺时间线替身:plan 审批不再是独立面板,而是 thread-entries 里一条 type 为',
          '        // plan_control 的数据模型条目(渲染期 overlay),步骤明细由 planDetails 传入就地渲染,',
          '        // 审批事件向上冒泡;真实组件经 threadEntriesToTimeline 投影为 plan-control 渲染条目。',
          '        AiChatThread: defineComponent({',
          "          props: ['messages', 'threadEntries', 'isTyping', 'typingLabel', 'planDetails'],",
        ].join('\n'),
      },
      {
        label: 'S1b AiChatThread 替身模板改为从 thread-entries 渲染审批卡',
        find: specTemplateOld,
        replace: specTemplateNew,
      },
    ],
    residues: ['thread-plan-control'],
  },
];

function applyEdit(content, edit) {
  const idx = content.indexOf(edit.find);
  if (idx === -1) {
    throw new Error(`[FAIL] 锚点未命中：${edit.label}`);
  }
  if (content.indexOf(edit.find, idx + edit.find.length) !== -1) {
    throw new Error(`[FAIL] 锚点不唯一：${edit.label}`);
  }
  return content.slice(0, idx) + edit.replace + content.slice(idx + edit.find.length);
}

let touched = 0;
for (const target of plan) {
  const abs = join(repoRoot, target.file);
  const raw = readFileSync(abs, 'utf8');
  const crlf = raw.includes('\r\n');
  let text = crlf ? raw.replaceAll('\r\n', '\n') : raw;

  console.log(`\n=== ${target.file}（EOL=${crlf ? 'CRLF' : 'LF'}）===`);
  for (const edit of target.edits) {
    text = applyEdit(text, edit);
    console.log(`  ✓ ${edit.label}`);
  }

  for (const residue of target.residues ?? []) {
    if (text.includes(residue)) {
      throw new Error(`[FAIL] 残留引用未清除：「${residue}」（${target.file}）`);
    }
    console.log(`  ✓ 残留检查通过：无「${residue}」`);
  }

  const out = crlf ? text.replaceAll('\n', '\r\n') : text;
  if (apply) {
    writeFileSync(abs, out, 'utf8');
    console.log('  → 已写盘');
  } else {
    console.log('  → 预演（未写盘）');
  }
  touched += 1;
}

console.log(
  apply
    ? `\n完成：已修改 ${touched} 个文件。请运行 pnpm vitest run 与 pnpm -s vue-tsc --noEmit 验证。`
    : `\n预演完成：${touched} 个文件锚点全部命中。加 --apply 实际写盘。`,
);
