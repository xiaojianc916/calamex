import type { z } from 'zod';
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
