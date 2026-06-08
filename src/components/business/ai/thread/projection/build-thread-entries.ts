/**
 * 把 `IAiChatMessage[]` 投影成平铺会话时间线条目 `TAiThreadEntry[]`。
 *
 * 核心思路(对齐 Zed `acp_thread`):一条 assistant 消息被展开成多条按时间顺序
 * 排列的条目——推理、工具调用、上下文整理、最终文本、Plan 控制、改动汇总——
 * 而不是塞进一个气泡 / 卡片。运行时活动复用既有 `buildTimelineItems`(推理缓冲、
 * 工具 `toolUseId` 关联、终端重建等复杂逻辑全部沿用,不重新发明);Chat 模式下无
 * 运行时事件,则直接映射 `message.toolCalls`,从而三种模式共用同一渲染管线。
 */
import {
  APPLY_FILE_EDIT_TOOL_NAMES,
  buildTimelineItems,
  describeRunEvent,
  type ITaskNodeItem,
  resolveRuntimeToolIcon,
  type TTimelineItem,
  WAITING_DECISION_LABEL,
  WRITE_FILE_TOOL_NAMES,
} from '@/components/business/ai/plan/runtime-timeline';
import type { IAiChatMessage, IAiToolCall } from '@/types/ai';
import type { IAiAgentPatchSummary } from '@/types/ai/patch';
import type { TAgentRuntimeEvent } from '@/types/ai/sidecar';

import type {
  IAiThreadContextCompactionEntry,
  IAiThreadToolCallEntry,
  TAiThreadEntry,
  TAiThreadToolContent,
  TAiThreadToolStatus,
} from './entry-types';

/** 取文件路径的末段(文件名),用于把改动 diff 关联到对应工具调用条目。 */
const fileNameOf = (filePath: string): string => {
  const segments = filePath.split(/[\\/]/u);
  return segments[segments.length - 1] ?? filePath;
};

/** 工具名是否属于“写入 / 编辑”类(用于无法按路径关联时的兜底归属)。 */
const isEditLikeToolName = (toolName: string | undefined): boolean => {
  if (toolName === undefined) {
    return false;
  }
  const normalized = toolName.toLowerCase();
  return WRITE_FILE_TOOL_NAMES.has(normalized) || APPLY_FILE_EDIT_TOOL_NAMES.has(normalized);
};

/** 工具调用条目是否引用了某文件路径(标题或标签里出现完整路径 / 文件名)。 */
const entryReferencesPath = (entry: IAiThreadToolCallEntry, filePath: string): boolean => {
  const name = fileNameOf(filePath);
  if (entry.title.includes(filePath) || entry.title.includes(name)) {
    return true;
  }
  return entry.tags.some((tag) => tag.includes(filePath) || tag.includes(name));
};

/**
 * 把改动文件作为内联 Diff 内容挂到产生它的工具调用条目上(对齐 Zed:Diff 是
 * ToolCall 的子内容)。优先按路径精确关联;关联不上时归到最后一个写入类工具
 * 调用;再不行则仅在末尾汇总条目中呈现。
 */
const attachDiffsToToolEntries = (
  toolEntries: IAiThreadToolCallEntry[],
  summary: IAiAgentPatchSummary,
): void => {
  if (toolEntries.length === 0) {
    return;
  }
  const editEntries = toolEntries.filter((entry) => isEditLikeToolName(entry.toolName));
  const fallbackEntry = editEntries.length > 0 ? editEntries[editEntries.length - 1] : undefined;

  for (const file of summary.files) {
    const target =
      toolEntries.find((entry) => entryReferencesPath(entry, file.path)) ?? fallbackEntry;
    if (target === undefined) {
      continue;
    }
    target.content.push({
      type: 'diff',
      id: `${summary.id}:${file.path}`,
      file,
      patchSummaryId: summary.id,
    });
  }
};

/** 运行时任务节点 → 工具调用状态。等待决策对应 Zed `WaitingForConfirmation`。 */
const resolveToolStatusFromNode = (node: ITaskNodeItem): TAiThreadToolStatus => {
  if (node.shimmerAction === true && node.action === WAITING_DECISION_LABEL) {
    return 'awaiting-confirmation';
  }
  return node.status;
};

/** 运行时任务节点 → 工具调用展开内容(此处仅终端;Diff 另行按改动汇总关联)。 */
const buildToolContentFromNode = (node: ITaskNodeItem): TAiThreadToolContent[] => {
  const content: TAiThreadToolContent[] = [];
  if (node.terminalOutput !== undefined && node.terminalOutput.length > 0) {
    content.push({
      type: 'terminal',
      id: `${node.id}:terminal`,
      title: node.terminalTitle ?? '终端',
      output: node.terminalOutput,
      streaming: node.terminalStreaming ?? false,
    });
  }
  return content;
};

/** 运行时时间线 task 项 → 工具调用条目。 */
const mapTaskItemToToolEntry = (
  messageId: string,
  item: Extract<TTimelineItem, { type: 'task' }>,
): IAiThreadToolCallEntry => {
  const { node } = item;
  return {
    kind: 'tool-call',
    id: `${messageId}:${item.id}`,
    messageId,
    toolName: node.toolName,
    icon: node.icon,
    title: node.action,
    tags: node.tags,
    tail: node.tail,
    status: resolveToolStatusFromNode(node),
    content: buildToolContentFromNode(node),
    webSearchSources: node.webSearchSources,
    suppressMeta: node.suppressMeta,
  };
};

/** Chat 模式 wire 工具调用 → 工具调用条目(无运行时事件时使用)。 */
const mapWireToolCallToToolEntry = (
  messageId: string,
  toolCall: IAiToolCall,
): IAiThreadToolCallEntry => {
  const title = toolCall.summary.trim().length > 0 ? toolCall.summary : toolCall.name;
  return {
    kind: 'tool-call',
    id: `${messageId}:tool:${toolCall.id}`,
    messageId,
    toolName: toolCall.name,
    // 复用项目既有图标解析;'system' 是合法的运行时工具大类兜底。
    icon: resolveRuntimeToolIcon(toolCall.name, 'system'),
    title,
    tags: toolCall.targetPreview !== undefined ? [toolCall.targetPreview] : [],
    status: toolCall.status,
    content: [],
  };
};

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
        const toolEntry = mapTaskItemToToolEntry(message.id, item);
        toolEntries.push(toolEntry);
        entries.push(toolEntry);
      }
      // item.type === 'event':运行生命周期噪声,详见 extractContextCompactionEntries 注释。
    }
    entries.push(...extractContextCompactionEntries(message.id, runtimeEvents));
  } else if (message.toolCalls !== undefined) {
    for (const toolCall of message.toolCalls) {
      const toolEntry = mapWireToolCallToToolEntry(message.id, toolCall);
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
    attachDiffsToToolEntries(toolEntries, message.changedFilesSummary);
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
