/**
 * ask_user 反向提问 ↔ ACP elicitation 适配层。
 *
 * 与 approval-bridge.ts 同构：把运行时的 `ask_user_required` 输出事件投影为 ACP
 * `elicitation/create` 表单请求(unstable_createElicitation)，并把客户端回填的
 * CreateElicitationResponse 还原为运行时 resolveAskUser 所需的结构化解决输入。
 *
 * 设计要点：
 * - 每个待回填问题 → requestedSchema.properties 下一个以 questionId 为键的属性：
 *   - 有选项 + 多选 → array(items.anyOf 枚举 {const,title})；
 *   - 有选项 + 单选 → string(oneOf 枚举 {const,title})；yesno 由上游合成是/否选项，归此类；
 *   - 无选项        → string(自由文本)。
 * - message：单问取该问的 question 文案；多问取各问 header 以 " · " 连接。
 * - 回填还原：accept → outcome "selected" + 按问映射 answers；decline/cancel → "cancelled"。
 */
import type {
	CreateElicitationRequest,
	CreateElicitationResponse,
	ElicitationContentValue,
	ElicitationPropertySchema,
} from "@agentclientprotocol/sdk"
import { decodeApprovalRequestId } from "../engines/approval/utils.js"
import type { TAgentRuntimeOutputEvent } from "../engines/contracts/runtime-contracts.js"
import type {
	IAskUserAnswerInput,
	TAskUserResolutionOutcome,
} from "../engines/contracts/runtime-input.js"

/** 运行时输出事件中的待回填 ask_user 提问事件(判别联合窄化)。 */
export type TPendingAskUser = Extract<
	TAgentRuntimeOutputEvent,
	{ type: "ask_user_required" }
>

/** 单条待回填提问(从事件 request.questions 元素窄化)。 */
type TSurfacedQuestion = TPendingAskUser["request"]["questions"][number]

/** resolveAskUser 所需的最小解决输入(requestId / 会话上下文由调用方补齐)。 */
export interface IAskUserResolution {
	outcome: TAskUserResolutionOutcome
	answers?: IAskUserAnswerInput[]
}

/**
 * 在本次运行的输出事件中反向扫描最近一条待回填 ask_user 提问事件。
 * 与 findPendingApproval 同策略：取最后一条，确保多事件时命中最新挂起点。
 */
export function findPendingAskUser(
	events: readonly TAgentRuntimeOutputEvent[],
): TPendingAskUser | undefined {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index]
		if (event.type === "ask_user_required") {
			return event
		}
	}
	return undefined
}

/** 把单条待回填提问映射为一个 ACP elicitation 属性 schema。 */
function toPropertySchema(
	question: TSurfacedQuestion,
): ElicitationPropertySchema {
	const options = question.options ?? []
	if (options.length === 0) {
		return {
			type: "string",
			title: question.header,
			description: question.question,
		}
	}
	if (question.multiSelect === true) {
		return {
			type: "array",
			title: question.header,
			description: question.question,
			items: {
				anyOf: options.map((option) => ({
					const: option.optionId,
					title: option.label,
				})),
			},
		}
	}
	return {
		type: "string",
		title: question.header,
		description: question.question,
		oneOf: options.map((option) => ({
			const: option.optionId,
			title: option.label,
		})),
	}
}

/**
 * 把一条待回填 ask_user 提问事件投影为 ACP elicitation/create 表单请求。
 * requestId 形如 encodeApprovalRequestId(runId, toolCallId)，解码可得 toolCallId 关联工具调用。
 */
export function toCreateElicitationRequest(
	sessionId: string,
	pending: TPendingAskUser,
): CreateElicitationRequest {
	const questions = pending.request.questions
	const properties: Record<string, ElicitationPropertySchema> = {}
	for (const question of questions) {
		properties[question.questionId] = toPropertySchema(question)
	}
	const message =
		questions.length === 1
			? questions[0].question
			: questions.map((question) => question.header).join(" · ")
	const decoded = decodeApprovalRequestId(pending.requestId)
	return {
		mode: "form",
		sessionId,
		...(decoded?.toolCallId ? { toolCallId: decoded.toolCallId } : {}),
		requestedSchema: {
			type: "object",
			properties,
		},
		message,
	}
}

/** 把单条提问的回填值还原为运行时结构化答案。 */
function toAnswer(
	question: TSurfacedQuestion,
	value: ElicitationContentValue | undefined,
): IAskUserAnswerInput {
	const options = question.options ?? []
	if (options.length === 0) {
		return {
			questionId: question.questionId,
			optionIds: [],
			...(typeof value === "string" ? { text: value } : {}),
		}
	}
	if (question.multiSelect === true) {
		return {
			questionId: question.questionId,
			optionIds: Array.isArray(value) ? value : [],
		}
	}
	return {
		questionId: question.questionId,
		optionIds: typeof value === "string" ? [value] : [],
	}
}

/**
 * 把客户端 elicitation 回填响应还原为 resolveAskUser 解决输入。
 * accept → "selected" + 按原提问顺序映射 answers；decline/cancel → "cancelled"(不携 answers)。
 */
export function toAskUserResolutionInput(
	response: CreateElicitationResponse,
	pending: TPendingAskUser,
): IAskUserResolution {
	if (response.action !== "accept") {
		return { outcome: "cancelled" }
	}
	const content: Record<string, ElicitationContentValue> = response.content ?? {}
	const answers = pending.request.questions.map((question) =>
		toAnswer(question, content[question.questionId]),
	)
	return { outcome: "selected", answers }
}
