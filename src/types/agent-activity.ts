export const AGENT_ACTIVITY_STATUSES = [
  'pending',
  'running',
  'success',
  'error',
  'cancelled',
] as const;

export type TAgentActivityStatus = (typeof AGENT_ACTIVITY_STATUSES)[number];

export const AGENT_ACTIVITY_KINDS = [
  'run',
  'search',
  'read_file',
  'edit_file',
  'tool_call',
  'command',
  'reasoning_summary',
  'llm',
  'error',
] as const;

export type TAgentActivityKind = (typeof AGENT_ACTIVITY_KINDS)[number];

export const AGENT_ACTIVITY_SNAPSHOT_KINDS = [
  'RUN',
  'SEARCH',
  'READ_FILE',
  'EDIT_FILE',
  'TOOL_CALL',
  'COMMAND',
  'REASONING_SUMMARY',
  'LLM',
  'ERROR',
] as const;

export interface IAgentActivityDetail {
  label: string;
  value: string;
  priority?: number;
}

export interface IAgentActivityFile {
  path: string;
  basename: string;
  action: 'search' | 'read' | 'edit';
  resultCount?: number;
}

export interface IAgentActivitySearch {
  query: string;
  glob?: string;
  resultCount?: number;
}

export interface IAgentActivityTool {
  callId: string;
  name: string;
  argsSummary?: string;
}

export interface IAgentActivityCommand {
  command: string;
  cwd?: string;
  exitCode?: number;
}

export interface IAgentActivityError {
  name?: string;
  message: string;
}

export interface IAgentActivity {
  id: string;
  runId: string;
  parentId?: string;
  kind: TAgentActivityKind;
  status: TAgentActivityStatus;
  title: string;
  description?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  inputSummary?: string;
  outputSummary?: string;
  details?: IAgentActivityDetail[];
  files?: IAgentActivityFile[];
  search?: IAgentActivitySearch;
  tool?: IAgentActivityTool;
  command?: IAgentActivityCommand;
  error?: IAgentActivityError;
  metadata?: Record<string, string | number | boolean | null>;
}

export type TAgentActivitySnapshotKind = (typeof AGENT_ACTIVITY_SNAPSHOT_KINDS)[number];

export interface IAgentActivitySnapshotEvent {
  type: 'ACTIVITY_SNAPSHOT';
  timestamp: number;
  messageId: string;
  activityType: TAgentActivitySnapshotKind;
  replace?: boolean;
  content: IAgentActivity;
}

export type TAgentActivityPatchOperation =
  | {
    op: 'add' | 'replace';
    path: string;
    value: unknown;
  }
  | {
    op: 'remove';
    path: string;
  };

export interface IAgentActivityDeltaEvent {
  type: 'ACTIVITY_DELTA';
  timestamp: number;
  messageId: string;
  activityType: TAgentActivitySnapshotKind;
  patch: TAgentActivityPatchOperation[];
}

export type TAgentActivityEvent =
  | IAgentActivitySnapshotEvent
  | IAgentActivityDeltaEvent;
