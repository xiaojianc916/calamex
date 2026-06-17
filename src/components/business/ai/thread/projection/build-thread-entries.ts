/**
 * 把 `IAiChatMessage[]` 投影成平铺会话时间线条目 `TAiThreadEntry[]`。
 *
 * 核心思路(对齐 Zed `acp_thread`):一条 assistant 消息被展开成多条按时间顺序
 * 排列的条目——推理、工具调用、上下文整理、最终文本、Plan 控制、改动汇总——
 * 而不是塞进一个气泡 / 卡片。运行时活动复用既有 `buildTimelineItems`(推理缓冲、
 * 工具 `toolUseId` 关联、终端重建等复杂逻辑全部沿用,不重新发明);ACP openWorld
 * 后端(如 Kimi)的工具调用经 from-acp-* 累加器归一到协议 VM 后,由适配器复用同一
 * 渲染管线;Chat 模式下无运行时事件,则直接映射 `message.toolCalls`,从而多种模式
 * 共用同一渲染管线。
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
import { buildAcpThreadToolEntries } from './from-acp-thread-entry';

/** 取文件路径的末段(文件名),用于把改动 diff 关联到对应工具调用条目。 */
const fileNameOf = (filePath: string): string => {
  const segments = filePath.split(/[\\/]/u);
  return segments[segments.length - 1] ?? filePath;
};

const isNonEmpty = (value: string | undefined): value is string => Boolean(value?.trim());

const parseJsonRecord = (value: string | undefined): Record<string, unknown> | null => {
  if (!isNonEmpty(value)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const stringifyCandidate = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const getFirstStringField = (
  record: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined => {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = stringifyCandidate(record[key]);

    if (value) {
      return value;
    }
  }

  return undefined;
};

const humanizeToolName = (toolName: string): string =>
  toolName
    .replace(/^mcp_/u, '')
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^./u, (character) => character.toUpperCase());

/**
 * Zed 风格工具标题的结构化表示:`verb` 为动作动词,`argument` 为其参数
 * (路径 / 命令 / 正则等)。渲染层据此作“动词 + 参数 code chip”两段式展示。
 */
interface IZedToolLabel {
  verb: string;
  argument?: string;
}

/** 结构化标题 → 完整标题字符串(作为可访问名称与按路径关联 diff 的唯一依据)。 */
const labelTitle = (label: IZedToolLabel): string =>
  label.argument === undefined ? label.verb : `${label.verb} ${label.argument}`;

const buildZedToolLabel = (
  toolName: string | undefined,
  fallback: string,
  rawInput?: string,
): IZedToolLabel => {
  if (!toolName) {
    return { verb: fallback };
  }

  const normalized = toolName.toLowerCase();
  const input = parseJsonRecord(rawInput);
  const regex = getFirstStringField(input, ['regex', 'pattern']);
  const query = getFirstStringField(input, ['query', 'search', 'text']);
  const path = getFirstStringField(input, [
    'path',
    'filePath',
    'file',
    'include_pattern',
    'includePattern',
  ]);
  const command = getFirstStringField(input, ['command', 'cmd', 'script']);
  const url = getFirstStringField(input, ['url', 'href']);

  if (
    /(grep|search_text|search_files|file_search|semantic_search|mastra_workspace_grep)/u.test(
      normalized,
    )
  ) {
    if (regex) {
      return { verb: 'Search files for regex', argument: regex };
    }

    if (query) {
      return { verb: 'Search files for', argument: query };
    }
  }

  if (/search_symbols|listcodeusages|renamesymbol/u.test(normalized)) {
    return {
      verb: 'Search symbols for',
      argument: query ?? regex ?? path ?? humanizeToolName(toolName),
    };
  }

  if (/read.*file|read_text_file|read_file_window|get_file_info/u.test(normalized)) {
    return { verb: 'Read file', argument: path ?? query ?? humanizeToolName(toolName) };
  }

  if (/list_dir|list_directory|directory_tree|list_workspace_entries/u.test(normalized)) {
    return { verb: 'List directory', argument: path ?? humanizeToolName(toolName) };
  }

  if (
    /write_file|create_file|edit_file|apply_patch|apply_file_edits|workspace_edit|workspace_write/u.test(
      normalized,
    )
  ) {
    return { verb: 'Edit file', argument: path ?? query ?? humanizeToolName(toolName) };
  }

  if (/run_command|run_in_terminal|execute_command|send_to_terminal/u.test(normalized)) {
    return { verb: 'Run command', argument: command ?? humanizeToolName(toolName) };
  }

  if (/web_search|tavily|search_web/u.test(normalized)) {
    return { verb: 'Search the web for', argument: query ?? regex ?? humanizeToolName(toolName) };
  }

  if (/fetch|browser|navigate/u.test(normalized)) {
    return { verb: 'Open', argument: url ?? query ?? humanizeToolName(toolName) };
  }

  return { verb: humanizeToolName(toolName) };
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

const pushRawContent = (
  content: TAiThreadToolContent[],
  id: string,
  title: 'Raw Input' | 'Output',
  code: string | undefined,
): void => {
  if (!isNonEmpty(code)) {
    return;
  }

  content.push({
    type: 'raw',
    id,
    title,
    code,
  });
};

/** 运行时任务节点 → 工具调用展开内容(原始输入输出 / 终端;Diff 另行按改动汇总关联)。 */
const buildToolContentFromNode = (node: ITaskNodeItem): TAiThreadToolContent[] => {
  const content: TAiThreadToolContent[] = [];

  pushRawContent(content, `${node.id}:raw-input`, 'Raw Input', node.rawInput);
  pushRawContent(content, `${node.id}:raw-output`, 'Output', node.rawOutput);

  if (node.terminalOutput !== undefined && node.terminalOutput.length > 0) {
    content.push({
      type: 'terminal',
      id: `${node.id}:terminal`,
      title: node.terminalTitle ?? 'Terminal',
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
  const label = buildZedToolLabel(node.toolName, node.action, node.rawInput);
  return {
    kind: 'tool-call',
    id: `${messageId}:${item.id}`,
    messageId,
    toolName: node.toolName,
    icon: node.icon,
    title: labelTitle(label),
    titleVerb: label.verb,
    titleArgument: label.argument,
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
  const summary = toolCall.summary.trim();
  const fallback = summary.length > 0 ? summary : toolCall.name;
  const label = summary.length > 0 ? { verb: summary } : buildZedToolLabel(toolCall.name, fallback);
  return {
    kind: 'tool-call',
    id: `${messageId}:tool:${toolCall.id}`,
    messageId,
    toolName: toolCall.name,
    // 复用项目既有图标解析;'system' 是合法的运行时工具大类兜底。
    icon: resolveRuntimeToolIcon(toolCall.name, 'system'),
    title: labelTitle(label),
    titleVerb: label.verb,
    titleArgument: label.argument,
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
  } else if (message.acpToolCalls !== undefined && message.acpToolCalls.length > 0) {
    // ACP openWorld 后端:工具调用已由 from-acp-* 累加器归一到协议 VM,经适配器复用
    // 同一渲染 VM(对齐 Mastra 路径,不重复造解析)。优先于 wire toolCalls:ACP
    // 源更富(kind / diff / terminal)。
    for (const toolEntry of buildAcpThreadToolEntries(message.id, message.acpToolCalls)) {
      toolEntries.push(toolEntry);
      entries.push(toolEntry);
    }
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
