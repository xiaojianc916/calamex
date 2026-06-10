/**
 * sidecar 作为 ACP Agent 的「扩展方法」(ext methods)定义与能力公示。
 *
 * ACP 是围绕「会话回合」(session/prompt)的固定协议：极少数真正「带外」的能力——
 * 不属于任何 prompt 回合——没有标准 wire 形态。遵循 SDK 指引（扩展方法用域名前缀
 * 避免冲突）与 Zed 的 _meta 纪律，这类能力经 AgentSideConnection 的 ext 通道暴露，
 * 并在 initialize 的 `agentCapabilities._meta` 下以命名空间公示供我方宿主发现；
 * 一个不识别这些扩展的标准客户端（如 Zed）会安全忽略，核心会话流不受影响。
 *
 * 目前仅一项：检查点回滚（checkpoint restore）。检查点由 sidecar runtime 拥有
 * （rollback.* 事件 + runtime.restoreCheckpoint），故复用之；长期可像 Zed 把检查点
 * 归到宿主侧 git_store，届时本扩展整体退役。本模块为纯函数 + 常量，无 I/O、无状态。
 */
import { z } from "zod"

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

/**
 * initialize 时挂在 `agentCapabilities._meta` 下的扩展公示。
 * 宿主据 `_meta["calamex.dev"].extMethods` 发现可用扩展；标准客户端忽略本键。
 */
export const CALAMEX_AGENT_CAPABILITY_META: Record<string, unknown> = {
	[CALAMEX_EXT_NAMESPACE]: {
		extMethods: { checkpointRestore: CHECKPOINT_RESTORE_METHOD },
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
 * 直接复用既有解析器。过程事件（若有可投影者）已在调用期间经 session/update 下发。
 */
export const toCheckpointRestoreExtResult = (
	response: IAgentRuntimeResponse,
): TAgentSidecarResponse => toAgentSidecarResponse(response)
