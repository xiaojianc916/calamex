/**
 * calamex 专有的 ACP 值构造器。
 *
 * 协议类型已统一由 @agentclientprotocol/sdk 提供(单一事实来源),但 SDK 只导出类型、不含值构造器;
 * 本模块补足投影层高频使用的两个零依赖小构造器,保持调用点整洁:
 * - textBlock      —— 纯文本 ContentBlock(agent_message_chunk / tool_call 内容等)。
 * - promptResponse —— 仅含 stopReason 的 PromptResponse(稳定面;token 用量经 usage_update 上报)。
 */
import type {
	ContentBlock,
	PromptResponse,
	StopReason,
} from "@agentclientprotocol/sdk"

/** 构造一个纯文本内容块。 */
export const textBlock = (text: string): ContentBlock => ({ type: "text", text })

/** 构造 PromptResponse,镜像上游 `PromptResponse::new(stop_reason)`。 */
export const promptResponse = (stopReason: StopReason): PromptResponse => ({
	stopReason,
})
