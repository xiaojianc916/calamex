export type TAgentMode = 'ask' | 'plan' | 'agent' | 'patch' | 'review';

export interface IAgentMessageInput {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

export interface IAgentContextReferenceInput {
  id: string;
  kind: string;
  label: string;
  path: string | null;
  range: {
    startLine: number;
    endLine: number;
  } | null;
  contentPreview: string;
  redacted: boolean;
}

export interface IAgentRuntimeInput {
  sessionId?: string;
  mode: TAgentMode;
  goal: string;
  messages: IAgentMessageInput[];
  workspaceRootPath?: string;
  context?: IAgentContextReferenceInput[];
}

export interface IApprovalResolutionInput {
  requestId: string;
  decision: string;
  sessionId?: string | undefined;
}