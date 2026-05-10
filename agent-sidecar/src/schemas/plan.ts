import { z } from 'zod';

export const agentPlanStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'executing',
  'completed',
  'failed',
]);

export const agentPlanStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  description: z.string().min(1).optional(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped', 'cancelled']),
  tools: z.array(z.string().min(1)),
  files: z.array(z.string().min(1)).optional(),
  commands: z.array(z.string().min(1)).optional(),
  risks: z.array(z.string().min(1)).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  riskLevel: z.enum(['low', 'medium', 'high']),
  requiresApproval: z.boolean(),
  expectedOutput: z.string().min(1),
});

export const agentPlanSchema = z.object({
  goal: z.string().min(1),
  summary: z.string().min(1).optional(),
  requiresApproval: z.boolean().optional(),
  steps: z.array(agentPlanStepSchema).min(1),
});

export const agentPlanRecordSchema = z.object({
  planId: z.string().min(1),
  threadId: z.string().min(1),
  version: z.number().int().positive(),
  status: agentPlanStatusSchema,
  userRequest: z.string(),
  plan: agentPlanSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  approvedAt: z.string().min(1).nullable(),
  executedAt: z.string().min(1).nullable(),
  rejectionReason: z.string().min(1).nullable(),
  errorMessage: z.string().min(1).nullable(),
});

export type TAgentPlanStatus = z.infer<typeof agentPlanStatusSchema>;
export type TAgentPlan = z.infer<typeof agentPlanSchema>;
export type TAgentPlanStep = z.infer<typeof agentPlanStepSchema>;
export type TAgentPlanRecord = z.infer<typeof agentPlanRecordSchema>;
