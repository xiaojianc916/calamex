/**
 * ACP 审批桥接（approval ⇄ session/request_permission）。
 *
 * Calamex runtime 的审批模型是「跨请求挂起/恢复」，而 ACP 的权限请求是「回合内反向 RPC」，
 * 二者语义不同，必须在 ACP Agent 的 prompt 回合内做桥接。本模块是这层桥接的纯函数投影
 * （无 IO、无状态），把不可臆造的两端形状固定下来；有状态的「请求权限 → 回灌 resolveApproval
 * → 续跑」编排循环在 acp/agent.ts 的 prompt 处理器里完成。
 *
 * 端到端事实（对照 engines/base.ts、engines/approval-client/、schemas/events.ts，均一手核对）：
 * - runtime.execute() 命中危险/暂停工具时：
 *     · registerPendingApproval 以 encodeApprovalRequestId(runId, toolCallId, path?) 生成 request.id，
 *       缓存进内存 pendingApprovals（同一 runtime 实例），并令 releaseResources=false 保活资源；
 *     · emit 一条 { type:'approval_required', request } 富事件，并以 result:null 收尾本次调用。
 * - 之后 runtime.resolveApproval({ requestId: request.id, decision }) 命中该缓存（或经 libSQL 重建
 *   可恢复上下文）恢复 Mastra 流。因 ACP Agent 全连接持有同一 runtime 实例，回合内回灌必命中缓存。
 * - ACP 侧（镜像 gemini-cli acpSession.ts / acpUtils.ts）在单次 session/prompt 内 inline 调用
 *   connection.requestPermission(...) 取得用户裁决，再续跑同一回合。
 *
 * 设计准则（遵循既定决策）：会话内审批一律走官方 session/request_permission（非 _calamex.dev 扩展方法），
 * 复用引擎既有 suspend/resume，不自创审批判定；选项/工具内容映射镜像 acpUtils.ts 的稳定形状。
 */
import type {
	PermissionOption,
	RequestPermissionRequest,
	RequestPermissionResponse,
} from "@agentclientprotocol/sdk"
import { decodeApprovalRequestId } from "../engines/approval-client/utils.js"
import type { TAgentRuntimeOutputEvent } from "../engines/contracts/runtime-contracts.js"
import type { TApprovalDecision } from "../engines/contracts/runtime-input.js"
import { inferToolKind } from "./from-runtime-event.js"
import { textBlock } from "./helpers.js"

/** 运行时 approval_required 输出事件（从权威联合类型收窄，避免字段臆造）。 */
type TApprovalRequiredEvent = Extract<
	TAgentRuntimeOutputEvent,
	{ type: "approval_required" }
>

/** 待裁决的审批请求载荷（即 approval_required 事件的 request 字段）。 */
export type TPendingApproval = TApprovalRequiredEvent["request"]

/**
 * 稳定 optionId —— 既作为 ACP PermissionOption.optionId 下发，也用于回灌时判定裁决。
 * 取值保持人类可读，且与 approval-client/utils 的放行语义（allow / allow-once…）一致。
 */
export const APPROVAL_OPTION_ALLOW_ONCE = "allow-once" as const
export const APPROVAL_OPTION_REJECT = "reject-once" as const

/** 选中即视为放行的 optionId 集合；其余 selected 视为拒绝，cancelled 视为取消。 */
const APPROVE_OPTION_IDS: ReadonlySet<string> = new Set<string>([
	APPROVAL_OPTION_ALLOW_ONCE,
])

/**
 * 从一次 runtime 响应的事件序列中取出待裁决审批（取最后一条）。
 *
 * 一次 execute/resolveApproval 调用至多挂起在一个工具上；逆序取最后一条是对
 * 「未来同一回合多次 emit」的保守兼容，不改变当前单挂起语义。
 */
export const findPendingApproval = (
	events: ReadonlyArray<TAgentRuntimeOutputEvent>,
): TPendingApproval | null => {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index]
		if (event && event.type === "approval_required") {
			return event.request
		}
	}
	return null
}

/**
 * approval_required → ACP RequestPermissionRequest。
 *
 * toolCall.toolCallId 取自审批 token 解码出的原始 Mastra toolCallId，使本权限请求与回合内
 * 已下发的 tool_call / tool_call_update 通知（其 toolUseId 同源）正确配对；解码失败时退回 request.id。
 * toolCall.kind 复用 from-runtime-event 的 inferToolKind(request.toolName)，与同一 toolUseId 的
 * tool_call / tool_call_update 通知保持一致的 UI 分类（kind 仅用于图标/分组，schema 对未知值
 * .catch("other")；审批「判定」另由 MCP annotations 决定，不受此处影响）。镜像 codex-acp
 * 「按工具语义赋 kind、认不出用 Other」的做法，不在此另立名字映射，也不臆造「永久允许」策略。
 * 仅提供「允许一次 / 拒绝」两个选项。
 */
export const toRequestPermissionRequest = (
	sessionId: string,
	request: TPendingApproval,
): RequestPermissionRequest => {
	const decoded = decodeApprovalRequestId(request.id)
	const toolCallId = decoded?.toolCallId ?? request.id
	const options: PermissionOption[] = [
		{ optionId: APPROVAL_OPTION_ALLOW_ONCE, name: "允许", kind: "allow_once" },
		{ optionId: APPROVAL_OPTION_REJECT, name: "拒绝", kind: "reject_once" },
	]
	return {
		sessionId,
		options,
		toolCall: {
			toolCallId,
			status: "pending",
			title: request.question,
			kind: inferToolKind(request.toolName),
			content: [{ type: "content", content: textBlock(request.summary) }],
		},
	}
}

/**
 * ACP RequestPermissionResponse.outcome → runtime 审批裁决。
 *
 * cancelled → 'cancel'；selected 且 optionId 属放行集合 → 'approve'；其余 selected → 'reject'。
 * 与 approval-client/utils.isApprovedDecision 的「仅明确放行才放行、否则 fail-closed」一致。
 */
export const toApprovalDecision = (
	response: RequestPermissionResponse,
): TApprovalDecision => {
	const outcome = response.outcome
	if (outcome.outcome === "cancelled") {
		return "cancel"
	}
	return APPROVE_OPTION_IDS.has(outcome.optionId) ? "approve" : "reject"
}
