/**
 * AG-UI event adapter: converts Mastra sidecar events into AG-UI protocol
 * BaseEvent instances. All AG-UI types are derived from Zod schemas; we use
 * z.infer<> to stay compatible with the runtime-validated shape rather than
 * relying on manually maintained interfaces.
 */

import type { Message, RunAgentInput } from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import { z } from 'zod';

import type { IAiLanguageModelUsage } from '@/types/ai';
import type { IAgentSidecarChatRequest } from '@/types/ai/sidecar';
import { logger } from '@/utils/platform/logger';

// ===========================================================================
// ID generation
// ===========================================================================
export type IdGenerator = (prefix: string) => string;

const hasCryptoUuid =
  typeof globalThis !== 'undefined' && typeof globalThis.crypto?.randomUUID === 'function';

export const defaultIdGenerator: IdGenerator = (prefix) => {
  if (hasCryptoUuid) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

// ===========================================================================
// Role normalisation
// ===========================================================================
const aguiRoleSchema = z.enum(['user', 'assistant', 'system', 'tool', 'developer']);
type AguiRole = z.infer<typeof aguiRoleSchema>;
type SidecarRole = 'user' | 'assistant' | 'system' | 'tool';

const normaliseRole = (role: unknown): SidecarRole => {
  const parsed = aguiRoleSchema.safeParse(role);
  if (!parsed.success) return 'user';
  return parsed.data === 'developer' ? 'system' : (parsed.data as SidecarRole);
};

// ===========================================================================
// Message conversion
// ===========================================================================
const extractMessageText = (msg: Message): string => {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';
  return msg.content
    .map((part: unknown) => {
      const p = part as { type?: string; text?: string } | null;
      if (p?.type === 'text' && typeof p.text === 'string') return p.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

export const toAguiMessage = (
  msg: { role: string; content: string; id?: string },
  generateId: IdGenerator = defaultIdGenerator,
): Message =>
  ({
    id: msg.id ?? generateId('msg'),
    role: normaliseRole(msg.role) as AguiRole,
    content: msg.content,
  }) as Message;

export const toAguiMessages = (
  msgs: readonly { role: string; content: string; id?: string }[],
  generateId: IdGenerator = defaultIdGenerator,
): Message[] =>
  msgs.map((m: { role: string; content: string; id?: string }) => toAguiMessage(m, generateId));

export const toSidecarChatRequest = (input: RunAgentInput): IAgentSidecarChatRequest => ({
  messages: input.messages.map((m: Message) => ({
    role: normaliseRole(m.role),
    content: extractMessageText(m),
  })),
  threadId: input.threadId ?? undefined,
  context: [],
});

// ===========================================================================
// Safe JSON
// ===========================================================================
const safeStringify = (value: unknown, fallback = ''): string => {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback || '"[unserialisable]"';
  }
};

// ===========================================================================
// Event factories
// ===========================================================================
export interface IEventBaseFields {
  runId: string;
  threadId: string;
}

type AguiEvent = {
  type: EventType;
  [k: string]: unknown;
  timestamp?: number;
  rawEvent?: unknown;
};

const ev = <T extends AguiEvent>(fields: T): T => fields;

export const createRunStartedEvent = (base: IEventBaseFields) =>
  ev({
    type: EventType.RUN_STARTED,
    runId: base.runId,
    threadId: base.threadId,
  });

export const createTextMessageStartEvent = (
  base: IEventBaseFields,
  messageId: string,
  role = 'assistant' as const,
) =>
  ev({
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role,
    runId: base.runId,
    threadId: base.threadId,
  });

export const createTextMessageContentEvent = (
  base: IEventBaseFields,
  messageId: string,
  delta: string,
) =>
  ev({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta,
    runId: base.runId,
    threadId: base.threadId,
  });

export const createTextMessageEndEvent = (base: IEventBaseFields, messageId: string) =>
  ev({
    type: EventType.TEXT_MESSAGE_END,
    messageId,
    runId: base.runId,
    threadId: base.threadId,
  });

export const createToolCallStartEvent = (
  base: IEventBaseFields,
  toolCallId: string,
  toolName: string,
  parentMessageId?: string,
) =>
  ev({
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: toolName,
    runId: base.runId,
    threadId: base.threadId,
    ...(parentMessageId ? { parentMessageId } : {}),
  });

export const createToolCallArgsEvent = (
  base: IEventBaseFields,
  toolCallId: string,
  delta: string,
) =>
  ev({
    type: EventType.TOOL_CALL_ARGS,
    toolCallId,
    delta,
    runId: base.runId,
    threadId: base.threadId,
  });

export const createToolCallEndEvent = (base: IEventBaseFields, toolCallId: string) =>
  ev({
    type: EventType.TOOL_CALL_END,
    toolCallId,
    runId: base.runId,
    threadId: base.threadId,
  });

export const createToolCallResultEvent = (
  base: IEventBaseFields,
  toolCallId: string,
  result: string,
  messageId: string,
) =>
  ev({
    type: EventType.TOOL_CALL_RESULT,
    toolCallId,
    messageId,
    content: result,
    role: 'tool' as const,
    runId: base.runId,
    threadId: base.threadId,
  });

export const createRunFinishedEvent = (base: IEventBaseFields, result?: string) =>
  ev({
    type: EventType.RUN_FINISHED,
    runId: base.runId,
    threadId: base.threadId,
    ...(result !== undefined ? { result } : {}),
  });

export const createRunErrorEvent = (base: IEventBaseFields, message: string) =>
  ev({
    type: EventType.RUN_ERROR,
    runId: base.runId,
    threadId: base.threadId,
    message,
  });

// ===========================================================================
// Stateful adapter
// ===========================================================================
export interface ISidecarUiEvent {
  type: string;
  [key: string]: unknown;
}

export interface ISidecarEventAdapterOptions {
  generateId?: IdGenerator;
  warn?: (message: string, payload?: unknown) => void;
}

export interface ISidecarEventAdapter {
  convert: (event: ISidecarUiEvent, base: IEventBaseFields, messageId: string) => AguiEvent[];
  terminal: (
    base: IEventBaseFields,
    messageId: string,
    result: string | null,
    usage?: IAiLanguageModelUsage | null,
  ) => AguiEvent[];
  reset: () => void;
}

export const createSidecarEventAdapter = (
  options: ISidecarEventAdapterOptions = {},
): ISidecarEventAdapter => {
  const generateId = options.generateId ?? defaultIdGenerator;
  const warn =
    options.warn ?? ((m, p) => logger.warn({ event: 'ag-ui-adapter', message: m, payload: p }));

  let toolCallIdByKey = new Map<string, string>();

  const getOrCreateToolCallId = (key: string): { id: string; isNew: boolean } => {
    const existing = toolCallIdByKey.get(key);
    if (existing) return { id: existing, isNew: false };
    const id = generateId('tc');
    toolCallIdByKey.set(key, id);
    return { id, isNew: true };
  };

  const consumeToolCallId = (key: string): string => {
    const existing = toolCallIdByKey.get(key);
    if (existing) {
      toolCallIdByKey.delete(key);
      return existing;
    }
    warn(`tool result without matching start (key="${key}"); synthesising id.`);
    return generateId('tc');
  };

  const convert: ISidecarEventAdapter['convert'] = (event, base, messageId) => {
    const events: AguiEvent[] = [];

    switch (event.type) {
      case 'message_delta': {
        const text = typeof event.text === 'string' ? event.text : '';
        if (text) events.push(createTextMessageContentEvent(base, messageId, text));
        break;
      }
      case 'tool_start': {
        const toolName = typeof event.toolName === 'string' ? event.toolName : 'unknown';
        const key = typeof event.toolCallId === 'string' ? event.toolCallId : toolName;
        const { id: toolCallId } = getOrCreateToolCallId(key);
        events.push(createToolCallStartEvent(base, toolCallId, toolName, messageId));
        events.push(createToolCallArgsEvent(base, toolCallId, safeStringify(event.input, '{}')));
        break;
      }
      case 'tool_result': {
        const toolName = typeof event.toolName === 'string' ? event.toolName : 'unknown';
        const key = typeof event.toolCallId === 'string' ? event.toolCallId : toolName;
        const toolCallId = consumeToolCallId(key);
        events.push(createToolCallEndEvent(base, toolCallId));
        events.push(
          createToolCallResultEvent(
            base,
            toolCallId,
            safeStringify(event.output),
            generateId('tool-msg'),
          ),
        );
        break;
      }
      case 'agent_event': {
        const agentEvent = event.event as Record<string, unknown> | undefined;
        if (!agentEvent || typeof agentEvent.type !== 'string') break;
        if (agentEvent.type === 'agent.tool.started') {
          const toolName =
            typeof agentEvent.toolName === 'string' ? agentEvent.toolName : 'unknown';
          const key = typeof agentEvent.toolCallId === 'string' ? agentEvent.toolCallId : toolName;
          const { id: toolCallId } = getOrCreateToolCallId(key);
          const inputPreview =
            typeof agentEvent.inputPreview === 'string' ? agentEvent.inputPreview : '{}';
          events.push(createToolCallStartEvent(base, toolCallId, toolName, messageId));
          events.push(createToolCallArgsEvent(base, toolCallId, inputPreview));
        } else if (agentEvent.type === 'agent.tool.completed') {
          const toolName =
            typeof agentEvent.toolName === 'string' ? agentEvent.toolName : 'unknown';
          const key = typeof agentEvent.toolCallId === 'string' ? agentEvent.toolCallId : toolName;
          const toolCallId = consumeToolCallId(key);
          const resultPreview =
            typeof agentEvent.resultPreview === 'string' ? agentEvent.resultPreview : '';
          const errorMessage =
            typeof agentEvent.errorMessage === 'string' ? agentEvent.errorMessage : '';
          events.push(createToolCallEndEvent(base, toolCallId));
          events.push(
            createToolCallResultEvent(
              base,
              toolCallId,
              resultPreview || errorMessage,
              generateId('tool-msg'),
            ),
          );
        }
        break;
      }
      case 'approval_required': {
        const request = event.request as Record<string, unknown> | undefined;
        if (!request) break;
        const toolName = typeof request.toolName === 'string' ? request.toolName : 'unknown';
        const key = typeof request.id === 'string' ? request.id : toolName;
        const { id: toolCallId } = getOrCreateToolCallId(key);
        events.push(createToolCallStartEvent(base, toolCallId, `approve.${toolName}`, messageId));
        events.push(
          createToolCallArgsEvent(
            base,
            toolCallId,
            safeStringify({
              toolName,
              question: typeof request.question === 'string' ? request.question : '',
              summary: typeof request.summary === 'string' ? request.summary : '',
              riskLevel: typeof request.riskLevel === 'string' ? request.riskLevel : 'medium',
              reversible: Boolean(request.reversible),
            }),
          ),
        );
        break;
      }
      case 'error': {
        events.push(
          createRunErrorEvent(
            base,
            typeof event.message === 'string' ? event.message : 'Unknown error',
          ),
        );
        break;
      }
      default:
        break;
    }
    return events;
  };

  const terminal: ISidecarEventAdapter['terminal'] = (base, messageId, result, _usage) => {
    const events: AguiEvent[] = [];
    events.push(createTextMessageEndEvent(base, messageId));
    events.push(createRunFinishedEvent(base, result ?? undefined));
    return events;
  };

  const reset = (): void => {
    toolCallIdByKey = new Map();
  };

  return { convert, terminal, reset };
};

// ===========================================================================
// Shared instance for backwards-compatible module-level API
// ===========================================================================
const sharedAdapter = createSidecarEventAdapter();

export const convertSidecarUiEvent = (
  event: ISidecarUiEvent,
  base: IEventBaseFields,
  messageId: string,
): AguiEvent[] => sharedAdapter.convert(event, base, messageId);

export const createTerminalEvents = (
  base: IEventBaseFields,
  messageId: string,
  result: string | null,
  usage?: IAiLanguageModelUsage | null,
): AguiEvent[] => sharedAdapter.terminal(base, messageId, result, usage);

export const createEventId = (prefix: string): string => defaultIdGenerator(prefix);
