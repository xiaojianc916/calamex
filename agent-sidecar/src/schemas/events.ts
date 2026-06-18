import { z } from 'zod';
import {
  AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
  AGENT_RUNTIME_EVENT_TYPES,
  type TAgentRuntimeEvent,
} from '../streaming/stream-types.js';
import type { JSONValue } from '../types/json-value.js';
import { languageModelUsageSchema, type TLanguageModelUsage } from '../models/usage.js';
import { agentPlanRecordSchema, agentPlanSchema, agentPlanStatusSchema } from './plan.js';

export const AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION = 2 as const;
export type TAgentSidecarResponseSchemaVersion = typeof AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION;

export type TJsonValue = JSONValue;

export const jsonValueSchema: z.ZodType<TJsonValue> = z.lazy(() =>
  z.union([
    z.string(), z.number(), z.boolean(), z.null(),
    z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
  ]),
);

export const approvalRequestSchema = z.object({
  id: z.string().min(1), toolName: z.string().min(1), question: z.string().min(1),
  summary: z.string().min(1), riskLevel: z.enum(['low', 'medium', 'high']),
  reversible: z.boolean(), createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});

export const askUserOptionSchema = z.object({
  optionId: z.string().min(1), label: z.string(), description: z.string(),
});

export const askUserQuestionSchema = z.object({
  questionId: z.string().min(1), question: z.string().min(1), header: z.string().min(1),
  type: z.enum(['choice', 'text', 'yesno']),
  options: z.array(askUserOptionSchema).optional(),
  multiSelect: z.boolean().optional(), placeholder: z.string().optional(),
});

export const askUserRequestSchema = z.object({
  kind: z.literal('user_question'),
  questions: z.array(askUserQuestionSchema).min(1),
});

export const diffHunkSchema = z.object({
  oldStart: z.number().int().nonnegative(), oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(), newLines: z.number().int().nonnegative(),
  lines: z.array(z.string()),
});

export const diffFileSchema = z.object({
  path: z.string().min(1), hunks: z.array(diffHunkSchema),
});

export const agentRuntimeEventSchema = z.object({
  id: z.string().min(1), type: z.enum(AGENT_RUNTIME_EVENT_TYPES),
  runId: z.string().min(1), sessionId: z.string().min(1), agentId: z.string().min(1),
  timestamp: z.string().datetime(), seq: z.number().int().nonnegative(),
  schemaVersion: z.literal(AGENT_RUNTIME_EVENT_SCHEMA_VERSION),
  redacted: z.literal(true), visibility: z.enum(['user', 'debug']),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  parentId: z.string().min(1).optional(), spanId: z.string().min(1).optional(),
}).passthrough();

export { languageModelUsageSchema, type TLanguageModelUsage };

export const agentUiEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_delta'), text: z.string(), phase: z.enum(['stage', 'final']).optional() }),
  z.object({ type: z.literal('message_clear') }),
  z.object({ type: z.literal('agent_event'), event: agentRuntimeEventSchema }),
  z.object({
    type: z.literal('plan_ready'), planId: z.string().min(1),
    threadId: z.string().min(1).optional(), version: z.number().int().positive(),
    status: agentPlanStatusSchema, createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    approvedAt: z.string().datetime().nullable().optional(),
    executedAt: z.string().datetime().nullable().optional(),
    rejectionReason: z.string().min(1).nullable().optional(),
    errorMessage: z.string().min(1).nullable().optional(), plan: agentPlanSchema,
  }),
  z.object({ type: z.literal('plan_record'), record: agentPlanRecordSchema, versions: z.array(agentPlanRecordSchema) }),
  z.object({ type: z.literal('tool_start'), toolName: z.string().min(1), input: jsonValueSchema }),
  z.object({ type: z.literal('tool_result'), toolName: z.string().min(1), output: jsonValueSchema }),
  z.object({ type: z.literal('approval_required'), request: approvalRequestSchema }),
  z.object({
    type: z.literal('ask_user_required'), requestId: z.string().min(1), request: askUserRequestSchema,
  }),
  z.object({ type: z.literal('diff_ready'), files: z.array(diffFileSchema) }),
  z.object({
    type: z.literal('done'), result: z.string(),
    usage: languageModelUsageSchema.nullable().optional(),
    promptTokens: z.number().nonnegative().optional(),
    completionTokens: z.number().nonnegative().optional(),
    totalTokens: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('error'), message: z.string().min(1),
    code: z.string().min(1).optional(),
    cause: z.string().min(1).optional(), retryable: z.boolean().optional(),
  }),
]);

export const agentSidecarResponseSchema = z.object({
  schemaVersion: z.literal(AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION),
  sessionId: z.string().min(1),
  events: z.array(agentUiEventSchema),
  result: z.string().nullable(),
  errorMessage: z.string().optional(),
  errorCode: z.string().optional(),
});

export type TAgentUiEventParsed = z.infer<typeof agentUiEventSchema>;
export type TAgentUiEvent =
  | Exclude<TAgentUiEventParsed, { type: 'agent_event' }>
  | { type: 'agent_event'; event: TAgentRuntimeEvent };
export type TAgentUiEventNarrowed = TAgentUiEvent;

export type TAgentSidecarResponse = {
  schemaVersion: TAgentSidecarResponseSchemaVersion;
  sessionId: string;
  events: TAgentUiEvent[];
  result: string | null;
  errorMessage?: string;
  errorCode?: string;
};
