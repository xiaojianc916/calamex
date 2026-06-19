import { z } from 'zod';

import { aiThreadSchema } from '@/types/ai/thread/entry.schema';

/* ============================================================================
 * AI Thread 持久化信封 schema（ADR-0014 Step 7.1）
 *
 * 对标现有 aiConversationPersistSchema（扁平 messages 持久化），区别在于线程改用
 * entries 模型（aiThreadSchema）取代扁平 messages。新增 version 版本号，为后续
 * v1->vN 结构迁移留出兼容位（沿用 aiConversation 的 hydrate 容错思路）。
 *
 * 单一真源：schema 在此定义，类型由 z.infer 推导，严禁手写并行接口。
 * 本文件为纯新增，未接线进任何 store hydrate（接线在 Step 7.3 完成），故零行为变化。
 * ========================================================================== */

/** 当前 entries 持久化结构版本。发生结构破坏性变更时 +1，并补对应迁移分支。 */
export const AI_THREAD_PERSIST_VERSION = 1;

export const aiThreadPersistSchema = z.object({
  /**
   * 结构版本号；缺省 / 非法兑底为当前版本。
   * 旧快照无此字段时按当前版本处理，避免因缺字段整库 parse 失败。
   */
  version: z.number().int().positive().catch(AI_THREAD_PERSIST_VERSION),
  activeThreadId: z.string().trim().min(1).nullable(),
  threads: z.array(aiThreadSchema),
});

/** 持久化信封类型（z.infer 推导，单一真源）。 */
export type IAiThreadPersist = z.infer<typeof aiThreadPersistSchema>;
