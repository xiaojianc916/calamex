import { z } from 'zod/v3';

import { AI_AGENT_CHANGED_FILE_STATUSES, AI_DIFF_PREVIEW_LINE_KINDS } from '@/types/ai/patch';

export const aiAgentChangedFileStatusSchema = z.enum(AI_AGENT_CHANGED_FILE_STATUSES);

export const aiDiffPreviewLineKindSchema = z.enum(AI_DIFF_PREVIEW_LINE_KINDS);

export const aiAgentChangedFileSchema = z.object({
  path: z.string().min(1),
  status: aiAgentChangedFileStatusSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  diffRef: z.string().min(1),
  rollbackRef: z.string().min(1).optional(),
});

export const aiAgentPatchSummarySchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  files: z.array(aiAgentChangedFileSchema),
  totalAdditions: z.number().int().nonnegative(),
  totalDeletions: z.number().int().nonnegative(),
  patchRef: z.string().min(1),
  appliedAt: z.string().min(1).optional(),
  revertedAt: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
});

export const aiDiffPreviewLineSchema = z.object({
  id: z.string().min(1),
  kind: aiDiffPreviewLineKindSchema,
  content: z.string(),
  oldLineNumber: z.number().int().nonnegative().optional(),
  newLineNumber: z.number().int().nonnegative().optional(),
});

export const aiDiffHunkPreviewSchema = z.object({
  id: z.string().min(1),
  filePath: z.string().min(1),
  diffRef: z.string().min(1),
  header: z.string().min(1),
  lines: z.array(aiDiffPreviewLineSchema),
});

export const aiDiffEditorPreviewSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  filePath: z.string().min(1),
  diffRef: z.string().min(1),
  patchRef: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  hunks: z.array(aiDiffHunkPreviewSchema),
});
