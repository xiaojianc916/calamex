/**
 * ACP 会话配置选项契约 —— Agent 在 session/new、session/load 响应中可选公布的配置选择器，
 * 以及 session/set_config_option 的运行时变更。
 *
 * 忠实镜像 agentclientprotocol/agent-client-protocol v1 的稳定 JSON Schema（schema/v1/schema.json）：
 * - SessionConfigId / SessionConfigValueId / SessionConfigGroupId  （string newtype）
 * - SessionConfigOptionCategory  语义分类（mode | model | thought_level | 自定义字符串；仅 UX 提示，须容忍未知）
 * - SessionConfigSelectOption    { value, name, description? }      单个可选值
 * - SessionConfigSelectGroup     { group, name, options }          分组
 * - SessionConfigSelectOptions   Ungrouped(option[]) | Grouped(group[])
 * - SessionConfigSelect          { currentValue, options }         下拉选择器载荷
 * - SessionConfigOption          discriminated(type)：当前仅 "select" 变体 + 基础字段 { id, name, description?, category? }
 * - SetSessionConfigOption{Request,Response}  session/set_config_option
 *
 * 约定同 ./protocol：字段 camelCase、对象一律 .passthrough()（透传含 _meta 的未知字段）。
 * Category 末位为开放字符串变体，语义上即任意字符串，故建模为 z.string()（保留常量见注释），
 * 与 spec“客户端须优雅处理缺失或未知分类”一致。
 * config_option_update 这一 SessionUpdate 变体归 ./protocol 的 sessionUpdate 统辖，不在本槽建模。
 */
import { z } from "zod"

// 标识 newtype
export const sessionConfigIdSchema = z.string()
export type TSessionConfigId = z.infer<typeof sessionConfigIdSchema>

export const sessionConfigValueIdSchema = z.string()
export type TSessionConfigValueId = z.infer<typeof sessionConfigValueIdSchema>

export const sessionConfigGroupIdSchema = z.string()
export type TSessionConfigGroupId = z.infer<typeof sessionConfigGroupIdSchema>

/** 保留常量：mode | model | thought_level；其余（含 _ 前缀自定义）按任意字符串处理。 */
export const sessionConfigOptionCategorySchema = z.string()
export type TSessionConfigOptionCategory = z.infer<typeof sessionConfigOptionCategorySchema>

/** SessionConfigSelectOption：单个可选值。 */
export const sessionConfigSelectOptionSchema = z
	.object({
		value: sessionConfigValueIdSchema,
		name: z.string(),
		description: z.string().nullish(),
	})
	.passthrough()
export type TSessionConfigSelectOption = z.infer<typeof sessionConfigSelectOptionSchema>

/** SessionConfigSelectGroup：一组可选值。 */
export const sessionConfigSelectGroupSchema = z
	.object({
		group: sessionConfigGroupIdSchema,
		name: z.string(),
		options: z.array(sessionConfigSelectOptionSchema),
	})
	.passthrough()
export type TSessionConfigSelectGroup = z.infer<typeof sessionConfigSelectGroupSchema>

/** SessionConfigSelectOptions：未分组 option[] 或分组 group[]。 */
export const sessionConfigSelectOptionsSchema = z.union([
	z.array(sessionConfigSelectOptionSchema),
	z.array(sessionConfigSelectGroupSchema),
])
export type TSessionConfigSelectOptions = z.infer<typeof sessionConfigSelectOptionsSchema>

/** SessionConfigOption 的 select 变体：基础字段 + 下拉选择器载荷。 */
const sessionConfigSelectVariantSchema = z
	.object({
		type: z.literal("select"),
		id: sessionConfigIdSchema,
		name: z.string(),
		description: z.string().nullish(),
		category: sessionConfigOptionCategorySchema.nullish(),
		currentValue: sessionConfigValueIdSchema,
		options: sessionConfigSelectOptionsSchema,
	})
	.passthrough()

/** SessionConfigOption：以 type 判别的配置选择器（当前仅 select 单值下拉，可扩展）。 */
export const sessionConfigOptionSchema = z.discriminatedUnion("type", [
	sessionConfigSelectVariantSchema,
])
export type TSessionConfigOption = z.infer<typeof sessionConfigOptionSchema>

/** SetSessionConfigOptionRequest：session/set_config_option 请求。 */
export const setSessionConfigOptionRequestSchema = z
	.object({
		sessionId: z.string(),
		configId: sessionConfigIdSchema,
		value: sessionConfigValueIdSchema,
	})
	.passthrough()
export type TSetSessionConfigOptionRequest = z.infer<typeof setSessionConfigOptionRequestSchema>

/** SetSessionConfigOptionResponse：返回全部配置选项及其当前值。 */
export const setSessionConfigOptionResponseSchema = z
	.object({
		configOptions: z.array(sessionConfigOptionSchema),
	})
	.passthrough()
export type TSetSessionConfigOptionResponse = z.infer<typeof setSessionConfigOptionResponseSchema>

/** 构造 session/set_config_option 响应。 */
export const setSessionConfigOptionResponse = (
	configOptions: TSessionConfigOption[],
): TSetSessionConfigOptionResponse => ({ configOptions })
