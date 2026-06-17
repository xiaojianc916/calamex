/**
 * 把 `IAiChatMessage[]` 投影成平铺会话时间线条目 `TAiThreadEntry[]`。
 *
 * 核心思路(对齐 Zed `acp_thread`):一条 assistant 消息被展开成多条按时间顺序
 * 排列的条目——推理、工具调用、上下文整理、最终文本、Plan 控制、改动汇总。三种
 * 工具来源(运行时 / ACP / wire)统一收敛到协议 VM `IAiThreadToolCall`,经
 * `toAiThreadToolView` 渲染,不再并存渲染 VM:
 * - 运行时:复用 `buildTimelineItems`(推理缓冲、`toolUseId` 关联、终端重建等),
 *   再经 `fromRuntimeToolCall` 收敛到协议 VM;
 * - ACP:`message.acpToolCalls` 已是协议 VM(from-acp-* 累加器归一),直接包裹;
 * - Chat(wire):`message.toolCalls` 经 `fromWireToolCall` 映射。
 */
import {
  buildAiPatchPreviewFiles,
  formatAiPatchDisplayPath,
} from '@/components/business/ai/edit/patch-preview';
import {
  buildTimelineItems,
  describeRunEvent,
  type TTimelineItem,
} from '@/components/business/ai/plan/runtime-timeline';
import type { IAiChatMessage, IAiPatchSet, IAiToolCall } from '@/types/ai';
import type {
  IAiAgentChangedFile,
  IAiAgentPatchSummary,
  IAiDiffEditorPreview,
  IAiDiffHunkPreview,
} from '@/types/ai/patch';
import type { TAgentRuntimeEvent } from '@/types/ai/sidecar';
import type { IAiThreadToolCall } from '@/types/ai/thread';

import type {
  IAiThreadContextCompactionEntry,
  IAiThreadToolCallEntry,
  TAiThreadEntry,
} from './entry-types';
import { fromRuntimeToolCall } from './from-runtime-tool-call';
import { fromWireToolCall } from './from-wire-tool-call';

/** 工具调用是否引用某文件(标题里出现完整路径或文件名)。 */
const toolCallReferencesPath = (toolCall: IAiThreadToolCall, filePath: string): boolean => {
  const fileName = filePath.split(/[\\/]/u).pop() ?? filePath;
  return toolCall.title.includes(filePath) || toolCall.title.includes(fileName);
};

/** 编辑类工具(协议 kind=edit);用于无法按路径关联时的兜底归属。 */
const isEditLikeToolCall = (toolCall: IAiThreadToolCall): boolean => toolCall.kind === 'edit';

/**
 * 从本消息补丁集中解析「路径 → hunk」。复用「已更改文件」汇总卡片完全一致的
 * `buildAiPatchPreviewFiles`,避免内联 diff 与汇总卡片行为漂移(不另造解析)。
 * 仅按路径键匹配,不依赖 workspaceRootPath(其只影响展示路径,不影响 hunk 与键)。
 */
const resolveHunksByPath = (
  patches: readonly IAiPatchSet[],
): Map<string, IAiDiffHunkPreview[]> => {
  const byPath = new Map<string, IAiDiffHunkPreview[]>();
  for (const patch of patches) {
    for (const previewFile of buildAiPatchPreviewFiles(patch, undefined)) {
      for (const key of [previewFile.path, previewFile.displayPath]) {
        const normalized = formatAiPatchDisplayPath(key);
        byPath.set(normalized, [...(byPath.get(normalized) ?? []), ...previewFile.hunks]);
      }
    }
  }
  return byPath;
};

/** 改动文件 → 协议 diff 预览(复用 `aiDiffEditorPreview`,不另造 diff 模型)。 */
const buildDiffPreview = (
  file: IAiAgentChangedFile,
  summary: IAiAgentPatchSummary,
  hunksByPath: Map<string, IAiDiffHunkPreview[]>,
): IAiDiffEditorPreview => ({
  id: `${summary.id}:${file.path}`,
  title: file.path,
  filePath: file.path,
  diffRef: file.diffRef,
  patchRef: summary.patchRef,
  runId: summary.runId,
  stepId: summary.stepId,
  hunks: hunksByPath.get(formatAiPatchDisplayPath(file.path)) ?? [],
});

/**
 * 把改动文件作为内联 diff 内容挂到产生它的工具调用上(对齐 Zed:Diff 是 ToolCall
 * 的子内容,且自带 hunks)。优先按路径精确关联;关联不上时归到最后一个编辑类工具
 * 调用;再不行则仅在末尾汇总条目中呈现。
 */
const attachDiffsToToolEntries = (
  toolEntries: readonly IAiThreadToolCallEntry[],
  summary: IAiAgentPatchSummary,
  patches: readonly IAiPatchSet[],
): void => {
  if (toolEntries.length === 0) {
    return;
  }
  const hunksByPath = resolveHunksByPath(patches);
  const editEntries = toolEntries.filter((entry) => isEditLikeToolCall(entry.toolCall));
  const fallback = editEntries.at(-1);

  for (const file of summary.files) {
    const target =
      toolEntries.find((entry) => toolCallReferencesPath(entry.toolCall, file.path)) ?? fallback;
    if (target === undefined) {
      continue;
    }
    target.toolCall.content.push({
      type: 'diff',
      diff: buildDiffPreview(file, summary, hunksByPath),
    });
  }
};

/** 运行时时间线 task 项 → 工具调用条目(收敛到协议 VM)。 */
const mapTaskItemToToolEntry = (
  messageId: string,
  createdAt: string,
  item: Extract<TTimelineItem, { type: 'task' }>,
): IAiThreadToolCallEntry => {
  const { toolCall, terminals, awaiting } = fromRuntimeToolCall(item.node, { createdAt });
  return {
    kind: 'tool-call',
    id: `${messageId}:${item.id}`,
    messageId,
    toolCall,
    terminals,
    awaiting,
  };
};

/** Chat 模式 wire 工具调用 → 工具调用条目(无运行时事件时使用)。 */
const mapWireToolCallToToolEntry = (
  messageId: string,
  createdAt: string,
  wireToolCall: IAiToolCall,
): IAiThreadToolCallEntry => ({
  kind: 'tool-call',
  id: `${messageId}:tool:${wireToolCall.id}`,
  messageId,
  toolCall: fromWireToolCall(wireToolCall, { createdAt }),
  terminals: {},
  awaiting: false,
});

/**
 * ACP 工具调用 → 工具调用条目。`message.acpToolCalls` 已是协议 VM(from-acp-* 累加
 * 器归一),直接包裹即可,与 runtime / wire 汇流到同一渲染管线。复制 content 数组
 * 以免内联 diff 时回写共享输入对象。
 */
const mapAcpToolCallToToolEntry = (
  messageId: string,
  toolCall: IAiThreadToolCall,
): IAiThreadToolCallEntry => ({
  kind: 'tool-call',
  id: `${messageId}:acp:${toolCall.id}`,
  messageId,
  toolCall: { ...toolCall, content: [...toolCall.content] },
  terminals: {},
  awaiting: false,
});

/**
 * 从运行时事件中提取“上下文整理完成”为独立条目(对齐 Zed ContextCompaction)。
 * 其余运行生命周期播报(模型开始 / 完成、消息追加、调试等)在平铺时间线里属于
 * 噪声,统一丢弃,以保持信息密度与视觉整洁。
 */
const extractContextCompactionEntries = (
  messageId: string,
  events: readonly TAgentRuntimeEvent[],
): IAiThreadContextCompactionEntry[] => {
  const entries: IAiThreadContextCompactionEntry[] = [];
  for (const event of events) {
    if (event.type !== 'acontext.context_compaction.completed') {
      continue;
    }
    const text = describeRunEvent(event);
    if (text === null) {
      continue;
    }
    entries.push({
      kind: 'context-compaction',
      id: `${messageId}:compaction:${event.id}`,
      messageId,
      text,
    });
  }
  return entries;
};

/** 把一条 assistant 消息展开成多条平铺条目。 */
const buildAssistantEntries = (message: IAiChatMessage): TAiThreadEntry[] => {
  const entries: TAiThreadEntry[] = [];
  const streaming = message.stream?.status === 'streaming';
  const runtimeEvents = message.stream?.runtimeEvents ?? [];
  // 收集本消息内的工具调用条目引用,稍后把改动 diff 原地挂到对应条目上。
  const toolEntries: IAiThreadToolCallEntry[] = [];

  if (runtimeEvents.length > 0) {
    const waitingConfirmation = message.stream?.status === 'waiting-confirmation';
    const timelineItems = buildTimelineItems(runtimeEvents, waitingConfirmation);
    for (const item of timelineItems) {
      if (item.type === 'reasoning') {
        entries.push({
          kind: 'reasoning',
          id: `${message.id}:${item.id}`,
          messageId: message.id,
          segments: item.segments,
          isLong: item.isLong,
          streaming,
        });
      } else if (item.type === 'task') {
        const toolEntry = mapTaskItemToToolEntry(message.id, message.createdAt, item);
        toolEntries.push(toolEntry);
        entries.push(toolEntry);
      }
      // item.type === 'event':运行生命周期噪声,详见 extractContextCompactionEntries 注释。
    }
    entries.push(...extractContextCompactionEntries(message.id, runtimeEvents));
  } else if (message.acpToolCalls !== undefined && message.acpToolCalls.length > 0) {
    // ACP openWorld 后端:工具调用已由 from-acp-* 累加器归一到协议 VM,直接包裹复用
    // 同一渲染管线。优先于 wire toolCalls:ACP 源更富(kind / diff / terminal)。
    for (const acpToolCall of message.acpToolCalls) {
      const toolEntry = mapAcpToolCallToToolEntry(message.id, acpToolCall);
      toolEntries.push(toolEntry);
      entries.push(toolEntry);
    }
  } else if (message.toolCalls !== undefined) {
    for (const toolCall of message.toolCalls) {
      const toolEntry = mapWireToolCallToToolEntry(message.id, message.createdAt, toolCall);
      toolEntries.push(toolEntry);
      entries.push(toolEntry);
    }
  }

  if (message.content.trim().length > 0) {
    entries.push({
      kind: 'assistant-text',
      id: `${message.id}:text`,
      messageId: message.id,
      markdown: message.content,
      streaming,
    });
  }

  if (message.agentConfirmation !== undefined) {
    entries.push({
      kind: 'plan-control',
      id: `${message.id}:plan-control`,
      messageId: message.id,
      goal: message.agentConfirmation.goal,
      references: message.agentConfirmation.references,
      phase: message.agentConfirmation.status === 'running' ? 'running' : 'awaiting-approval',
    });
  }

  if (message.changedFilesSummary !== undefined) {
    attachDiffsToToolEntries(toolEntries, message.changedFilesSummary, message.patches ?? []);
    entries.push({
      kind: 'changed-files-summary',
      id: `${message.id}:changed-files`,
      messageId: message.id,
      summary: message.changedFilesSummary,
    });
  }

  return entries;
};

/**
 * 把整条会话投影成平铺时间线条目。
 *
 * - `user`:一条用户消息条目(空白消息跳过)。
 * - `assistant`:展开成 推理 / 工具调用 / 上下文整理 / 最终文本 / Plan 控制 /
 *   改动汇总 等多条条目。
 * - `system` / `tool`:不单独呈现(工具结果已并入 assistant 的工具行,system
 *   提示不面向用户)。
 */
export const buildThreadEntries = (messages: readonly IAiChatMessage[]): TAiThreadEntry[] => {
  const entries: TAiThreadEntry[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        if (message.content.trim().length === 0) {
          break;
        }
        entries.push({
          kind: 'user-message',
          id: `${message.id}:user`,
          messageId: message.id,
          markdown: message.content,
          references: message.references,
        });
        break;
      }
      case 'assistant': {
        entries.push(...buildAssistantEntries(message));
        break;
      }
      default:
        break;
    }
  }
  return entries;
};
