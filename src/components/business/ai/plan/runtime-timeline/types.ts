import type { TAiRuntimeToolKind } from '@/constants/ai/runtime-tools';
import type { TAgentRuntimeEvent } from '@/types/ai/sidecar';

export type TTaskIcon =
  | TAiRuntimeToolKind
  | 'file'
  | 'files'
  | 'folder'
  | 'patch'
  | 'globe'
  | 'play'
  | 'book'
  | 'chart'
  | 'brain'
  | 'image'
  | 'clock'
  | 'catalog'
  | 'check'
  | 'note'
  | 'log'
  | 'plug'
  | 'bug'
  | 'alert';

export type TTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface IWebSearchSourceChip {
  url: string;
  host: string;
  displayUrl: string;
}

export interface ITaskNodeItem {
  id: string;
  kind: TAiRuntimeToolKind;
  icon: TTaskIcon;
  toolName?: string;
  toolUseId?: string;
  resourceLabel?: string;
  suppressMeta?: boolean;
  webSearchSources?: IWebSearchSourceChip[];
  action: string;
  tags: string[];
  status: TTaskStatus;
  tail?: string;
  shimmerAction?: boolean;
  terminalOutput?: string;
  terminalTitle?: string;
  terminalStreaming?: boolean;
}

export type TTimelineItem =
  | {
      type: 'reasoning';
      id: string;
      segments: string[];
      isLong: boolean;
    }
  | {
      type: 'event';
      id: string;
      text: string;
    }
  | {
      type: 'task';
      id: string;
      node: ITaskNodeItem;
    };

export type TToolRuntimeEvent = Extract<
  TAgentRuntimeEvent,
  {
    type: 'agent.tool.started' | 'agent.tool.completed' | 'agent.tool.progress';
  }
>;

/** 工具生命周期事件(开始 / 完成),描述与图标解析的核心入参类型。 */
export type TToolLifecycleEvent = Extract<
  TToolRuntimeEvent,
  { type: 'agent.tool.started' | 'agent.tool.completed' }
>;

export type TToolProgressEvent = Extract<TToolRuntimeEvent, { type: 'agent.tool.progress' }>;

export type TToolCompletedEvent = Extract<TToolRuntimeEvent, { type: 'agent.tool.completed' }>;

export type TTokenBudgetRuntimeEvent = Extract<
  TAgentRuntimeEvent,
  { type: 'acontext.token.checked' }
>;

export type TProviderPayloadRuntimeEvent = Extract<
  TAgentRuntimeEvent,
  { type: 'acontext.provider_payload.checked' }
>;

export interface IToolIconMatcher {
  icon: TTaskIcon;
  patterns: RegExp[];
}

export interface IToolActionDescriptor {
  action: string;
  resourceLabel?: string;
  suppressMeta?: boolean;
  webSearchSources?: IWebSearchSourceChip[];
}

export type TInlineMarkdownTokenKind = 'text' | 'strong' | 'emphasis' | 'code';

export type TReasoningMarkdownBlockKind =
  | 'paragraph'
  | 'heading'
  | 'unordered-list'
  | 'ordered-list'
  | 'quote'
  | 'code-block';

export interface IInlineMarkdownToken {
  kind: TInlineMarkdownTokenKind;
  text: string;
}

export interface IReasoningMarkdownBlock {
  type: TReasoningMarkdownBlockKind;
  id: string;
  text?: string;
  items?: string[];
  code?: string;
  language?: string;
  info?: string;
}
