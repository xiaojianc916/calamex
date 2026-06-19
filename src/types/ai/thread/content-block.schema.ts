import { z } from 'zod/v3';

/* ============================================================================
 * ContentBlock（对标 Zed `ContentBlock`）
 *
 * 判别联合，`type` 为判别字段。覆盖流式思维链 UI 所需的富块：
 * - text：普通 markdown 文本（交给 markstream-vue 渲染）
 * - image：图片（截图中“找到的图片”）
 * - resource_link：资源链接
 * - source：引用来源 / 域名 chips
 *
 * 注：diff / terminal 不属于 ContentBlock，而是 `ToolCallContent` 的独立
 * variant（见 `tool-call.schema.ts`），与 Zed 一致。
 * ========================================================================== */

export const aiThreadTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const aiThreadImageBlockSchema = z.object({
  type: z.literal('image'),
  src: z.string().min(1),
  alt: z.string().optional(),
});

export const aiThreadResourceLinkBlockSchema = z.object({
  type: z.literal('resource_link'),
  uri: z.string().min(1),
  title: z.string().optional(),
});

export const aiThreadSourceBlockSchema = z.object({
  type: z.literal('source'),
  url: z.string().min(1),
  title: z.string().optional(),
  favicon: z.string().optional(),
});

export const aiThreadContentBlockSchema = z.discriminatedUnion('type', [
  aiThreadTextBlockSchema,
  aiThreadImageBlockSchema,
  aiThreadResourceLinkBlockSchema,
  aiThreadSourceBlockSchema,
]);
