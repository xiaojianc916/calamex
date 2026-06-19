import { z } from 'zod';

/* ============================================================================
 * 会话 / 线程共享 UI 元信息 schema（中立叶子模块，仅依赖 zod）
 *
 * titleStatus 与 scrollState 同时被两种表示共用：
 *   - 旧扁平 messages 模型 conversation.schema.ts（Step 8 将废弃删除）
 *   - 新 entries 模型 thread/entry.schema.ts（迁移后的单一真源）
 *
 * 它们原定义在 conversation.schema.ts，而 entry.schema.ts 反向 import 之 ——
 * 这是「幸存者依赖将被删者」的反向依赖；且一旦 conversation.schema 再 import
 * thread，即闭合为 conversation.schema -> thread -> entry.schema -> conversation.schema
 * 的模块求值期循环，触发 export const 的 TDZ ReferenceError（启动即崩）。
 * 抽到本叶子模块后，双方都只单向依赖它，环被彻底打断，Step 8 删除 legacy 也不连累。
 * ========================================================================== */

export const aiThreadTitleStatusSchema = z.enum(['temporary', 'generating', 'generated', 'failed']);

export const aiThreadScrollStateSchema = z.object({
  scrollTop: z.number().finite().nonnegative(),
  scrollHeight: z.number().finite().nonnegative(),
  clientHeight: z.number().finite().nonnegative(),
  distanceFromBottom: z.number().finite().nonnegative(),
  updatedAt: z.string().trim().min(1),
});

/**
 * 旧名别名：保持 conversation.schema 等既有 import 路径 / 标识符不变（行为等价）。
 * Step 8 清理 conversation.schema 时再统一收敛到 aiThread* 命名。
 */
export const aiConversationTitleStatusSchema = aiThreadTitleStatusSchema;
export const aiConversationScrollStateSchema = aiThreadScrollStateSchema;
