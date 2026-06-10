/**
 * sidecar 作为 ACP Agent 的「扩展方法」(ext methods)定义与能力公示。
 *
 * ACP 是围绕「会话回合」(session/prompt)的固定协议：那些真正「带外」的能力——
 * 不属于任何 prompt 回合——没有标准 wire 形态。遵循 SDK 指引（扩展方法用域名前缀
 * 避免冲突）与 Zed 的 _meta 纪律，这类能力经 AgentSideConnection 的 ext 通道暴露，
 * 并在 initialize 的 `agentCapabilities._meta` 下以命名空间公示供我方宿主发现；
 * 一个不识别这些扩展的标准客户端（如 Zed）会安全忽略，核心会话流不受影响。
 *
 * 扩展清单（均挂在同一 calamex.dev 命名空间下，镜像 checkpoint/restore 先例）：
 * - checkpoint/restore：检查点回滚（runtime.restoreCheckpoint）。
 * - web/search、web/fetch：应用级网络检索/抓取（由宿主的 ai::tools 调用，非 agent 工具）。
 * - warmup：LLM 连接预热（宿主启动时显式调用，缩短首 prompt 首字延迟）。
 * - health：健康/活性探活 + MCP 运行状态快照。
 *
 * 模型代理輎谈（model-proxy）与叙述生成（narrator）不在此列：二者在旧 http 期即与
 * `/agent/chat` 共用同一 `runtime.chat`(ask) 处理器，在 ACP 下天然归为 ask 模式的 prompt 回合，
 * 无需单独扩展。检查点长期可像 Zed 那样归到宿主侧 git_store，届时该扩展整体退役。
 * 本模块为纯函数 + 常量（及类型投影），无 I/O、无状态；I/O 由 agent.ts 的 ext 处理器承担。
 */
import { z } from "zod"

import type { IWarmupResult } from "../models/llm-warmup.js"
import type { IMcpRuntimeStatus } from "../tools/mcp.js"
import {
	toAgentSidecarResponse,
	type IAgentRuntimeResponse,
} from "../engines/contracts/runtime-contracts.js"
import type { ICheckpointRestoreInput } from "../engines/contracts/runtime-input.js"
import type { TAgentSidecarResponse } from "../schemas/events.js"

/** 我方扩展命名空间（反向域名，避免与其他 ACP 实现的扩展冲突）。 */
export const CALAMEX_EXT_NAMESPACE = "calamex.dev"

/** 检查点回滚扩展方法名（域名前缀 + 资源/动作，镜像 ACP 的 `session/prompt` 命名风格）。 */
export const CHECKPOINT_RESTORE_METHOD = `${CALAMEX_EXT_NAMESPACE}/checkpoint/restore`

/** 网络检索/抓取扩展方法名。 */
export const WEB_SEARCH_METHOD = `${CALAMEX_EXT_NAMESPACE}/web/search`
export const WEB_FETCH_METHOD = `${CALAMEX_EXT_NAMESPACE}/web/fetch`

/** LLM 连接预热扩展方法名。 */
export const WARMUP_METHOD = `${CALAMEX_EXT_NAMESPACE}/warmup`

/** 健康/活性探活扩展方法名。 */
export const HEALTH_METHOD = `${CALAMEX_EXT_NAMESPACE}/health`

/**
 * sidecar 构建身份版本（从旧 http server.ts 迁入，使其在 server.ts 删除后仍成立）。
 * 这是 sidecar *实现* 的版本标记，与 ACP 协议本身的 PROTOCOL_VERSION 解耦；仅用于 health
 * 投影中填充宿主侧 AgentSidecarHealthPayload 的 protocol/implementation 字段，保持契约稳定。
 */
export const SIDECAR_PROTOCOL_VERSION = "7"
export const SIDECAR_IMPLEMENTATION_VERSION =
	"deepseek-reasoning-transport-v6-plan-history"

/**
 * initialize 时挂在 `agentCapabilities._meta` 下的扩展公示。
 * 宿主据 `_meta["calamex.dev"].extMethods` 发现可用扩展；标准客户端忽略本键。
 */
export const CALAMEX_AGENT_CAPABILITY_META: Record<string, unknown> = {
	[CALAMEX_EXT_NAMESPACE]: {
		extMethods: {
			checkpointRestore: CHECKPOINT_RESTORE_METHOD,
			webSearch: WEB_SEARCH_METHOD,
			webFetch: WEB_FETCH_METHOD,
			warmup: WARMUP_METHOD,
			health: HEALTH_METHOD,
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
 * chat 完全同构的响应信封（schemaVersion + sessionId + events + result），宿主可
 * 直接复用既有解析器。过程事件（若有可投影者）已在调用期经 session/update 下发。
 */
export const toCheckpointRestoreExtResult = (
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
 * protocolVersion/implementationVersion/mcp），使宿主侧 AgentSidecarHealthPayload 解析不变。
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
