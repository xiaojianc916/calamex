import { z } from 'zod/v3';

import {
  aiChatMessageSchema,
  aiChatRequestSchema,
  aiChatStreamEventPayloadSchema,
  aiChatStreamPayloadSchema,
  aiConversationTitlePayloadSchema,
  aiConversationTitleRequestSchema,
} from '@/types/ai/schema';

export const aiConversationTitleStatusSchema = z.enum([
  'temporary',
  'generating',
  'generated',
  'failed',
]);

export const aiConversationScrollStateSchema = z.object({
  scrollTop: z.number().finite().nonnegative(),
  scrollHeight: z.number().finite().nonnegative(),
  clientHeight: z.number().finite().nonnegative(),
  distanceFromBottom: z.number().finite().nonnegative(),
  updatedAt: z.string().trim().min(1),
});

export const aiConversationThreadSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  titleStatus: aiConversationTitleStatusSchema.catch('temporary'),
  updatedAt: z.string().trim().min(1),
  createdAt: z.string().trim().min(1),
  messages: z.array(aiChatMessageSchema),
  scrollState: aiConversationScrollStateSchema.optional(),
});

export const aiConversationPersistSchema = z.object({
  activeThreadId: z.string().trim().min(1).nullable(),
  threads: z.array(aiConversationThreadSchema),
});

export const aiConversationLegacyPersistSchema = z.object({
  activeMessages: z.array(aiChatMessageSchema),
});

export {
  aiChatMessageSchema,
  aiChatRequestSchema,
  aiChatStreamEventPayloadSchema,
  aiChatStreamPayloadSchema,
  aiConversationTitlePayloadSchema,
  aiConversationTitleRequestSchema,
};
