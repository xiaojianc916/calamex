import { z } from 'zod';

import {
  aiChatMessageSchema,
  aiChatRequestSchema,
  aiChatStreamEventPayloadSchema,
  aiChatStreamPayloadSchema,
  aiConversationTitlePayloadSchema,
  aiConversationTitleRequestSchema,
} from '@/types/ai/schema';
import {
  aiConversationScrollStateSchema,
  aiConversationTitleStatusSchema,
} from '@/types/ai/thread/meta.schema';

// titleStatus / scrollState 已抽到中立叶子模块 @/types/ai/thread/meta.schema，
// 以解除「新 entries 模型反向依赖将被删除的 legacy 模型」并杜绝求值期循环。
// 此处从该模块导入并 re-export（旧名），保持对外 import 路径与行为不变。
export { aiConversationScrollStateSchema, aiConversationTitleStatusSchema };

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
