import { z } from 'zod';

export const aiProviderTypeSchema = z.enum([
  'mock',
  'openai',
  'deepseek',
  'moonshot',
  'dashscope',
  'zhipu',
  'siliconflow',
  'openai-compatible',
  'claude-compatible',
  'local',
  'custom-gateway',
]);

export const aiContextKindSchema = z.enum([
  'current-file',
  'selection',
  'cursor-window',
  'diagnostics',
  'git-diff',
  'terminal-log',
  'search-result',
  'symbol-definition',
  'symbol-references',
  'project-tree',
]);

export const aiContextReferenceSchema = z.object({
  id: z.string().min(1),
  kind: aiContextKindSchema,
  label: z.string().min(1),
  path: z.string().nullable(),
  range: z.object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }).nullable(),
  contentPreview: z.string(),
  redacted: z.boolean(),
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
  })).optional(),
  stream: z.object({
    stableContent: z.string(),
    openBlock: z.unknown().nullable(),
    status: z.enum(['streaming', 'completed', 'cancelled']),
  }).optional(),
});

export const aiConfigPayloadSchema = z.object({
  providerType: aiProviderTypeSchema,
  selectedModel: z.string().nullable(),
  baseUrl: z.string().nullable(),
  isBaseUrlConfigured: z.boolean(),
  hasCredentials: z.boolean(),
  isConfigured: z.boolean(),
  inlineCompletionEnabled: z.boolean(),
  chatEnabled: z.boolean(),
  agentEnabled: z.boolean(),
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

export const aiAgentPlanRequestSchema = z.object({
  goal: z.string(),
  context: z.array(aiContextReferenceSchema),
});

export const aiAgentPlanPayloadSchema = z.object({
  steps: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'requires-confirmation']),
  })),
});
