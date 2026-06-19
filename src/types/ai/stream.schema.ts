import { z } from 'zod/v3';
import {
  aiAgentRunSchema,
  aiAgentToolNameSchema,
  aiTaskPlanStepSchema,
  aiToolConfirmationRequestSchema,
} from '@/types/ai/agent.schema';
import { aiAgentPatchSummarySchema } from '@/types/ai/patch.schema';
import { AI_AGENT_STREAM_END_REASONS, AI_TOOL_ACTIVITY_STATES } from '@/types/ai/stream';

export const aiToolActivityStateSchema = z.enum(AI_TOOL_ACTIVITY_STATES);

export const aiAgentStreamEndReasonSchema = z.enum(AI_AGENT_STREAM_END_REASONS);

const nullishOptional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === null ? undefined : value), schema.optional());

export const aiToolActivityInlineSchema = z.object({
  id: z.string().min(1),
  stepId: z.string().min(1),
  toolName: aiAgentToolNameSchema,
  state: aiToolActivityStateSchema,
  label: z.string().min(1),
  targetPreview: nullishOptional(z.string().min(1)),
  startedAt: z.string().min(1),
  elapsedMs: nullishOptional(z.number().int().nonnegative()),
});

export const aiAgentStreamErrorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  scope: z.string().min(1),
  traceId: z.string().min(1),
  timestamp: z.string().min(1),
});

export const aiAgentChatDeltaStreamEventSchema = z.object({
  event: z.literal('chat.delta'),
  seq: z.number().int().nonnegative(),
  runId: z.string().min(1),
  messageId: z.string().min(1),
  delta: z.string(),
});

export const aiAgentRunStreamEventSchema = z.object({
  event: z.literal('agent.run'),
  seq: z.number().int().nonnegative(),
  runId: z.string().min(1),
  run: aiAgentRunSchema,
});

export const aiAgentStepStreamEventSchema = z.object({
  event: z.literal('agent.step'),
  seq: z.number().int().nonnegative(),
  runId: z.string().min(1),
  step: aiTaskPlanStepSchema,
});

export const aiAgentToolActivityStreamEventSchema = z.object({
  event: z.literal('tool.activity'),
  seq: z.number().int().nonnegative(),
  runId: z.string().min(1),
  activity: aiToolActivityInlineSchema,
});

export const aiAgentToolConfirmationStreamEventSchema = z.object({
  event: z.literal('tool.confirmation'),
  seq: z.number().int().nonnegative(),
  runId: z.string().min(1),
  confirmation: aiToolConfirmationRequestSchema,
});

export const aiAgentPatchSummaryStreamEventSchema = z.object({
  event: z.literal('patch.summary'),
  seq: z.number().int().nonnegative(),
  runId: z.string().min(1),
  summary: aiAgentPatchSummarySchema,
});

export const aiAgentStreamErrorEventSchema = z.object({
  event: z.literal('stream.error'),
  seq: z.number().int().nonnegative(),
  runId: z.string().min(1),
  error: aiAgentStreamErrorPayloadSchema,
});

export const aiAgentStreamEndEventSchema = z.object({
  event: z.literal('stream.end'),
  seq: z.number().int().nonnegative(),
  runId: z.string().min(1),
  reason: aiAgentStreamEndReasonSchema,
});

export const aiAgentStreamEventSchema = z.discriminatedUnion('event', [
  aiAgentChatDeltaStreamEventSchema,
  aiAgentRunStreamEventSchema,
  aiAgentStepStreamEventSchema,
  aiAgentToolActivityStreamEventSchema,
  aiAgentToolConfirmationStreamEventSchema,
  aiAgentPatchSummaryStreamEventSchema,
  aiAgentStreamErrorEventSchema,
  aiAgentStreamEndEventSchema,
]);
