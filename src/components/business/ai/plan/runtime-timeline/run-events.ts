import { tokenNumberFormatter } from './constants';
import type { TProviderPayloadRuntimeEvent, TTokenBudgetRuntimeEvent } from './types';
import type { TAgentRuntimeEvent } from '@/types/ai/sidecar';

const formatOptionalNumber = (value: number | undefined): string | null =>
  typeof value === 'number' && Number.isFinite(value) ? tokenNumberFormatter.format(value) : null;

const describeLargestTokenBudgetSource = (event: TTokenBudgetRuntimeEvent): string | null => {
  const candidates = [
    { label: '工具 schema', value: event.toolSchemaCharCount },
    { label: '消息', value: event.messageCharCount },
    { label: '系统提示', value: event.systemPromptCharCount },
    { label: 'UI 上下文', value: event.contextCharCount },
  ]
    .filter(
      (candidate): candidate is { label: string; value: number } =>
        typeof candidate.value === 'number' &&
        Number.isFinite(candidate.value) &&
        candidate.value > 0,
    )
    .sort((left, right) => right.value - left.value);

  const largest = candidates[0];

  if (!largest) {
    return null;
  }

  return `最大来源：${largest.label} ${tokenNumberFormatter.format(largest.value)} 字符`;
};

const describeTokenBudgetEvent = (event: TTokenBudgetRuntimeEvent): string => {
  const segments = [
    event.projectedInputTokensAvailable
      ? `上下文预算检查，预计输入 token：${formatOptionalNumber(event.projectedInputTokens) ?? '未知'}`
      : '上下文预算检查完成',
    describeLargestTokenBudgetSource(event),
  ];
  const toolCount = formatOptionalNumber(event.toolCount);
  const mcpToolCount = formatOptionalNumber(event.mcpToolCount);

  if (toolCount) {
    segments.push(
      mcpToolCount ? `工具 ${toolCount} 个（MCP ${mcpToolCount} 个）` : `工具 ${toolCount} 个`,
    );
  }

  return segments.filter((segment): segment is string => Boolean(segment)).join('；');
};

const describeProviderPayloadEvent = (event: TProviderPayloadRuntimeEvent): string => {
  const segments = [
    `DeepSeek 实际请求 #${event.requestIndex}，预计输入 token：${formatOptionalNumber(event.projectedInputTokens) ?? '未知'}`,
    `body ${formatOptionalNumber(event.requestBodyCharCount) ?? '未知'} 字符`,
    `消息 ${formatOptionalNumber(event.messageCharCount) ?? '0'} 字符`,
    event.toolCount > 0
      ? `工具 schema ${formatOptionalNumber(event.toolSchemaCharCount) ?? '0'} 字符（${formatOptionalNumber(event.toolCount) ?? '0'} 个）`
      : null,
    event.responseFormatCharCount > 0
      ? `结构化输出 ${formatOptionalNumber(event.responseFormatCharCount) ?? '0'} 字符`
      : null,
    event.reasoningReplayCharCount > 0
      ? `reasoning 回填 ${formatOptionalNumber(event.reasoningReplayCharCount) ?? '0'} 字符`
      : null,
  ];

  return segments.filter((segment): segment is string => Boolean(segment)).join('；');
};

export const describeRunEvent = (event: TAgentRuntimeEvent): string | null => {
  switch (event.type) {
    case 'agent.run.started':
      return null;

    case 'agent.run.completed':
      return null;

    case 'agent.run.error':
      return `Agent 执行失败：${event.errorMessage}`;

    case 'agent.model.started':
      return event.projectedInputTokensAvailable
        ? `模型调用开始，预计输入 token：${event.projectedInputTokens ?? 0}`
        : '模型调用开始';

    case 'agent.model.completed':
      return event.ok
        ? `模型调用完成${event.stopReason ? `（${event.stopReason}）` : ''}`
        : `模型调用失败：${event.errorMessage ?? '未知错误'}`;

    case 'acontext.token.checked':
      return describeTokenBudgetEvent(event);

    case 'acontext.provider_payload.checked':
      return describeProviderPayloadEvent(event);

    case 'agent.text.delta':
    case 'agent.tool.progress':
      return null;

    case 'agent.message.added':
      return event.role ? `追加消息：${event.role}` : '已追加消息';

    case 'agent.debug':
      return event.name ? `调试事件：${event.name}` : null;

    default:
      return null;
  }
};
