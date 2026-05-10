import { z } from 'zod';

import {
  AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
  AGENT_RUNTIME_EVENT_TYPES,
  type TAgentRuntimeEvent,
} from '../streaming/stream-types.js';
import type { JSONValue } from '../types/json-value.js';
import { agentPlanRecordSchema, agentPlanSchema, agentPlanStatusSchema } from './plan.js';

export type TJsonValue = JSONValue;

export const jsonValueSchema: z.ZodType<TJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const approvalRequestSchema = z.object({
  id: z.string().min(1),
  toolName: z.string().min(1),
  question: z.string().min(1),
  summary: z.string().min(1),
  riskLevel: z.enum(['low', 'medium', 'high']),
  reversible: z.boolean(),
  createdAt: z.string().min(1),
});

export const diffFileSchema = z.object({
  path: z.string().min(1),
  hunks: z.array(z.object({
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    lines: z.array(z.string()),
  })),
});

export const agentRuntimeEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum(AGENT_RUNTIME_EVENT_TYPES),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  timestamp: z.string().min(1),
  seq: z.number().int().nonnegative(),
  schemaVersion: z.literal(AGENT_RUNTIME_EVENT_SCHEMA_VERSION),
  redacted: z.literal(true),
  visibility: z.enum(['user', 'debug']),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  parentId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
}).passthrough();

export const agentUiEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_delta'),
    text: z.string(),
    phase: z.enum(['stage', 'final']).optional(),
  }),
  z.object({
    type: z.literal('agent_event'),
    event: agentRuntimeEventSchema,
  }),
  z.object({
    type: z.literal('plan_ready'),
    planId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    version: z.number().int().positive(),
    status: agentPlanStatusSchema,
    createdAt: z.string().min(1).optional(),
    updatedAt: z.string().min(1).optional(),
    approvedAt: z.string().min(1).nullable().optional(),
    executedAt: z.string().min(1).nullable().optional(),
    rejectionReason: z.string().min(1).nullable().optional(),
    errorMessage: z.string().min(1).nullable().optional(),
    plan: agentPlanSchema,
  }),
  z.object({
    type: z.literal('plan_record'),
    record: agentPlanRecordSchema,
    versions: z.array(agentPlanRecordSchema),
  }),
  z.object({
    type: z.literal('tool_start'),
    toolName: z.string().min(1),
    input: jsonValueSchema,
  }),
  z.object({
    type: z.literal('tool_result'),
    toolName: z.string().min(1),
    output: jsonValueSchema,
  }),
  z.object({
    type: z.literal('approval_required'),
    request: approvalRequestSchema,
  }),
  z.object({
    type: z.literal('diff_ready'),
    files: z.array(diffFileSchema),
  }),
  z.object({
    type: z.literal('done'),
    result: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string().min(1),
  }),
]);

export const agentSidecarResponseSchema = z.object({
  sessionId: z.string().min(1),
  events: z.array(agentUiEventSchema),
  result: z.string().nullable(),
});

type TAgentUiEventFromSchema = z.infer<typeof agentUiEventSchema>;

export type TAgentUiEvent =
  | Exclude<TAgentUiEventFromSchema, { type: 'agent_event' }>
  | { type: 'agent_event'; event: TAgentRuntimeEvent };

export type TAgentSidecarResponse =
  Omit<z.infer<typeof agentSidecarResponseSchema>, 'events'> & {
    events: TAgentUiEvent[];
  };
