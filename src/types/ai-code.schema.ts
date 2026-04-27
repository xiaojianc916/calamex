import { z } from 'zod';
import { EAiSupportedLang } from '@/types/ai-code';

const supportedLangValues = Object.values(EAiSupportedLang) as [string, ...string[]];

export const aiSupportedLangSchema = z.enum(supportedLangValues);
export const aiLanguageDetectionSourceSchema = z.enum([
  'fence',
  'context',
  'shebang',
  'keyword',
  'auto',
  'fallback',
]);

export const fenceInfoSchema = z.object({
  rawInfo: z.string(),
  lang: aiSupportedLangSchema,
  meta: z.object({
    filePath: z.string().optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    isDiff: z.boolean().optional(),
    isApplyCandidate: z.boolean().optional(),
  }),
  detection: z.object({
    source: aiLanguageDetectionSourceSchema,
    confidence: z.number().min(0).max(1),
  }),
});

export const aiCodeBlockStreamStateSchema = z.enum(['open', 'closed', 'cancelled']);

export const aiCodeBlockSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
  index: z.number().int().nonnegative(),
  fence: fenceInfoSchema,
  content: z.string(),
  closed: z.boolean(),
  streamState: aiCodeBlockStreamStateSchema,
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
