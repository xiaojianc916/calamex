import { z } from 'zod';
import type { IAiChatMessage } from '@/types/ai';
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

/**
 * Thread 的 wire 形状由 schema 推断（单一来源），UI 层覆写 messages 为含 UI 衍生字段
 * 的消息。原定义自 legacy aiConversation store 迁来（该 store 已退役），作为 legacy
 * 适配器 / 持久化读路径的中立类型来源，杜绝对已删除 store 的依赖。
 */
type IAiConversationThreadWire = z.infer<typeof aiConversationThreadSchema>;
export interface IAiConversationThread extends Omit<IAiConversationThreadWire, 'messages'> {
  messages: IAiChatMessage[];
}

/**
 * 会话滚动位置快照。原定义自 legacy aiConversation store 迁来（该 store 已退役）；
 * 渲染侧（useAiAssistant 等）仍以此类型读写 thread.scrollState。
 */
export interface IAiConversationScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
  updatedAt: string;
}

/**
 * Thread 的 wire 形状由 schema 推断（单一来源），UI 层覆写 messages 为含 UI 衍生字段
 * 的消息。原定义自 @/store/aiConversation 迁来（该 legacy store 已退役），作为 legacy
 * 适配器 / 持久化读路径的中立类型来源，杜绝对已删除 store 的依赖。
 */
export interface IAiConversationThread extends Omit<IAiConversationThreadWire, 'messages'> {
  messages: IAiChatMessage[];
}

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
