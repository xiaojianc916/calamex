import { z } from 'zod';

/** 技能 slug:小写字母 / 数字 / 连字符,与 Rust 侧 validate_slug 保持一致。 */
export const SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const SKILL_CONTENT_MAX_BYTES = 1_000_000;

export const skillSlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(SKILL_SLUG_PATTERN, 'slug 仅允许小写字母、数字与连字符,且不能以连字符开头或结尾。');

/** 列表项:轻量摘要,用于技能库列表与 / 菜单。 */
export const skillSummarySchema = z.object({
  slug: skillSlugSchema,
  name: z.string().min(1),
  description: z.string(),
  updatedAtMs: z.number().nonnegative(),
});

/** 详情:含 SKILL.md 正文与磁盘路径。 */
export const skillDetailSchema = skillSummarySchema.extend({
  content: z.string(),
  path: z.string().min(1),
});

export const skillListSchema = z.object({
  rootPath: z.string().min(1),
  skills: z.array(skillSummarySchema),
});

/**
 * 保存请求:
 * - `slug === null` 表示新建(后端按 name 生成 slug);
 * - 非空 slug 表示更新既有技能。
 */
export const saveSkillRequestSchema = z.object({
  slug: skillSlugSchema.nullable(),
  name: z.string().min(1).max(120),
  description: z.string().max(2_000),
  content: z.string().max(SKILL_CONTENT_MAX_BYTES),
});

export const deleteSkillRequestSchema = z.object({
  slug: skillSlugSchema,
});

export const deleteSkillPayloadSchema = z.object({
  slug: skillSlugSchema,
});
