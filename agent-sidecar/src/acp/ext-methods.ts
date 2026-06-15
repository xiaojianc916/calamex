/**
 * sidecar 作为 ACP Agent 的「扩展方法」(ext methods)定义与能力公示。
 *
 * ACP 是围绕「会话回合」(session/prompt)的固定协议：那些真正「带外」的能力——
 * 不属于任何 prompt 回合——没有标准 wire 形态。遵循 SDK 指引（扩展方法用域名前缀
 * 避免冲突）与 Zed 的 _meta 纪律，这类能力经 AgentSideConnection 的 ext 通道暴露，
 * 并在 initialize 的 `agentCapabilities._meta` 下以命名空间公示供我方宙主发现；
 * 一个不识别这些扩展的标准客户端（如 Zed）会安全忽略，核心会话流不受影响。
 *
 * 扩展清单（均挂在同一 calamex.dev 命名空间下，镜像 checkpoint/restore 先例）：
 * - checkpoint/restore：检查点回滚（runtime.restoreCheckpoint）。
 * - model/chat：原始模型透传（runtime.modelChat）——一次性、无工具/记忆/历史、不套 agent
 *   系统提示，调用方 messages（含 system）原样下发；承载标题生成 / 行内补全 / 连接测试等
 *   「工具型」模型调用，仿 Zed 的独立模型请求；不实现该可选能力时返回 methodNotFound。
 * - agent/chat、agent/chat/resolve：agent 模式对话回合（runtime.chat / runtime.resolveApproval）
 *   的「带外」承载。ACP 原生 session/prompt 的 session/update 投影是有损的（仅文本/思考
 *   增量），会丢失结构化补丁 / 检查点 / 回滚 / 富审批字段 / plan_ready 等 agent UI 词表；
 *   故这两个扩展把过程增量经 session/update 仅作实时预览下发，真正权威的富事件由方法
 *   返回值的完整 toAgentSidecarResponse 信封承载（与旧 HTTP /agent/chat 同构，前端无感）。
 * - agent/ask-user/resume：ask_user 反向提问（HITL）挂起恢复（runtime.resolveAskUser）。
 *   agent/chat/resolve 的姊妹方法：上一段信封里的 ask_user_required 事件携 requestId，
 *   本方法携用户回填的 outcome + 结构化 answers 回灌挂起的 ask_user 工具续跑同一回合。
 *   不复用 session/request_permission（扁平 approve/reject 选项无法表达多问多选表单），
 *   也不复用 agent/chat/resolve（其 decision-only 入参无法承载富答案）。
 * - web/search、web/fetch：应用级网络检索/抓取（由宙主的 ai::tools 调用，非 agent 工具）。
 * - warmup：LLM 连接预热（宙主启动时显式调用，缩短首 prompt 首字延迟）。
 * - health：健康/活性探活 + MCP 运行状态快照。
 * - plan/orchestrate、plan/orchestrate/resume：原生计划编排（runtime.buildPlanOrchestrationWorkflow）
 *   的启动与挂起恢复；过程事件经会话的 session/update 流式下发，挂起/终态信封
 *   { runId, status, result } 作为方法返回值（由 acp/orchestration.ts 的 runner 执行）。
 *
 * 模型代理谈（model-proxy）与叙述生成（narrator）不在此列：二者在旧 http 期即与
 * `/agent/chat` 共用同一 `runtime.chat`(ask) 处理器，在 ACP 下天然归为 ask 模式的 prompt 回合，
 * 无需单独扩展。检查点长期可像 Zed 那样归到宙主侧 git_store，届时该扩展整体退役。
 * 本模块为纯函数 + 常量（及类型投影），无 I/O、无状态；I/O 由 agent.ts 的 ext 处理器承担。
 */
import { z } from "zod"

import type { IWarmupResult } from "../models/llm-warmup.js"
import type { IMcpRuntimeStatus } from "../tools/mcp.js"
import {
	toAgentSidecarResponse,
	type IAgentRuntimeResponse,
} from "../engines/contracts/runtime-contracts.js"
import type {
	IAgentMessageInput,
	IApprovalResolutionInput,
	IAskUserResolutionInput,
	IAgentRuntimeInput,
	IAgentRuntimeModelConfigInput,
	ICheckpointRestoreInput,
} from "../engines/contracts/runtime-input.js"
import type { TAgentSidecarResponse } from "../schemas/events.js"

/** 我方扩展命名空间（反向域名，避免与其他 ACP 实现的扩展冲突）。 */
export const CALAMEX_EXT_NAMESPACE = "calamex.dev"

/** 检查点回滚扩展方法名（域名前缀 + 资源/动作，镜像 ACP 的 `session/prompt` 命名风格）。 */
export const CHECKPOINT_RESTORE_METHOD = `${CALAMEX_EXT_NAMESPACE}/checkpoint/restore`

/**
 * 原始模型透传扩展方法名（仿 Zed 的独立模型请求）。
 * 一次性、无工具、无记忆、不读历史、不套 agent 系统提示；调用方 messages（含 system）原样下发。
 */
export const MODEL_CHAT_METHOD = `${CALAMEX_EXT_NAMESPACE}/model/chat`

/** 网络检索/抓取扩展方法名。 */
export const WEB_SEARCH_METHOD = `${CALAMEX_EXT_NAMESPACE}/web/search`
export const WEB_FETCH_METHOD = `${CALAMEX_EXT_NAMESPACE}/web/fetch`

/** LLM 连接预热扩展方法名。 */
export const WARMUP_METHOD = `${CALAMEX_EXT_NAMESPACE}/warmup`

/** 健康/活性探活扩展方法名。 */
export const HEALTH_METHOD = `${CALAMEX_EXT_NAMESPACE}/health`

/** 原生计划编排扩展方法名（跑到挂起/终态，过程事件经 session/update 流式下发）。 */
export const ORCHESTRATE_METHOD = `${CALAMEX_EXT_NAMESPACE}/plan/orchestrate`
/** 编排挂起点恢复扩展方法名（计划审批门 / 工具审批 / 逐步闸门通用）。 */
export const ORCHESTRATE_RESUME_METHOD = `${CALAMEX_EXT_NAMESPACE}/plan/orchestrate/resume`

/**
 * agent 对话回合扩展方法名（run-to-gate：跑到审批门或终态，返回完整响应信封）。
 * 镜像旧 HTTP `/agent/chat` → `runtime.chat(toAgentInput(payload), options)`；过程增量经
 * session/update 仅作实时预览，权威富事件由返回信封承载。
 */
export const AGENT_CHAT_METHOD = `${CALAMEX_EXT_NAMESPACE}/agent/chat`
/**
 * agent 对话审批恢复扩展方法名（裁决后续跑同一回合，返回下一段响应信封）。
 * 镜像旧 HTTP `/approval/resolve` → `runtime.resolveApproval(parse(body), options)`。
 */
export const AGENT_CHAT_RESOLVE_METHOD = `${CALAMEX_EXT_NAMESPACE}/agent/chat/resolve`
/**
 * ask_user 反向提问（HITL）恢复扩展方法名。agent/chat/resolve 的姊妹方法：携上一段
 * 信封里 ask_user_required 事件的 requestId 与用户回填的 outcome + 结构化 answers，
 * 经 `runtime.resolveAskUser` 回灌挂起的 ask_user 工具续跑同一回合。
 */
export const AGENT_ASK_USER_RESUME_METHOD = `${CALAMEX_EXT_NAMESPACE}/agent/ask-user/resume`

/**
 * sidecar 构建身份版本号（从旧 http server.ts 迁入，使其在 server.ts 删除后仍成立）。
 * 这是 sidecar *实现* 的版本标记，与 ACP 协议本身的 PROTOCOL_VERSION 解耦；仅用于 health
 * 投影中填充宙主侧 AgentSidecarHealthPayload 的 protocol/implementation 字段，保持契约稳定。
 */
export const SIDECAR_PROTOCOL_VERSION = "7"
export const SIDECAR_IMPLEMENTATION_VERSION =
	"deepseek-reasoning-transport-v6-plan-history"

/**
 * initialize 时挂在 `agentCapabilities._meta` 下的扩展公示。
 * 宙主据 `_meta["calamex.dev"].extMethods` 发现可用扩展；标准客户端忽略本键。
 */
export const CALAMEX_AGENT_CAPABILITY_META: Record<string, unknown> = {
	[CALAMEX_EXT_NAMESPACE]: {
		extMethods: {
			checkpointRestore: CHECKPOINT_RESTORE_METHOD,
			modelChat: MODEL_CHAT_METHOD,
			webSearch: WEB_SEARCH_METHOD,
			webFetch: WEB_FETCH_METHOD,
			warmup: WARMUP_METHOD,
			health: HEALTH_METHOD,
			orchestrate: ORCHESTRATE_METHOD,
			orchestrateResume: ORCHESTRATE_RESUME_METHOD,
			agentChat: AGENT_CHAT_METHOD,
			agentChatResolve: AGENT_CHAT_RESOLVE_METHOD,
			agentAskUserResume: AGENT_ASK_USER_RESUME_METHOD,
		},
	},
}

/** 请求级模型配置 schema（自包含，不依赖 http 期的 server/request-schemas）。 */
const modelConfigParamsSchema = z.object({
	modelId: z.string().trim().min(1),
	apiKey: z.string().trim().min(1),
	baseUrl: z.string().trim().min(1).optional(),
})

/** 把单字符串归一为单元素数组，结构兼容 `TRollbackStepPath = readonly string[]`。 */
const rollbackStepParamsSchema = z.preprocess(
	(value) => (typeof value === "string" ? [value] : value),
	z.array(z.string().trim().min(1)).min(1),
)

/**
 * 检查点回滚扩展方法的入参 schema。字段与 `ICheckpointRestoreInput` 一一对应，
 * 也与旧 http 的 `agentSidecarRollbackRestoreRequestSchema` 等价（此处自包含重述，
 * 以便删除 server/ 后本扩展独立成立）。
 */
export const checkpointRestoreParamsSchema = z.object({
	runId: z.string().trim().min(1),
	snapshotId: z.string().trim().min(1).optional(),
	step: rollbackStepParamsSchema.optional(),
	sessionId: z.string().trim().min(1).optional(),
	modelConfig: modelConfigParamsSchema.optional(),
})

/**
 * 校验并投影扩展入参为运行时输入。可选字段仅在提供时写入，保持入参整洁
 * （与 to-runtime-input.ts 的 buildPromptRuntimeInput 同风格）。
 * 入参非法时抛出 ZodError，由 SDK 连接层映射为 JSON-RPC error（与标准方法一致）。
 */
export const parseCheckpointRestoreParams = (
	params: Record<string, unknown>,
): ICheckpointRestoreInput => {
	const parsed = checkpointRestoreParamsSchema.parse(params)
	const input: ICheckpointRestoreInput = { runId: parsed.runId }
	if (parsed.snapshotId !== undefined) input.snapshotId = parsed.snapshotId
	if (parsed.step !== undefined) input.step = parsed.step
	if (parsed.sessionId !== undefined) input.sessionId = parsed.sessionId
	if (parsed.modelConfig !== undefined) input.modelConfig = parsed.modelConfig
	return input
}

/**
 * 把回滚运行的响应投影为扩展方法结果。复用 toAgentSidecarResponse，使回滚返回与
 * chat 完全同构的响应信封（schemaVersion + sessionId + events + result），宙主可
 * 直接复用既有解析器。过程事件（若有可投影者）已在调用期经 session/update 下发。
 */
export const toCheckpointRestoreExtResult = (
	response: IAgentRuntimeResponse,
): TAgentSidecarResponse => toAgentSidecarResponse(response)

/**
 * 原始模型透传单条消息 schema。role 覆盖四类（system/user/assistant/tool），content 为纯文本；
 * 与 `IAgentMessageInput` 结构兼容。toolCallId/name 仅在工具消息回放时出现，可选透传。
 */
const modelChatMessageSchema = z.object({
	role: z.enum(["system", "user", "assistant", "tool"]),
	content: z.string(),
	toolCallId: z.string().trim().min(1).optional(),
	name: z.string().trim().min(1).optional(),
})

/**
 * 原始模型透传扩展方法的入参 schema。messages 至少一条；goal/sessionId/workspaceRootPath/
 * modelConfig 均可选。语义：调用方完全掌控 prompt（含 system），sidecar 不附加任何人格。
 */
export const modelChatParamsSchema = z.object({
	messages: z.array(modelChatMessageSchema).min(1),
	goal: z.string().optional(),
	sessionId: z.string().trim().min(1).optional(),
	workspaceRootPath: z.string().trim().min(1).optional(),
	modelConfig: modelConfigParamsSchema.optional(),
})

/**
 * 校验并投影扩展入参为运行时输入。mode 固定为 ask（runtime.modelChat 不据 mode 自建系统
 * 提示，故仅作类型完备占位）；可选字段仅在提供时写入，与 buildPromptRuntimeInput 同风格。
 * 入参非法时抛出 ZodError，由 SDK 连接层映射为 JSON-RPC error。
 */
export const parseModelChatParams = (
	params: Record<string, unknown>,
): IAgentRuntimeInput => {
	const parsed = modelChatParamsSchema.parse(params)
	const messages: IAgentMessageInput[] = parsed.messages.map((message) => ({
		role: message.role,
		content: message.content,
		...(message.toolCallId !== undefined
			? { toolCallId: message.toolCallId }
			: {}),
		...(message.name !== undefined ? { name: message.name } : {}),
	}))
	return {
		mode: "ask",
		goal: parsed.goal ?? "",
		messages,
		...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
		...(parsed.workspaceRootPath !== undefined
			? { workspaceRootPath: parsed.workspaceRootPath }
			: {}),
		...(parsed.modelConfig !== undefined
			? { modelConfig: parsed.modelConfig }
			: {}),
	}
}

/**
 * 把原始模型透传的响应投影为扩展方法结果。复用 toAgentSidecarResponse，与 chat/checkpoint
 * 完全同构（schemaVersion + sessionId + events + result），宙主可直接复用既有解析器。
 */
export const toModelChatExtResult = (
	response: IAgentRuntimeResponse,
): TAgentSidecarResponse => toAgentSidecarResponse(response)

/**
 * agent 对话回合单条消息 schema。镜像旧 http 的 `agentMessageInputSchema`（role 四类 +
 * content 纯文本），与 `IAgentMessageInput` 结构兼容（其 toolCallId/name 可选字段在此省略，
 * 与旧 http /agent/chat 行为逐字一致）。
 */
const agentChatMessageSchema = z.object({
	role: z.enum(["user", "assistant", "system", "tool"]),
	content: z.string(),
})

/**
 * agent 对话回合上下文引用 schema。逐字镜像旧 http 的 `agentContextReferenceSchema`，
 * 与 `IAgentContextReferenceInput` 结构兼容（kind 用宽松 string，承接未来取值）。
 */
const agentChatContextReferenceSchema = z.object({
	id: z.string().min(1),
	kind: z.string().min(1),
	label: z.string().min(1),
	path: z.string().nullable(),
	range: z
		.object({
			startLine: z.number().int().positive(),
			endLine: z.number().int().positive(),
		})
		.nullable(),
	contentPreview: z.string(),
	redacted: z.boolean(),
})

/** 把空 / 空白 / null 归一为 undefined 的可选非空串预处理器（镜像旧 http optionalNonEmptyStringSchema）。 */
const optionalNonEmptyAgentStringSchema = z
	.preprocess((value) => {
		if (value === null || value === undefined) return undefined
		if (typeof value === "string" && value.trim().length === 0) return undefined
		return value
	}, z.string().trim().min(1).optional())
	.optional()

/** 可选 agent 模式预处理器（镜像旧 http optionalAgentModeSchema）。 */
const optionalAgentChatModeSchema = z
	.preprocess((value) => {
		if (value === null || value === undefined) return undefined
		if (typeof value === "string" && value.trim().length === 0) return undefined
		return value
	}, z.enum(["ask", "plan", "agent", "patch", "review"]).optional())
	.optional()

/** 可选工作区根路径预处理器：保留 null（镜像旧 http optionalWorkspaceRootPathSchema）。 */
const optionalWorkspaceRootPathParamsSchema = z
	.preprocess((value) => {
		if (value === null || value === undefined) return value
		if (typeof value === "string" && value.trim().length === 0) return undefined
		return value
	}, z.string().trim().min(1).nullable().optional())
	.optional()

/**
 * agent 对话回合扩展方法的入参 schema。自包含复刻旧 http 的 `baseAgentRequestSchema`
 * （= `agentSidecarChatRequestSchema`），以便 Batch 2 删除 server/ 后本扩展独立成立。
 */
export const agentChatParamsSchema = z.object({
	sessionId: optionalNonEmptyAgentStringSchema,
	mode: optionalAgentChatModeSchema,
	goal: optionalNonEmptyAgentStringSchema,
	messages: z.array(agentChatMessageSchema).default([]),
	workspaceRootPath: optionalWorkspaceRootPathParamsSchema,
	context: z.array(agentChatContextReferenceSchema).default([]),
	modelConfig: modelConfigParamsSchema.optional(),
	threadId: optionalNonEmptyAgentStringSchema,
	planId: optionalNonEmptyAgentStringSchema,
	planVersion: z.number().int().positive().optional(),
	planStepId: optionalNonEmptyAgentStringSchema,
})

/**
 * agent 对话审批恢复扩展方法的入参 schema。自包含复刻旧 http 的 `approvalResolutionSchema`
 * （= base + requestId + decision）。
 */
export const agentChatResolveParamsSchema = agentChatParamsSchema.extend({
	requestId: z.string().min(1),
	decision: z.enum(["approve", "reject", "cancel", "modify"]),
})

/**
 * 校验并投影 agent 对话入参为运行时输入。逐字复刻旧 http `toAgentInput(payload, 'agent')`
 * 的 goal 回退（payload.goal ?? 末条 user 消息 ?? '继续当前任务'）与可选字段「仅在 truthy
 * 时写入」语义；mode 缺省回退到 'agent'（本方法专司 agent 回合，前端恒显式携带 mode）。
 * 入参非法时抛出 ZodError，由 SDK 连接层映射为 JSON-RPC error。
 */
export const parseAgentChatParams = (
	params: Record<string, unknown>,
): IAgentRuntimeInput => {
	const parsed = agentChatParamsSchema.parse(params)
	const lastUserMessage = [...parsed.messages]
		.reverse()
		.find((message) => message.role === "user")
	const input: IAgentRuntimeInput = {
		mode: parsed.mode ?? "agent",
		goal: parsed.goal ?? lastUserMessage?.content ?? "继续当前任务",
		messages: parsed.messages,
		context: parsed.context,
	}
	if (parsed.sessionId) input.sessionId = parsed.sessionId
	if (parsed.workspaceRootPath) input.workspaceRootPath = parsed.workspaceRootPath
	if (parsed.threadId) input.threadId = parsed.threadId
	if (parsed.modelConfig) input.modelConfig = parsed.modelConfig
	if (parsed.planId) input.planId = parsed.planId
	if (parsed.planVersion) input.planVersion = parsed.planVersion
	if (parsed.planStepId) input.planStepId = parsed.planStepId
	return input
}

/**
 * 校验并投影 agent 对话审批恢复入参为审批裁决输入。逐字复刻旧 http
 * `runtime.resolveApproval(approvalResolutionSchema.parse(body), options)` 的透传语义：
 * requestId/decision 必填，messages/context 随默认值透传，其余可选字段仅在 truthy 时写入。
 * 入参非法时抛出 ZodError，由 SDK 连接层映射为 JSON-RPC error。
 */
export const parseAgentChatResolveParams = (
	params: Record<string, unknown>,
): IApprovalResolutionInput => {
	const parsed = agentChatResolveParamsSchema.parse(params)
	const input: IApprovalResolutionInput = {
		requestId: parsed.requestId,
		decision: parsed.decision,
		messages: parsed.messages,
		context: parsed.context,
	}
	if (parsed.sessionId) input.sessionId = parsed.sessionId
	if (parsed.goal) input.goal = parsed.goal
	if (parsed.workspaceRootPath) input.workspaceRootPath = parsed.workspaceRootPath
	if (parsed.modelConfig) input.modelConfig = parsed.modelConfig
	if (parsed.threadId) input.threadId = parsed.threadId
	if (parsed.planId) input.planId = parsed.planId
	if (parsed.planVersion) input.planVersion = parsed.planVersion
	if (parsed.planStepId) input.planStepId = parsed.planStepId
	return input
}

/**
 * 把 agent 对话回合（含审批恢复段）的响应投影为扩展方法结果。复用 toAgentSidecarResponse，
 * 与 chat/checkpoint/modelChat 完全同构（schemaVersion + sessionId + events + result）：
 * 富事件（结构化补丁 / 检查点 / 回滚 / 富审批字段 / plan_ready 等）零损失地随返回信封下发，
 * 宙主可直接复用既有 AgentSidecarResponsePayload 解析，前端 finalizeSidecarTurn 零改动消费。
 */
export const toAgentChatExtResult = (
	response: IAgentRuntimeResponse,
): TAgentSidecarResponse => toAgentSidecarResponse(response)

/**
 * ask_user 单条回答 schema（自包含，承接前端 IQuestionAnswer）。answer 用工具在 surface
 * 时分配的稳定 questionId / optionId 寻址；自由文本（恒在的「其他」行，或 text 型问题）
 * 走 text。与 IAskUserAnswerInput 结构兼容，也与 ask_user 工具 resumeSchema 的 answer 同形。
 */
const askUserAnswerParamsSchema = z.object({
	questionId: z.string().trim().min(1),
	optionIds: z.array(z.string().trim().min(1)).default([]),
	text: z.string().optional(),
})

/**
 * ask_user 反向提问恢复扩展方法的入参 schema。复用 agentChatParamsSchema 的会话/计划基底
 * （sessionId/messages/context/plan 三元组等），额外携带 requestId + outcome + 可选 answers。
 * 与 agentChatResolveParamsSchema 同构（仅以 outcome+answers 替换 decision）。
 */
export const agentAskUserResumeParamsSchema = agentChatParamsSchema.extend({
	requestId: z.string().min(1),
	outcome: z.enum(["selected", "cancelled"]),
	answers: z.array(askUserAnswerParamsSchema).optional(),
})

/**
 * 校验并投影 ask_user 恢复入参为 ask_user 裁决输入。与 parseAgentChatResolveParams 同风格：
 * requestId/outcome 必填，messages/context 随默认值透传，answers 逐项规范化（text 仅在提供
 * 时写入），其余可选字段仅在 truthy 时写入。入参非法时抛出 ZodError，由 SDK 连接层映射为
 * JSON-RPC error。
 */
export const parseAgentAskUserResumeParams = (
	params: Record<string, unknown>,
): IAskUserResolutionInput => {
	const parsed = agentAskUserResumeParamsSchema.parse(params)
	const input: IAskUserResolutionInput = {
		requestId: parsed.requestId,
		outcome: parsed.outcome,
		messages: parsed.messages,
		context: parsed.context,
	}
	if (parsed.answers !== undefined) {
		input.answers = parsed.answers.map((answer) => ({
			questionId: answer.questionId,
			optionIds: answer.optionIds,
			...(answer.text !== undefined ? { text: answer.text } : {}),
		}))
	}
	if (parsed.sessionId) input.sessionId = parsed.sessionId
	if (parsed.goal) input.goal = parsed.goal
	if (parsed.workspaceRootPath) input.workspaceRootPath = parsed.workspaceRootPath
	if (parsed.modelConfig) input.modelConfig = parsed.modelConfig
	if (parsed.threadId) input.threadId = parsed.threadId
	if (parsed.planId) input.planId = parsed.planId
	if (parsed.planVersion) input.planVersion = parsed.planVersion
	if (parsed.planStepId) input.planStepId = parsed.planStepId
	return input
}

/**
 * 把 ask_user 恢复回合的响应投影为扩展方法结果。复用 toAgentSidecarResponse，与
 * agent/chat、agent/chat/resolve 完全同构（schemaVersion + sessionId + events + result）：
 * 续跑产生的富事件零损失随返回信封下发，宙主复用既有解析器，前端零改动消费。
 */
export const toAgentAskUserResumeExtResult = (
	response: IAgentRuntimeResponse,
): TAgentSidecarResponse => toAgentSidecarResponse(response)

/** 预热结果投影：IWarmupResult 是 interface，经对象展开为匿名字面类型以满足 Record<string, unknown>。 */
export const toWarmupExtResult = (
	result: IWarmupResult,
): Record<string, unknown> => ({ ...result })

/** health 投影的入参（由 agent 从 runtime + getMcpRuntimeStatus() 采集）。 */
export interface IHealthExtResultInput {
	engine: string
	version: string | null
	mcp: IMcpRuntimeStatus
}

/**
 * 装配 health 投影结果，逐字节镜像旧 http `/health` 负载形状（ok/status/engine/version/
 * protocolVersion/implementationVersion/mcp），使宙主侧 AgentSidecarHealthPayload 解析不变。
 * 返回匿名对象字面量，天然可赋值为 Record<string, unknown>。
 */
export const buildHealthExtResult = (
	input: IHealthExtResultInput,
): Record<string, unknown> => ({
	ok: true,
	status: "ready",
	engine: input.engine,
	version: input.version,
	protocolVersion: SIDECAR_PROTOCOL_VERSION,
	implementationVersion: SIDECAR_IMPLEMENTATION_VERSION,
	mcp: { ...input.mcp },
})

/**
 * 执行模式 schema（interactive 人值守逐步 / autonomous 自主闭环）；缺省归一为 interactive，
 * 与旧 http server/request-schemas 的 executionModeRequestSchema 一致。
 */
const executionModeParamsSchema = z
	.enum(["interactive", "autonomous"])
	.default("interactive")

/**
 * 原生编排扩展方法（start）的入参 schema。镜像旧 http 的 agentSidecarOrchestrateRequestSchema，
 * 额外携带可选 sessionId：ACP 下过程事件经该会话的 session/update 流式下发（缺省则不下发，
 * 仅返回终态信封）。此处自包含重述，以便删除 server/ 后本扩展独立成立。
 */
export const orchestrateParamsSchema = z.object({
	goal: z.string().trim().min(1),
	threadId: z.string().trim().min(1).optional(),
	executionMode: executionModeParamsSchema,
	sessionId: z.string().trim().min(1).optional(),
	modelConfig: modelConfigParamsSchema.optional(),
})

/**
 * 编排恢复扩展方法（resume）的入参 schema。镜像旧 http 的
 * agentSidecarOrchestrateResumeRequestSchema，额外携带可选 sessionId（同 start，用于续跑阶段
 * 的 session/update 流式下发）。decision 覆盖三类挂起点，与旧 http 同语义。
 */
export const orchestrateResumeParamsSchema = z.object({
	runId: z.string().trim().min(1),
	decision: z.enum(["approve", "reject", "continue", "cancel"]),
	reason: z.string().trim().min(1).optional(),
	sessionId: z.string().trim().min(1).optional(),
	modelConfig: modelConfigParamsSchema.optional(),
})

/** parseOrchestrateParams 的返回型：编排 start 入参 + 可选流式会话 id。 */
export interface IOrchestrateParams {
	goal: string
	executionMode: "interactive" | "autonomous"
	threadId?: string
	sessionId?: string
	modelConfig?: IAgentRuntimeModelConfigInput
}

/** parseOrchestrateResumeParams 的返回型：编排 resume 入参 + 可选流式会话 id。 */
export interface IOrchestrateResumeParams {
	runId: string
	decision: "approve" | "reject" | "continue" | "cancel"
	reason?: string
	sessionId?: string
	modelConfig?: IAgentRuntimeModelConfigInput
}

/**
 * 校验并投影编排 start 入参。可选字段仅在提供时写入，与 checkpoint/modelChat 同风格。
 * 入参非法时抛出 ZodError，由 SDK 连接层映射为 JSON-RPC error。
 */
export const parseOrchestrateParams = (
	params: Record<string, unknown>,
): IOrchestrateParams => {
	const parsed = orchestrateParamsSchema.parse(params)
	const input: IOrchestrateParams = {
		goal: parsed.goal,
		executionMode: parsed.executionMode,
	}
	if (parsed.threadId !== undefined) input.threadId = parsed.threadId
	if (parsed.sessionId !== undefined) input.sessionId = parsed.sessionId
	if (parsed.modelConfig !== undefined) input.modelConfig = parsed.modelConfig
	return input
}

/**
 * 校验并投影编排 resume 入参。可选字段仅在提供时写入。
 * 入参非法时抛出 ZodError，由 SDK 连接层映射为 JSON-RPC error。
 */
export const parseOrchestrateResumeParams = (
	params: Record<string, unknown>,
): IOrchestrateResumeParams => {
	const parsed = orchestrateResumeParamsSchema.parse(params)
	const input: IOrchestrateResumeParams = {
		runId: parsed.runId,
		decision: parsed.decision,
	}
	if (parsed.reason !== undefined) input.reason = parsed.reason
	if (parsed.sessionId !== undefined) input.sessionId = parsed.sessionId
	if (parsed.modelConfig !== undefined) input.modelConfig = parsed.modelConfig
	return input
}

/** 编排切片结果投影的入参：与 server.ts 流式终帧 { runId, status, result } 同形。 */
export interface IOrchestrateExtResultInput {
	runId: string
	status: string
	result: unknown
}

/**
 * 装配编排扩展方法结果。与旧 http /stream 路由的终帧 { runId, status, result } 同形，
 * 宙主可直接解析 runId/status 并透传 result（含挂起 suspend payload 供审批 UI）。
 */
export const toOrchestrateExtResult = (
	input: IOrchestrateExtResultInput,
): Record<string, unknown> => ({
	runId: input.runId,
	status: input.status,
	result: input.result,
})
