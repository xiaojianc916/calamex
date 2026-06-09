/**
 * ACP（Agent Client Protocol）契约——本 sidecar 作为 ACP Agent 对外所说的唯一协议。
 *
 * 忠实镜像 agentclientprotocol/agent-client-protocol v1 的线上形状：serde 标签、
 * 取值用 snake_case、字段用 camelCase。所有对象 .passthrough()、所有开放枚举 .catch()，
 * 以遵循 ACP 的前向兼容约定（未知字段保留、未知枚举值回退、未知变体可被跳过）。
 *
 * 这是整个 AI 栈的单一事实来源：sidecar 发射端、Rust 转发层契约、前端消费端都以此为准。
 * 本模块只定义「协议形状」，不含任何运行时事件投影或传输逻辑（见后续单元）。
 */
import { z } from "zod"

/** ACP 主版本号。沿用 agent-client-protocol v1。 */
export const ACP_PROTOCOL_VERSION = 1 as const

// ---------------------------------------------------------------------------
// ContentBlock —— ACP 内容块（判别字段 = "type"）
// ---------------------------------------------------------------------------

export const contentBlockSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
	z
		.object({
			type: z.literal("image"),
			data: z.string(),
			mimeType: z.string(),
			uri: z.string().optional(),
		})
		.passthrough(),
	z
		.object({ type: z.literal("audio"), data: z.string(), mimeType: z.string() })
		.passthrough(),
	z
		.object({
			type: z.literal("resource_link"),
			uri: z.string(),
			name: z.string(),
			mimeType: z.string().optional(),
		})
		.passthrough(),
	z
		.object({
			type: z.literal("resource"),
			resource: z.object({ uri: z.string() }).passthrough(),
		})
		.passthrough(),
])
export type TContentBlock = z.infer<typeof contentBlockSchema>

/** 构造一个纯文本内容块。 */
export const textBlock = (text: string): TContentBlock => ({ type: "text", text })

// ---------------------------------------------------------------------------
// ToolCall —— 工具调用及其增量更新
// ---------------------------------------------------------------------------

export const toolKindSchema = z
	.enum([
		"read",
		"edit",
		"delete",
		"move",
		"search",
		"execute",
		"think",
		"fetch",
		"other",
	])
	.catch("other")
export type TToolKind = z.infer<typeof toolKindSchema>

export const toolCallStatusSchema = z
	.enum(["pending", "in_progress", "completed", "failed"])
	.catch("pending")
export type TToolCallStatus = z.infer<typeof toolCallStatusSchema>

/** 工具调用内容：嵌套内容块 / 文件 diff / 终端引用。 */
export const toolCallContentSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("content"), content: contentBlockSchema }).passthrough(),
	z
		.object({
			type: z.literal("diff"),
			path: z.string(),
			oldText: z.string().nullish(),
			newText: z.string(),
		})
		.passthrough(),
	z.object({ type: z.literal("terminal"), terminalId: z.string() }).passthrough(),
])
export type TToolCallContent = z.infer<typeof toolCallContentSchema>

export const toolCallLocationSchema = z
	.object({ path: z.string(), line: z.number().int().nonnegative().optional() })
	.passthrough()
export type TToolCallLocation = z.infer<typeof toolCallLocationSchema>

/** ToolCall / ToolCallUpdate 共享的字段集合。 */
const toolCallFields = {
	toolCallId: z.string(),
	kind: toolKindSchema.optional(),
	status: toolCallStatusSchema.optional(),
	content: z.array(toolCallContentSchema).optional(),
	locations: z.array(toolCallLocationSchema).optional(),
	rawInput: z.unknown().optional(),
	rawOutput: z.unknown().optional(),
}

/**
 * ToolCallUpdate —— 工具调用的部分更新（ACP `ToolCallUpdate`）。
 *
 * 即 `tool_call_update` 通知去掉 sessionUpdate 判别后的载荷，也是
 * `session/request_permission` 请求中描述待审批工具调用的形状。title 可选。
 */
export const toolCallUpdateSchema = z
	.object({ title: z.string().optional(), ...toolCallFields })
	.passthrough()
export type TToolCallUpdate = z.infer<typeof toolCallUpdateSchema>

// ---------------------------------------------------------------------------
// Plan —— 计划条目
// ---------------------------------------------------------------------------

export const planEntrySchema = z
	.object({
		content: z.string(),
		priority: z.enum(["high", "medium", "low"]).catch("medium"),
		status: z.enum(["pending", "in_progress", "completed"]).catch("pending"),
	})
	.passthrough()
export type TPlanEntry = z.infer<typeof planEntrySchema>

// ---------------------------------------------------------------------------
// SessionUpdate —— 会话流式通知（判别字段 = "sessionUpdate"）
// ---------------------------------------------------------------------------

export const sessionUpdateSchema = z.discriminatedUnion("sessionUpdate", [
	z
		.object({
			sessionUpdate: z.literal("user_message_chunk"),
			content: contentBlockSchema,
		})
		.passthrough(),
	z
		.object({
			sessionUpdate: z.literal("agent_message_chunk"),
			content: contentBlockSchema,
		})
		.passthrough(),
	z
		.object({
			sessionUpdate: z.literal("agent_thought_chunk"),
			content: contentBlockSchema,
		})
		.passthrough(),
	z
		.object({
			sessionUpdate: z.literal("tool_call"),
			title: z.string(),
			...toolCallFields,
		})
		.passthrough(),
	z
		.object({
			sessionUpdate: z.literal("tool_call_update"),
			title: z.string().optional(),
			...toolCallFields,
		})
		.passthrough(),
	z
		.object({
			sessionUpdate: z.literal("plan"),
			entries: z.array(planEntrySchema),
		})
		.passthrough(),
	z
		.object({
			sessionUpdate: z.literal("usage_update"),
			used: z.number(),
			size: z.number(),
			cost: z
				.object({ amount: z.number(), currency: z.string() })
				.passthrough()
				.nullish(),
		})
		.passthrough(),
])
export type TSessionUpdate = z.infer<typeof sessionUpdateSchema>

/** 会话通知信封：{ sessionId, update }。 */
export const sessionNotificationSchema = z
	.object({ sessionId: z.string(), update: sessionUpdateSchema })
	.passthrough()
export type TSessionNotification = z.infer<typeof sessionNotificationSchema>

/**
 * 宽松解析单条 SessionUpdate：成功返回规范化结果，未知变体 / 非法形状返回 null。
 * 用于消费侧按 ACP 前向兼容约定「跳过无法识别的更新」而非抛错。
 */
export const parseSessionUpdate = (value: unknown): TSessionUpdate | null => {
	const result = sessionUpdateSchema.safeParse(value)
	return result.success ? result.data : null
}

// ---------------------------------------------------------------------------
// session/request_permission —— 审批的 JSON-RPC 请求/结果
// ---------------------------------------------------------------------------

export const permissionOptionKindSchema = z
	.enum(["allow_once", "allow_always", "reject_once", "reject_always"])
	.catch("allow_once")
export type TPermissionOptionKind = z.infer<typeof permissionOptionKindSchema>

export const permissionOptionSchema = z
	.object({
		optionId: z.string(),
		name: z.string(),
		kind: permissionOptionKindSchema,
	})
	.passthrough()
export type TPermissionOption = z.infer<typeof permissionOptionSchema>

export const requestPermissionRequestSchema = z
	.object({
		sessionId: z.string(),
		toolCall: toolCallUpdateSchema,
		options: z.array(permissionOptionSchema),
	})
	.passthrough()
export type TRequestPermissionRequest = z.infer<
	typeof requestPermissionRequestSchema
>

export const requestPermissionOutcomeSchema = z.discriminatedUnion("outcome", [
	z.object({ outcome: z.literal("cancelled") }).passthrough(),
	z.object({ outcome: z.literal("selected"), optionId: z.string() }).passthrough(),
])
export type TRequestPermissionOutcome = z.infer<
	typeof requestPermissionOutcomeSchema
>

export const requestPermissionResponseSchema = z
	.object({ outcome: requestPermissionOutcomeSchema })
	.passthrough()
export type TRequestPermissionResponse = z.infer<
	typeof requestPermissionResponseSchema
>

/**
 * 构造一条 `session/request_permission` 请求（Agent → Client 方向）。
 * sidecar 作为 ACP Agent，在工具调用需要授权时发出该请求，并解析 Client 回复的
 * {@link TRequestPermissionResponse}.outcome 决定继续 / 取消。
 */
export const requestPermissionRequest = (
	sessionId: string,
	toolCall: TToolCallUpdate,
	options: readonly TPermissionOption[],
): TRequestPermissionRequest => ({
	sessionId,
	toolCall,
	options: [...options],
})
