import { createHash } from 'node:crypto';

import type { JSONValue } from '../types/json-value.js';

export const ACONTEXT_STATE_KEY = 'acontext';

export type TOfficialAcontextMode = 'ask' | 'plan' | 'agent' | 'patch' | 'review';
export type TOfficialAcontextTaskStatus = 'active' | 'completed' | 'blocked' | 'cancelled';
export type TOfficialAcontextTaskPhase =
  | 'init'
  | 'responding'
  | 'planning'
  | 'executing'
  | 'reviewing'
  | 'turn-finished';
export type TOfficialAcontextStateItemKind =
  | 'constraint'
  | 'decision'
  | 'important_fact'
  | 'open_question';
export type TOfficialAcontextMessageKind =
  | 'user'
  | 'assistant'
  | 'tool_result'
  | 'tool_use'
  | 'unknown';

export interface IOfficialAcontextStateItem {
  id: string;
  kind: TOfficialAcontextStateItemKind;
  content: string;
  source: 'user';
  confidence: 'explicit';
  createdAt: string;
  updatedAt: string;
}

export interface IOfficialAcontextCurrentTask {
  taskId: string | null;
  goal: string | null;
  phase: TOfficialAcontextTaskPhase;
  status: TOfficialAcontextTaskStatus;
  createdAt: string | null;
  updatedAt: string | null;
  lastStopReason: string | null;
}

export interface IOfficialAcontextContextState {
  sessionSummary: string;
  recentFocus: string;
  importantFacts: IOfficialAcontextStateItem[];
  constraints: IOfficialAcontextStateItem[];
  decisions: IOfficialAcontextStateItem[];
  openQuestions: IOfficialAcontextStateItem[];
}

export interface IOfficialAcontextToolSummary {
  id: string;
  tool: string;
  status: 'success' | 'error';
  summary: string;
  createdAt: string;
}

export interface IOfficialAcontextToolError {
  id: string;
  tool: string;
  message: string;
  createdAt: string;
}

export interface IOfficialAcontextToolContext {
  toolSummaries: IOfficialAcontextToolSummary[];
  lastToolErrors: IOfficialAcontextToolError[];
  largeResultCount: number;
}

export interface IOfficialAcontextCompressionState {
  lastCompressedAt: string | null;
  compressionCount: number;
  lastProjectedInputTokens: number | null;
  lastCheckedAt: string | null;
  tokenEstimateAvailable: boolean;
}

export interface IOfficialAcontextMessageStats {
  totalMessagesSeen: number;
  lastMessageAt: string | null;
  byKind: Record<TOfficialAcontextMessageKind, number>;
}

export interface IOfficialAcontextState {
  currentTask: IOfficialAcontextCurrentTask;
  context: IOfficialAcontextContextState;
  toolContext: IOfficialAcontextToolContext;
  compression: IOfficialAcontextCompressionState;
  messageStats: IOfficialAcontextMessageStats;
}

const MAX_STATE_ITEMS_PER_KIND = 20;
const MAX_EXPLICIT_LINE_CHARS = 240;

const CONSTRAINT_PATTERNS = [
  /^(必须|务必|只能|只用|只要|不要|禁止|不得|暂时不|先不|约束是|限制是|要求是)/u,
  /(必须|只用|只使用|不要|禁止|不得|暂时不|先不|不使用|不用第三方|只依赖|只采用)/u,
  /\b(must|only|do not|don't|never|forbid|constraint)\b/iu,
];

const DECISION_PATTERNS = [
  /^(决定|采用|选用|选择|选定|就用|改成|定为|最终用)/u,
  /(决定采用|决定使用|采用|选用|选定|就用这个|不用那个)/u,
  /\b(decide|decided|choose|chosen|adopt)\b/iu,
];

const IMPORTANT_FACT_PATTERNS = [
  /^(我是|我们是|当前项目是|项目是|我的目标是|目标是|这一版|本阶段)/u,
  /(我的目标是|目标是|当前 session|当前任务|本阶段|这一版)/u,
  /\b(my goal is|current task|this session|this phase)\b/iu,
];

const OPEN_QUESTION_PATTERNS = [
  /^(待确认|未解决|开放问题|问题是|需要确认|还不确定)/u,
  /(待确认|未解决|开放问题|需要确认|还不确定)/u,
  /\b(open question|unresolved|need to confirm)\b/iu,
];

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const readString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const readNullableString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const readNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const readBoolean = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : fallback;

const isTaskStatus = (value: unknown): value is TOfficialAcontextTaskStatus =>
  value === 'active' || value === 'completed' || value === 'blocked' || value === 'cancelled';

const isTaskPhase = (value: unknown): value is TOfficialAcontextTaskPhase =>
  value === 'init' ||
  value === 'responding' ||
  value === 'planning' ||
  value === 'executing' ||
  value === 'reviewing' ||
  value === 'turn-finished';

const isStateItemKind = (value: unknown): value is TOfficialAcontextStateItemKind =>
  value === 'constraint' ||
  value === 'decision' ||
  value === 'important_fact' ||
  value === 'open_question';

export const getOfficialAcontextPhaseForMode = (
  mode: TOfficialAcontextMode,
): TOfficialAcontextTaskPhase => {
  if (mode === 'plan') {
    return 'planning';
  }

  if (mode === 'agent' || mode === 'patch') {
    return 'executing';
  }

  if (mode === 'review') {
    return 'reviewing';
  }

  return 'responding';
};

export const createDefaultOfficialAcontextState = (
  now: string | null = null,
  goal: string | null = null,
): IOfficialAcontextState => ({
  currentTask: {
    taskId: null,
    goal,
    phase: 'init',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastStopReason: null,
  },
  context: {
    sessionSummary: '',
    recentFocus: '',
    importantFacts: [],
    constraints: [],
    decisions: [],
    openQuestions: [],
  },
  toolContext: {
    toolSummaries: [],
    lastToolErrors: [],
    largeResultCount: 0,
  },
  compression: {
    lastCompressedAt: null,
    compressionCount: 0,
    lastProjectedInputTokens: null,
    lastCheckedAt: null,
    tokenEstimateAvailable: false,
  },
  messageStats: {
    totalMessagesSeen: 0,
    lastMessageAt: null,
    byKind: {
      user: 0,
      assistant: 0,
      tool_result: 0,
      tool_use: 0,
      unknown: 0,
    },
  },
});

const createStateItemId = (
  kind: TOfficialAcontextStateItemKind,
  content: string,
): string => {
  const digest = createHash('sha256')
    .update(`${kind}:${content}`, 'utf8')
    .digest('hex')
    .slice(0, 16);

  return `${kind}_${digest}`;
};

const normalizeExplicitContent = (content: string): string =>
  content
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .trim();

const truncateCodePointSafe = (content: string, maxChars: number): string => {
  const codePoints = Array.from(content);

  if (codePoints.length <= maxChars) {
    return content;
  }

  return `${codePoints.slice(0, maxChars).join('')}...`;
};

const splitExplicitCandidates = (message: string): string[] =>
  normalizeExplicitContent(message)
    .split(/\n|[。；;]/u)
    .map((line) => truncateCodePointSafe(line.trim(), MAX_EXPLICIT_LINE_CHARS))
    .filter((line) => line.length > 0);

const matchesAny = (line: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(line));

const readStateItem = (value: unknown): IOfficialAcontextStateItem | null => {
  const record = toRecord(value);

  if (!record || !isStateItemKind(record.kind)) {
    return null;
  }

  const content = readString(record.content).trim();

  if (!content) {
    return null;
  }

  return {
    id: readString(record.id) || createStateItemId(record.kind, content),
    kind: record.kind,
    content,
    source: 'user',
    confidence: 'explicit',
    createdAt: readString(record.createdAt),
    updatedAt: readString(record.updatedAt),
  };
};

const readStateItems = (
  value: unknown,
  kind: TOfficialAcontextStateItemKind,
): IOfficialAcontextStateItem[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(readStateItem)
    .filter((item): item is IOfficialAcontextStateItem => item !== null)
    .filter((item) => item.kind === kind)
    .slice(-MAX_STATE_ITEMS_PER_KIND);
};

const readToolSummary = (value: unknown): IOfficialAcontextToolSummary | null => {
  const record = toRecord(value);

  if (!record) {
    return null;
  }

  const tool = readString(record.tool).trim();
  const summary = readString(record.summary).trim();
  const status = record.status === 'error' ? 'error' : 'success';

  if (!tool || !summary) {
    return null;
  }

  return {
    id: readString(record.id) || createStateItemId('important_fact', `${tool}:${summary}`),
    tool,
    status,
    summary,
    createdAt: readString(record.createdAt),
  };
};

const readToolError = (value: unknown): IOfficialAcontextToolError | null => {
  const record = toRecord(value);

  if (!record) {
    return null;
  }

  const tool = readString(record.tool).trim();
  const message = readString(record.message).trim();

  if (!tool || !message) {
    return null;
  }

  return {
    id: readString(record.id) || createStateItemId('important_fact', `${tool}:${message}`),
    tool,
    message,
    createdAt: readString(record.createdAt),
  };
};

export const parseOfficialAcontextState = (
  value: unknown,
  now: string | null = null,
): IOfficialAcontextState => {
  const record = toRecord(value);
  const fallback = createDefaultOfficialAcontextState(now);

  if (!record) {
    return fallback;
  }

  const task = toRecord(record.currentTask);
  const context = toRecord(record.context);
  const toolContext = toRecord(record.toolContext);
  const compression = toRecord(record.compression);
  const messageStats = toRecord(record.messageStats);
  const byKind = toRecord(messageStats?.byKind);

  return {
    currentTask: {
      taskId: readNullableString(task?.taskId),
      goal: readNullableString(task?.goal),
      phase: isTaskPhase(task?.phase) ? task.phase : fallback.currentTask.phase,
      status: isTaskStatus(task?.status) ? task.status : fallback.currentTask.status,
      createdAt: readNullableString(task?.createdAt),
      updatedAt: readNullableString(task?.updatedAt),
      lastStopReason: readNullableString(task?.lastStopReason),
    },
    context: {
      sessionSummary: readString(context?.sessionSummary),
      recentFocus: readString(context?.recentFocus),
      importantFacts: readStateItems(context?.importantFacts, 'important_fact'),
      constraints: readStateItems(context?.constraints, 'constraint'),
      decisions: readStateItems(context?.decisions, 'decision'),
      openQuestions: readStateItems(context?.openQuestions, 'open_question'),
    },
    toolContext: {
      toolSummaries: Array.isArray(toolContext?.toolSummaries)
        ? toolContext.toolSummaries
          .map(readToolSummary)
          .filter((item): item is IOfficialAcontextToolSummary => item !== null)
          .slice(-5)
        : [],
      lastToolErrors: Array.isArray(toolContext?.lastToolErrors)
        ? toolContext.lastToolErrors
          .map(readToolError)
          .filter((item): item is IOfficialAcontextToolError => item !== null)
          .slice(-5)
        : [],
      largeResultCount: readNumber(toolContext?.largeResultCount),
    },
    compression: {
      lastCompressedAt: readNullableString(compression?.lastCompressedAt),
      compressionCount: readNumber(compression?.compressionCount),
      lastProjectedInputTokens: readNullableString(compression?.lastProjectedInputTokens) === null &&
        typeof compression?.lastProjectedInputTokens === 'number'
        ? compression.lastProjectedInputTokens
        : null,
      lastCheckedAt: readNullableString(compression?.lastCheckedAt),
      tokenEstimateAvailable: readBoolean(compression?.tokenEstimateAvailable),
    },
    messageStats: {
      totalMessagesSeen: readNumber(messageStats?.totalMessagesSeen),
      lastMessageAt: readNullableString(messageStats?.lastMessageAt),
      byKind: {
        user: readNumber(byKind?.user),
        assistant: readNumber(byKind?.assistant),
        tool_result: readNumber(byKind?.tool_result),
        tool_use: readNumber(byKind?.tool_use),
        unknown: readNumber(byKind?.unknown),
      },
    },
  };
};

const stateItemToJson = (item: IOfficialAcontextStateItem): JSONValue => ({
  id: item.id,
  kind: item.kind,
  content: item.content,
  source: item.source,
  confidence: item.confidence,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

const toolSummaryToJson = (summary: IOfficialAcontextToolSummary): JSONValue => ({
  id: summary.id,
  tool: summary.tool,
  status: summary.status,
  summary: summary.summary,
  createdAt: summary.createdAt,
});

const toolErrorToJson = (error: IOfficialAcontextToolError): JSONValue => ({
  id: error.id,
  tool: error.tool,
  message: error.message,
  createdAt: error.createdAt,
});

export const officialAcontextStateToJson = (
  state: IOfficialAcontextState,
): JSONValue => ({
  currentTask: {
    taskId: state.currentTask.taskId,
    goal: state.currentTask.goal,
    phase: state.currentTask.phase,
    status: state.currentTask.status,
    createdAt: state.currentTask.createdAt,
    updatedAt: state.currentTask.updatedAt,
    lastStopReason: state.currentTask.lastStopReason,
  },
  context: {
    sessionSummary: state.context.sessionSummary,
    recentFocus: state.context.recentFocus,
    importantFacts: state.context.importantFacts.map(stateItemToJson),
    constraints: state.context.constraints.map(stateItemToJson),
    decisions: state.context.decisions.map(stateItemToJson),
    openQuestions: state.context.openQuestions.map(stateItemToJson),
  },
  toolContext: {
    toolSummaries: state.toolContext.toolSummaries.map(toolSummaryToJson),
    lastToolErrors: state.toolContext.lastToolErrors.map(toolErrorToJson),
    largeResultCount: state.toolContext.largeResultCount,
  },
  compression: {
    lastCompressedAt: state.compression.lastCompressedAt,
    compressionCount: state.compression.compressionCount,
    lastProjectedInputTokens: state.compression.lastProjectedInputTokens,
    lastCheckedAt: state.compression.lastCheckedAt,
    tokenEstimateAvailable: state.compression.tokenEstimateAvailable,
  },
  messageStats: {
    totalMessagesSeen: state.messageStats.totalMessagesSeen,
    lastMessageAt: state.messageStats.lastMessageAt,
    byKind: {
      user: state.messageStats.byKind.user,
      assistant: state.messageStats.byKind.assistant,
      tool_result: state.messageStats.byKind.tool_result,
      tool_use: state.messageStats.byKind.tool_use,
      unknown: state.messageStats.byKind.unknown,
    },
  },
});

const upsertExplicitItem = (
  items: IOfficialAcontextStateItem[],
  kind: TOfficialAcontextStateItemKind,
  content: string,
  now: string,
): IOfficialAcontextStateItem[] => {
  const normalized = normalizeExplicitContent(content);

  if (!normalized) {
    return items;
  }

  const id = createStateItemId(kind, normalized);
  const existingIndex = items.findIndex((item) => item.id === id);

  if (existingIndex >= 0) {
    return items.map((item, index) => index === existingIndex
      ? { ...item, updatedAt: now }
      : item);
  }

  const item: IOfficialAcontextStateItem = {
    id,
    kind,
    content: normalized,
    source: 'user',
    confidence: 'explicit',
    createdAt: now,
    updatedAt: now,
  };

  return [
    ...items,
    item,
  ].slice(-MAX_STATE_ITEMS_PER_KIND);
};

export const applyExplicitStateFromUserMessage = (
  state: IOfficialAcontextState,
  message: string,
  now: string,
): IOfficialAcontextState => {
  const nextState: IOfficialAcontextState = {
    ...state,
    context: {
      ...state.context,
      importantFacts: [...state.context.importantFacts],
      constraints: [...state.context.constraints],
      decisions: [...state.context.decisions],
      openQuestions: [...state.context.openQuestions],
    },
  };

  for (const line of splitExplicitCandidates(message)) {
    if (matchesAny(line, CONSTRAINT_PATTERNS)) {
      nextState.context.constraints = upsertExplicitItem(
        nextState.context.constraints,
        'constraint',
        line,
        now,
      );
      continue;
    }

    if (matchesAny(line, DECISION_PATTERNS)) {
      nextState.context.decisions = upsertExplicitItem(
        nextState.context.decisions,
        'decision',
        line,
        now,
      );
      continue;
    }

    if (matchesAny(line, OPEN_QUESTION_PATTERNS)) {
      nextState.context.openQuestions = upsertExplicitItem(
        nextState.context.openQuestions,
        'open_question',
        line,
        now,
      );
      continue;
    }

    if (matchesAny(line, IMPORTANT_FACT_PATTERNS)) {
      nextState.context.importantFacts = upsertExplicitItem(
        nextState.context.importantFacts,
        'important_fact',
        line,
        now,
      );
    }
  }

  return nextState;
};
