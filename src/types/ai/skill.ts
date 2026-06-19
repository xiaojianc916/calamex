import type { z } from 'zod/v3';
import type {
  deleteSkillPayloadSchema,
  deleteSkillRequestSchema,
  saveSkillRequestSchema,
  skillDetailSchema,
  skillListSchema,
  skillSummarySchema,
} from './skill.schema';

export type ISkillSummary = z.infer<typeof skillSummarySchema>;
export type ISkillDetail = z.infer<typeof skillDetailSchema>;
export type ISkillList = z.infer<typeof skillListSchema>;
export type ISaveSkillRequest = z.infer<typeof saveSkillRequestSchema>;
export type IDeleteSkillRequest = z.infer<typeof deleteSkillRequestSchema>;
export type IDeleteSkillPayload = z.infer<typeof deleteSkillPayloadSchema>;

/**
 * 输入框内已选中的技能（以胶囊标签形式内联显示）。
 * 仅用于前端组合器状态：slug 用于去重 / 发送指令，name 用于展示。
 */
export interface ISelectedSkill {
  slug: string;
  name: string;
}
