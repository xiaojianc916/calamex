import { z } from 'zod';

import {
  agentActivityEventSchema,
  agentActivitySchema,
} from '@/types/agent-activity.schema';
import {
  aiAgentApprovePlanPayloadSchema,
  aiAgentApprovePlanRequestSchema,
  aiAgentClassifyTaskPayloadSchema,
  aiAgentClassifyTaskRequestSchema,
  aiAgentListRunsPayloadSchema,
  aiAgentNetworkPermissionPayloadSchema,
  aiAgentNetworkPermissionSchema,
  aiAgentPermissionLevelSchema,
  aiAgentPermissionScopeSchema,
  aiAgentPermissionStateSchema,
  aiAgentPlanPayloadSchema,
  aiAgentPlanReferenceSchema,
  aiAgentPlanReferenceTypeSchema,
  aiAgentPlanRequestSchema,
  aiAgentPlanRiskLevelSchema,
  aiAgentPlanStepKindSchema,
  aiAgentPlanStepStatusSchema,
  aiAgentResolveToolConfirmationRequestSchema,
  aiAgentRunIdRequestSchema,
  aiAgentRunPayloadSchema,
  aiAgentRunPlanRequestSchema,
  aiAgentRunSchema,
  aiAgentRunStatusSchema,
  aiAgentRunStepRequestSchema,
  aiAgentSetNetworkPermissionRequestSchema,
  aiAgentStepDetailSchema,
  aiAgentStepToolResultSummarySchema,
  aiAgentStepWebSourceSummarySchema,
  aiAgentTaskClassificationSchema,
  aiAgentTimelineItemSchema,
  aiAgentTimelineItemStatusSchema,
  aiAgentTimelineItemTypeSchema,
  aiAgentToolNameSchema,
  aiTaskPlanStepSchema,
} from '@/types/ai-agent.schema';
import {
  aiContextKindSchema,
  aiContextRangeSchema,
  aiContextReferenceSchema,
} from '@/types/ai-context.schema';
import {
  aiAgentChangedFileSchema,
  aiAgentChangedFileStatusSchema,
  aiAgentPatchSummarySchema,
  aiDiffEditorPreviewSchema,
  aiDiffHunkPreviewSchema,
  aiDiffPreviewLineKindSchema,
  aiDiffPreviewLineSchema,
} from '@/types/ai-patch.schema';
import {
  aiWebActivityStateSchema,
  aiWebFetchInputSchema,
  aiWebFetchPayloadSchema,
  aiWebFetchResultSchema,
  aiWebSearchInputSchema,
  aiWebSearchIntentSchema,
  aiWebSearchPayloadSchema,
  aiWebSearchRecencySchema,
  aiWebSearchResultSchema,
  aiWebSourceEntryStatusSchema,
  aiWebSourceTypeSchema,
} from '@/types/ai-web.schema';

export const aiProviderTypeSchema = z.enum([
  'litellm',
]);

export const aiChatMessageActionSchema = z.object({
  id: z.enum(['allow-agent-execution']),
  label: z.string().min(1),
  disabled: z.boolean().optional(),
});

export const aiAgentConfirmationStateSchema = z.object({
  goal: z.string().min(1),
  references: z.array(aiContextReferenceSchema),
  status: z.enum(['pending', 'running']),
});

export const aiChatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  createdAt: z.string().min(1),
  references: z.array(aiContextReferenceSchema),
  toolCalls: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(['pending', 'running', 'succeeded', 'failed', 'denied']),
    summary: z.string(),
    targetPreview: z.string().min(1).optional(),
    detailItems: z.array(z.string().min(1)).optional(),
    elapsedMs: z.number().nonnegative().optional(),
  })).optional(),
  actions: z.array(aiChatMessageActionSchema).optional(),
  agentConfirmation: aiAgentConfirmationStateSchema.optional(),
  stream: z.object({
    status: z.enum(['streaming', 'completed', 'cancelled']),
    activityText: z.string().min(1).optional(),
    activityTrail: z.array(z.string().min(1)).optional(),
    activities: z.array(agentActivitySchema).optional(),
    activityEvents: z.array(agentActivityEventSchema).optional(),
  }).optional(),
});

export const aiConfigPayloadSchema = z.object({
  providerType: aiProviderTypeSchema,
  selectedModel: z.string().nullable(),
  baseUrl: z.string().nullable(),
  activeProfileId: z.string().nullable().default(null),
  isBaseUrlConfigured: z.boolean(),
  hasCredentials: z.boolean(),
  isConfigured: z.boolean(),
  inlineCompletionEnabled: z.boolean(),
  chatEnabled: z.boolean(),
  agentEnabled: z.boolean(),
});

export const aiProviderProfilePayloadSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  providerType: aiProviderTypeSchema,
  selectedModel: z.string().nullable(),
  baseUrl: z.string().nullable(),
  inlineCompletionEnabled: z.boolean(),
  chatEnabled: z.boolean(),
  agentEnabled: z.boolean(),
  hasCredentials: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastUsedAt: z.string().min(1).nullable(),
});

export const aiProviderProfileDetailPayloadSchema = z.object({
  profile: aiProviderProfilePayloadSchema,
  apiKey: z.string().nullable(),
});

export const aiChatRequestSchema = z.object({
  threadId: z.string().nullable(),
  messages: z.array(aiChatMessageSchema).min(1),
  references: z.array(aiContextReferenceSchema),
});

export const aiChatPayloadSchema = z.object({
  message: aiChatMessageSchema,
  providerType: aiProviderTypeSchema,
  model: z.string(),
});

export const aiConversationTitleRequestSchema = z.object({
  userMessage: z.string().min(1),
  assistantMessage: z.string().min(1),
});

export const aiConversationTitlePayloadSchema = z.object({
  title: z.string().min(1).max(10),
  model: z.string().min(1),
});

export const aiChatStreamPayloadSchema = z.object({
  streamId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  providerType: aiProviderTypeSchema,
  model: z.string().min(1),
});

export const aiChatStreamEventPayloadSchema = z.object({
  streamId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  kind: z.enum(['start', 'delta', 'done', 'error', 'cancelled']),
  delta: z.string().nullable(),
  message: z.string().nullable(),
  model: z.string().nullable(),
});

export const aiToolDefinitionPayloadSchema = z.union([
  z.object({
    name: z.string().min(1),
    readOnly: z.boolean(),
    destructive: z.boolean(),
    requiresConfirmation: z.boolean(),
  }),
  z.object({
    name: z.string().min(1),
    read_only: z.boolean(),
    destructive: z.boolean(),
    requires_confirmation: z.boolean(),
  }).transform((value) => ({
    name: value.name,
    readOnly: value.read_only,
    destructive: value.destructive,
    requiresConfirmation: value.requires_confirmation,
  })),
]);

export const aiSaveCredentialsRequestSchema = z.object({
  providerType: aiProviderTypeSchema,
  apiKey: z.string().min(1),
});

export const aiProviderConnectionRequestSchema = z.object({
  providerType: aiProviderTypeSchema,
  selectedModel: z.string().nullable(),
  baseUrl: z.string().nullable(),
  inlineCompletionEnabled: z.boolean(),
  chatEnabled: z.boolean(),
  agentEnabled: z.boolean(),
  apiKey: z.string().nullable(),
});

export const aiProviderTestPayloadSchema = z.object({
  ok: z.boolean(),
  code: z.string(),
  message: z.string(),
});

export const aiProviderConnectionPayloadSchema = z.object({
  config: aiConfigPayloadSchema,
  test: aiProviderTestPayloadSchema,
});

export const aiPatchSetSchema = z.object({
  summary: z.string(),
  files: z.array(z.object({
    path: z.string(),
    originalHash: z.string(),
    hunks: z.array(z.object({
      oldStart: z.number().int().nonnegative(),
      oldLines: z.number().int().nonnegative(),
      newStart: z.number().int().nonnegative(),
      newLines: z.number().int().nonnegative(),
      lines: z.array(z.string()),
    })),
  })),
});

export const aiApplyPatchMetadataSchema = z.object({
  taskId: z.string().min(1).nullable().optional(),
  turnId: z.string().min(1).nullable().optional(),
  reason: z.string().min(1).nullable().optional(),
  toolCallId: z.string().min(1).nullable().optional(),
  confirmedByUser: z.boolean().nullable().optional(),
  agentRunId: z.string().min(1).nullable().optional(),
  agentStepId: z.string().min(1).nullable().optional(),
});

export const aiCodeActionRequestSchema = z.object({
  kind: z.enum([
    'explain_selection',
    'rewrite_selection',
    'generate_tests',
    'fix_diagnostic',
    'extract_function',
    'add_error_handling',
    'add_docs',
    'simplify_code',
    'convert_style',
  ]),
  filePath: z.string().nullable(),
  language: z.string(),
  selection: z.string(),
  diagnostics: z.array(z.string()),
});

export const aiCodeActionPayloadSchema = z.object({
  explanation: z.string(),
  suggestedPatch: aiPatchSetSchema.nullable(),
  testSuggestion: z.string().nullable(),
  followUpQuestions: z.array(z.string()),
});

export {
  aiAgentApprovePlanPayloadSchema,
  aiAgentApprovePlanRequestSchema, aiAgentChangedFileSchema,
  aiAgentChangedFileStatusSchema, aiAgentClassifyTaskPayloadSchema,
  aiAgentClassifyTaskRequestSchema, aiAgentListRunsPayloadSchema, aiAgentNetworkPermissionPayloadSchema,
  aiAgentNetworkPermissionSchema, aiAgentPatchSummarySchema, aiAgentPermissionLevelSchema,
  aiAgentPermissionScopeSchema,
  aiAgentPermissionStateSchema, aiAgentPlanPayloadSchema,
  aiAgentPlanReferenceSchema,
  aiAgentPlanReferenceTypeSchema,
  aiAgentPlanRequestSchema,
  aiAgentPlanRiskLevelSchema,
  aiAgentPlanStepKindSchema,
  aiAgentPlanStepStatusSchema, aiAgentResolveToolConfirmationRequestSchema, aiAgentRunIdRequestSchema,
  aiAgentRunPayloadSchema,
  aiAgentRunPlanRequestSchema,
  aiAgentRunSchema,
  aiAgentRunStatusSchema,
  aiAgentRunStepRequestSchema, aiAgentSetNetworkPermissionRequestSchema, aiAgentStepDetailSchema,
  aiAgentStepToolResultSummarySchema,
  aiAgentStepWebSourceSummarySchema, aiAgentTaskClassificationSchema,
  aiAgentTimelineItemSchema,
  aiAgentTimelineItemStatusSchema,
  aiAgentTimelineItemTypeSchema,
  aiAgentToolNameSchema,
  aiContextKindSchema,
  aiContextRangeSchema,
  aiContextReferenceSchema, aiDiffEditorPreviewSchema, aiDiffHunkPreviewSchema, aiDiffPreviewLineKindSchema,
  aiDiffPreviewLineSchema,
  aiTaskPlanStepSchema, aiWebActivityStateSchema, aiWebFetchInputSchema,
  aiWebFetchPayloadSchema,
  aiWebFetchResultSchema, aiWebSearchInputSchema,
  aiWebSearchIntentSchema,
  aiWebSearchPayloadSchema,
  aiWebSearchRecencySchema,
  aiWebSearchResultSchema,
  aiWebSourceEntryStatusSchema,
  aiWebSourceTypeSchema
};

