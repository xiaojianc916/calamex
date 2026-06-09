import { classifyRuntimeToolKind, normalizeRuntimeToolName } from '@/constants/ai/runtime-tools';
import type { TAgentRuntimeEvent } from '@/types/ai/sidecar';
import {
  COMMAND_TOOL_NAMES,
  HIDDEN_RUNTIME_EVENT_TYPES,
  MAX_TOOL_TAGS,
  WAITING_DECISION_LABEL,
} from './constants';
import {
  parseCommandProgressPreview,
  parsePreviewValue,
  resolveCommandTerminalOutput,
} from './preview';
import { splitReasoningSegments } from './reasoning-markdown';
import { describeRunEvent } from './run-events';
import { isNonEmptyString } from './text';
import { isMcpListToolsName, resolveRuntimeToolIcon, resolveToolEventIcon } from './tool-icons';
import { describeToolAction } from './tool-presenters';
import type { ITaskNodeItem, TTimelineItem, TToolRuntimeEvent } from './types';
import { isWebSearchToolName, mergeWebSearchSources, resolveWebSearchSources } from './web-search';

export const createEventKey = (
  event: Pick<TAgentRuntimeEvent, 'id' | 'type'>,
  index: number,
): string => `${event.type}:${event.id}:${index}`;

export const getStableRuntimeEvents = (
  events: readonly TAgentRuntimeEvent[],
): TAgentRuntimeEvent[] => {
  const deduped = new Map<string, TAgentRuntimeEvent>();

  for (const event of events) {
    if (!deduped.has(event.id)) {
      deduped.set(event.id, event);
    }
  }

  return Array.from(deduped.values());
};

export const isToolEvent = (event: TAgentRuntimeEvent): event is TToolRuntimeEvent =>
  event.type === 'agent.tool.started' ||
  event.type === 'agent.tool.completed' ||
  event.type === 'agent.tool.progress';

export const createToolNode = (
  event: TToolRuntimeEvent,
  eventIndex: number,
  previousNode?: ITaskNodeItem,
): ITaskNodeItem => {
  const id = createEventKey(event, eventIndex);

  if (event.type === 'agent.tool.progress') {
    const progressToolName = event.toolName
      ? normalizeRuntimeToolName(event.toolName)
      : previousNode?.toolName;
    const commandProgress = COMMAND_TOOL_NAMES.has(progressToolName ?? '')
      ? parseCommandProgressPreview(event.dataPreview)
      : null;
    const webSearchSources = mergeWebSearchSources(
      previousNode?.webSearchSources,
      resolveWebSearchSources(event.dataPreview),
    );

    return {
      id: previousNode?.id ?? id,
      kind: previousNode?.kind ?? 'thinking',
      icon: previousNode?.icon ?? 'brain',
      toolName: progressToolName,
      toolUseId: event.toolUseId ?? previousNode?.toolUseId,
      resourceLabel: previousNode?.resourceLabel,
      suppressMeta: previousNode?.suppressMeta,
      webSearchSources,
      action: previousNode?.action ?? '工具执行中',
      tags: previousNode?.suppressMeta ? [] : parsePreviewValue(event.dataPreview),
      status: 'running',
      tail: previousNode?.tail,
      terminalOutput: commandProgress
        ? `${previousNode?.terminalOutput ?? ''}${commandProgress.output}`
        : previousNode?.terminalOutput,
      terminalTitle: commandProgress ? 'Windows 终端' : previousNode?.terminalTitle,
      terminalStreaming: commandProgress?.terminalStreaming ?? previousNode?.terminalStreaming,
      rawInput: previousNode?.rawInput,
      rawOutput: previousNode?.rawOutput,
    };
  }

  const kind = classifyRuntimeToolKind(event.toolName);
  const toolName = normalizeRuntimeToolName(event.toolName);
  const actionDescriptor = describeToolAction(event, toolName, previousNode?.resourceLabel);
  const icon = resolveToolEventIcon(event, toolName, resolveRuntimeToolIcon(event.toolName, kind));
  const hasStreamedCommandOutput =
    COMMAND_TOOL_NAMES.has(toolName) && isNonEmptyString(previousNode?.terminalOutput);
  const commandTerminalOutput = COMMAND_TOOL_NAMES.has(toolName)
    ? hasStreamedCommandOutput && event.type === 'agent.tool.completed'
      ? previousNode?.terminalOutput
      : resolveCommandTerminalOutput(
          event,
          actionDescriptor.resourceLabel ?? previousNode?.resourceLabel ?? '命令',
        )
    : undefined;

  if (event.type === 'agent.tool.started') {
    return {
      id: previousNode?.id ?? id,
      kind,
      icon,
      toolName,
      toolUseId: event.toolUseId,
      resourceLabel: actionDescriptor.resourceLabel,
      suppressMeta: actionDescriptor.suppressMeta,
      webSearchSources: mergeWebSearchSources(
        previousNode?.webSearchSources,
        actionDescriptor.webSearchSources,
      ),
      action: actionDescriptor.action,
      tags: actionDescriptor.suppressMeta
        ? []
        : [toolName, ...parsePreviewValue(event.inputPreview)].slice(0, MAX_TOOL_TAGS),
      status: 'running',
      tail: actionDescriptor.suppressMeta ? undefined : '执行中',
      terminalOutput: commandTerminalOutput,
      terminalTitle: COMMAND_TOOL_NAMES.has(toolName) ? 'Windows 终端' : undefined,
      terminalStreaming: COMMAND_TOOL_NAMES.has(toolName),
      rawInput: event.inputPreview,
      rawOutput: previousNode?.rawOutput,
    };
  }

  return {
    id: previousNode?.id ?? id,
    kind,
    icon,
    toolName,
    toolUseId: event.toolUseId ?? previousNode?.toolUseId,
    resourceLabel: actionDescriptor.resourceLabel,
    suppressMeta: actionDescriptor.suppressMeta,
    webSearchSources: mergeWebSearchSources(
      previousNode?.webSearchSources,
      actionDescriptor.webSearchSources,
    ),
    action: actionDescriptor.action,
    tags: actionDescriptor.suppressMeta
      ? []
      : [toolName, ...parsePreviewValue(event.resultPreview)].slice(0, MAX_TOOL_TAGS),
    status: event.ok ? 'succeeded' : 'failed',
    tail: actionDescriptor.suppressMeta
      ? undefined
      : event.ok
        ? '成功'
        : `失败：${event.errorMessage ?? '未知错误'}`,
    terminalOutput: commandTerminalOutput ?? previousNode?.terminalOutput,
    terminalTitle: COMMAND_TOOL_NAMES.has(toolName) ? 'Windows 终端' : previousNode?.terminalTitle,
    terminalStreaming: false,
    rawInput: previousNode?.rawInput,
    rawOutput: event.resultPreview ?? event.errorMessage,
  };
};

export const findPendingToolTaskIndex = (
  items: readonly TTimelineItem[],
  event: Extract<TToolRuntimeEvent, { type: 'agent.tool.completed' }>,
): number => {
  const normalizedToolName = normalizeRuntimeToolName(event.toolName);

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (item.type !== 'task') {
      continue;
    }

    const { node } = item;

    if (node.status !== 'running' || !node.toolName) {
      continue;
    }

    if (isMcpListToolsName(node.toolName) && isMcpListToolsName(normalizedToolName)) {
      return index;
    }

    if (event.toolUseId && node.toolUseId === event.toolUseId) {
      return index;
    }

    if (!event.toolUseId && node.toolName === normalizedToolName) {
      return index;
    }
  }

  return -1;
};

export const findPendingCommandTaskIndex = (
  items: readonly TTimelineItem[],
  event: Extract<TToolRuntimeEvent, { type: 'agent.tool.progress' }>,
): number => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (
      item.type === 'task' &&
      item.node.status === 'running' &&
      COMMAND_TOOL_NAMES.has(item.node.toolName ?? '') &&
      (!event.toolUseId || item.node.toolUseId === event.toolUseId)
    ) {
      return index;
    }
  }

  return -1;
};

export const findPendingWebSearchTaskIndex = (items: readonly TTimelineItem[]): number => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (
      item.type === 'task' &&
      item.node.status === 'running' &&
      isWebSearchToolName(item.node.toolName)
    ) {
      return index;
    }
  }

  return -1;
};

export const findAdjacentWebSearchTaskIndex = (items: readonly TTimelineItem[]): number => {
  const item = items.at(-1);

  return item?.type === 'task' && isWebSearchToolName(item.node.toolName) ? items.length - 1 : -1;
};

export const buildTimelineItems = (
  events: readonly TAgentRuntimeEvent[],
  isWaitingConfirmation: boolean,
): TTimelineItem[] => {
  const stableEvents = getStableRuntimeEvents(events);
  const items: TTimelineItem[] = [];
  let reasoningBuffer = '';
  let reasoningBufferId = '';

  const getReasoningOverlapLength = (previous: string, incoming: string): number => {
    const maxLength = Math.min(previous.length, incoming.length);

    for (let length = maxLength; length > 0; length -= 1) {
      if (previous.slice(-length) === incoming.slice(0, length)) {
        return length;
      }
    }

    return 0;
  };

  const appendReasoningText = (incomingText: string): void => {
    if (!incomingText) {
      return;
    }

    if (!reasoningBuffer) {
      reasoningBuffer = incomingText;
      return;
    }

    if (incomingText.startsWith(reasoningBuffer)) {
      // Some providers stream cumulative snapshots (full text so far).
      reasoningBuffer = incomingText;
      return;
    }

    if (reasoningBuffer.startsWith(incomingText)) {
      // Ignore stale/shorter snapshot.
      return;
    }

    const overlapLength = getReasoningOverlapLength(reasoningBuffer, incomingText);
    reasoningBuffer += incomingText.slice(overlapLength);
  };

  const flushReasoningLine = (): void => {
    if (!reasoningBufferId || reasoningBuffer.length === 0) {
      return;
    }

    const segments = splitReasoningSegments(reasoningBuffer);

    if (segments.length > 0) {
      items.push({
        type: 'reasoning',
        id: `reasoning:${reasoningBufferId}`,
        segments,
        isLong: segments.length > 1,
      });
    }

    reasoningBuffer = '';
    reasoningBufferId = '';
  };

  stableEvents.forEach((event, eventIndex) => {
    if (event.type === 'agent.reasoning.delta') {
      if (!reasoningBufferId) {
        reasoningBufferId = createEventKey(event, eventIndex);
      }

      appendReasoningText(event.text);
      return;
    }

    if (event.type === 'agent.text.delta' || event.type === 'agent.debug') {
      return;
    }

    if (HIDDEN_RUNTIME_EVENT_TYPES.has(event.type)) {
      return;
    }

    if (isToolEvent(event)) {
      flushReasoningLine();

      if (event.type === 'agent.tool.progress') {
        if (COMMAND_TOOL_NAMES.has(normalizeRuntimeToolName(event.toolName ?? ''))) {
          const pendingTaskIndex = findPendingCommandTaskIndex(items, event);

          if (pendingTaskIndex >= 0) {
            const pendingTask = items[pendingTaskIndex];

            if (pendingTask.type === 'task') {
              pendingTask.node = createToolNode(event, eventIndex, pendingTask.node);
              return;
            }
          }
        }

        const pendingTaskIndex = findPendingWebSearchTaskIndex(items);

        if (pendingTaskIndex >= 0 && resolveWebSearchSources(event.dataPreview).length > 0) {
          const pendingTask = items[pendingTaskIndex];

          if (pendingTask.type === 'task') {
            pendingTask.node = createToolNode(event, eventIndex, pendingTask.node);
            return;
          }
        }
      }

      if (
        event.type === 'agent.tool.started' &&
        isWebSearchToolName(normalizeRuntimeToolName(event.toolName))
      ) {
        const adjacentTaskIndex = findAdjacentWebSearchTaskIndex(items);

        if (adjacentTaskIndex >= 0) {
          const adjacentTask = items[adjacentTaskIndex];

          if (adjacentTask.type === 'task') {
            adjacentTask.node = createToolNode(event, eventIndex, adjacentTask.node);
            return;
          }
        }
      }

      if (event.type === 'agent.tool.completed') {
        const pendingTaskIndex = findPendingToolTaskIndex(items, event);

        if (pendingTaskIndex >= 0) {
          const pendingTask = items[pendingTaskIndex];

          if (pendingTask.type === 'task') {
            pendingTask.node = createToolNode(event, eventIndex, pendingTask.node);
            return;
          }
        }

        if (isWebSearchToolName(normalizeRuntimeToolName(event.toolName))) {
          const adjacentTaskIndex = findAdjacentWebSearchTaskIndex(items);

          if (adjacentTaskIndex >= 0) {
            const adjacentTask = items[adjacentTaskIndex];

            if (adjacentTask.type === 'task') {
              adjacentTask.node = createToolNode(event, eventIndex, adjacentTask.node);
              return;
            }
          }
        }
      }

      if (
        (event.type === 'agent.tool.started' || event.type === 'agent.tool.completed') &&
        isMcpListToolsName(normalizeRuntimeToolName(event.toolName))
      ) {
        const existingTaskIndex = items.findIndex(
          (item) => item.type === 'task' && isMcpListToolsName(item.node.toolName),
        );

        if (existingTaskIndex >= 0) {
          const existingTask = items[existingTaskIndex];

          if (existingTask.type === 'task') {
            existingTask.node = createToolNode(event, eventIndex, existingTask.node);
            return;
          }
        }
      }

      const node = createToolNode(event, eventIndex);
      items.push({
        type: 'task',
        id: `task:${node.id}`,
        node,
      });
      return;
    }

    const message = describeRunEvent(event);

    if (message) {
      flushReasoningLine();

      items.push({
        type: 'event',
        id: `event:${createEventKey(event, eventIndex)}`,
        text: message,
      });
    }
  });

  flushReasoningLine();

  if (isWaitingConfirmation) {
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];

      if (item?.type !== 'task' || item.node.status !== 'running') {
        continue;
      }

      item.node = {
        ...item.node,
        action: WAITING_DECISION_LABEL,
        tail: undefined,
        tags: [],
        suppressMeta: true,
        shimmerAction: true,
      };
      break;
    }
  }

  return items;
};
