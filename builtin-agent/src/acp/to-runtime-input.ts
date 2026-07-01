/**
 * ACP session/prompt 入参 → 运行时输入的入站投影。
 *
 * 这是 from-runtime-event.ts 的入站对偶：后者把运行时富事件投影为 ACP SessionUpdate
 *（出站），本模块把 ACP PromptRequest 的 ContentBlock[] 投影为运行时 IAgentRuntimeInput
 *（入站）。纯函数、无状态、无 IO。
 *
 * ACP 语义：会话历史由 Agent 按 sessionId 自持（Mastra memory + threadId），故每次
 * session/prompt 只携带本回合的新输入；本模块据此构造单条 user 消息 + goal，历史由运行时
 * 凭 sessionId/threadId 召回，不在 prompt 内重放。
 *
 * 内容块取舍（忠实于 protocol.ts 的稳定 ContentBlock 形状）：
 * - text          → 拼接进 user 消息正文（模型可读的唯一内联文本）；
 * - resource_link → 追加一行「引用：<name>（<uri>）」，保留可见的上下文线索；
 * - resource      → 携带内联 text 则投影为「附件 <名>（<mime>）：<原文>」并入正文，否则按 uri 追加引用行；
 * - image / audio → 稳定面无内联文本，跳过（多模态注入由 promptCapabilities 协商，
 *                   属后续单元，不在文本投影内臆造）。
 */
import type {
	IAgentMessageInput,
	IAgentRuntimeInput,
	IAgentRuntimeModelConfigInput,
	TAgentMode,
} from "../engines/contracts/runtime-input.js"
import type { ContentBlock } from "@agentclientprotocol/sdk"

/** prompt 文本为空时的 goal 兑底，与 http.ts toAgentInput 的语义保持一致。 */
const EMPTY_PROMPT_GOAL = "继续当前任务"

/** 从 attachment:/// 资源 uri 取展示用文件名（末段）；无末段时回退整段 uri。 */
const attachmentDisplayName = (uri: string): string => {
	const withoutScheme = uri.replace(/^attachment:\/\/+/, "")
	const lastSegment = withoutScheme.split("/").pop()
	return lastSegment && lastSegment.length > 0 ? lastSegment : uri
}

/**
 * 把携带内联 text 的 embedded resource 投影为可读正文：以「附件 <名>（<mime>）：」抬头 + 换行 + 原文。
 * 抬头让模型明确这是随附文件及其类型，取代旧「裸 text 直拼」的无标注做法；mime 缺省时省略括号段。
 */
const attachmentResourceToText = (
	uri: string,
	text: string,
	mimeType?: string,
): string => {
	const name = attachmentDisplayName(uri)
	const header = mimeType ? `附件 ${name}（${mimeType}）` : `附件 ${name}`
	return `${header}：\n${text}`
}

/**
 * 把单个内容块投影为可并入 user 消息的纯文本片段；无文本可投影时返回 null。
 */
export const contentBlockToText = (block: ContentBlock): string | null => {
	switch (block.type) {
		case "text":
			return block.text
		case "resource_link":
			return `引用：${block.name}（${block.uri}）`
		case "resource": {
			const embedded = block.resource as {
				uri: string
				text?: unknown
				mimeType?: unknown
			}
			if (typeof embedded.text === "string" && embedded.text.length > 0) {
				return attachmentResourceToText(
					embedded.uri,
					embedded.text,
					typeof embedded.mimeType === "string" ? embedded.mimeType : undefined,
				)
			}
			return `引用：${embedded.uri}`
		}
		case "image":
		case "audio":
			return null
	}
}

/** 把 prompt 的内容块序列拼接为单条 user 消息正文（保序，丢弃空片段）。 */
export const promptToUserText = (prompt: readonly ContentBlock[]): string =>
	prompt
		.map(contentBlockToText)
		.filter((text): text is string => text !== null && text.length > 0)
		.join("\n\n")

/** 构造运行时输入所需的会话上下文（由会话登记表在 dispatcher 中提供）。 */
export interface IPromptRuntimeInputParams {
	sessionId: string
	mode: TAgentMode
	prompt: readonly ContentBlock[]
	workspaceRootPath?: string
	threadId?: string
	modelConfig?: IAgentRuntimeModelConfigInput
}

/**
 * 构造一次 session/prompt 回合的运行时输入。
 *
 * goal 与唯一的 user 消息均取自 prompt 的文本投影（空时回退到兑底 goal）；历史由运行时
 * 凭 sessionId/threadId 召回，不在此重放。可选字段仅在提供时写入，保持入参整洁
 *（与 http.ts toAgentInput 同风格）。
 */
export const buildPromptRuntimeInput = (
	params: IPromptRuntimeInputParams,
): IAgentRuntimeInput => {
	const text = promptToUserText(params.prompt)
	const goal = text.length > 0 ? text : EMPTY_PROMPT_GOAL
	const messages: IAgentMessageInput[] = [{ role: "user", content: goal }]
	const input: IAgentRuntimeInput = {
		mode: params.mode,
		goal,
		messages,
		sessionId: params.sessionId,
	}
	if (params.workspaceRootPath !== undefined) {
		input.workspaceRootPath = params.workspaceRootPath
	}
	if (params.threadId !== undefined) {
		input.threadId = params.threadId
	}
	if (params.modelConfig !== undefined) {
		input.modelConfig = params.modelConfig
	}
	return input
}
