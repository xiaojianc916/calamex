/**
 * ACP prompt 回合契约 —— session/prompt 的请求/响应、停止原因，及 session/cancel 通知。
 *
 * 忠实镜像 agentclientprotocol/agent-client-protocol v1（src/v1/agent.rs）的稳定线上形状：
 * - PromptRequest  { sessionId, prompt: ContentBlock[] }（serde camelCase；#[non_exhaustive]）
 * - PromptResponse { stopReason }（紧随其后的 usage 字段在上游标注 **UNSTABLE**，稳定面不含；
 *   稳定面的 token 用量经 session/update 的 usage_update 上报，见 ./protocol 与 ./usage）
 * - StopReason     end_turn | max_tokens | max_turn_requests | refusal | cancelled（serde snake_case）
 * - CancelNotification { sessionId }（session/cancel；Agent 收到后须以 stopReason="cancelled" 回 session/prompt）
 *
 * 约定同 ./protocol：字段 camelCase、取值 snake_case、对象一律 .passthrough()（透传含 _meta 的未知字段）、
 * 开放枚举 .catch()。方法名常量见 ./jsonrpc 的 ACP_AGENT_METHODS，不在此重复定义。
 */
import { z } from "zod"

import { contentBlockSchema } from "./protocol.js"

// ---------------------------------------------------------------------------
// StopReason —— 一次 prompt 回合的终止原因（src/v1/agent.rs，snake_case，#[non_exhaustive]）
// ---------------------------------------------------------------------------

export const stopReasonSchema = z
	.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"])
	.catch("end_turn")
export type TStopReason = z.infer<typeof stopReasonSchema>

// ---------------------------------------------------------------------------
// session/prompt —— 请求与响应
// ---------------------------------------------------------------------------

/** PromptRequest：客户端发起一次 prompt 回合的入参。 */
export const promptRequestSchema = z
	.object({
		sessionId: z.string(),
		prompt: z.array(contentBlockSchema),
	})
	.passthrough()
export type TPromptRequest = z.infer<typeof promptRequestSchema>

/** PromptResponse：一次 prompt 回合完成时的出参（稳定面仅含 stopReason）。 */
export const promptResponseSchema = z
	.object({ stopReason: stopReasonSchema })
	.passthrough()
export type TPromptResponse = z.infer<typeof promptResponseSchema>

/** 构造 PromptResponse，镜像上游 `PromptResponse::new(stop_reason)`。 */
export const promptResponse = (stopReason: TStopReason): TPromptResponse => ({
	stopReason,
})

// ---------------------------------------------------------------------------
// session/cancel —— 取消通知（无响应；触发以 stopReason="cancelled" 收尾 session/prompt）
// ---------------------------------------------------------------------------

/** CancelNotification：客户端取消某会话进行中的 prompt 回合。 */
export const cancelNotificationSchema = z
	.object({ sessionId: z.string() })
	.passthrough()
export type TCancelNotification = z.infer<typeof cancelNotificationSchema>
