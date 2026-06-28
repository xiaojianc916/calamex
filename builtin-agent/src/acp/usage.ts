/**
 * done token 快照 → ACP usage_update SessionUpdate 的纯映射。
 *
 * ACP 的 usage_update 语义:
 *   used:本次会话已消耗的 token 总量。
 *   size:模型上下文窗口总量(驱动 client 端上下文占用进度)。
 *
 * 设计要点:本模块不依赖 engines 侧即将重构的 TDoneTokenSnapshot,
 * 而是用解耦的 IUsageSnapshotInput 作输入,使该映射在 U3 接线
 * 提交中保持稳定、可独立单测。contextWindowTokens 来自
 * IAgentModelCapabilities.contextWindowTokens。
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk"

export type TUsageUpdate = Extract<
	SessionUpdate,
	{ sessionUpdate: "usage_update" }
>

/** 解耦的 token 用量输入(由接线层从内部快照适配而来)。 */
export interface IUsageSnapshotInput {
	totalTokens?: number | null | undefined
	inputTokens?: number | null | undefined
	outputTokens?: number | null | undefined
}

const isPositiveFinite = (value: number | null | undefined): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0

/** 优先 totalTokens;缺失时回退为 prompt+completion;都没有则 null。 */
const resolveUsedTokens = (usage: IUsageSnapshotInput): number | null => {
	if (isPositiveFinite(usage.totalTokens)) {
		return usage.totalTokens
	}
	const prompt = isPositiveFinite(usage.inputTokens) ? usage.inputTokens : null
	const completion = isPositiveFinite(usage.outputTokens)
		? usage.outputTokens
		: null
	if (prompt === null && completion === null) {
		return null
	}
	return (prompt ?? 0) + (completion ?? 0)
}

/**
 * 构造 usage_update。无可用 token 数据或窗口不合法时返回 null
 * (调用方据此决定是否发出该通知)。
 */
export const toUsageUpdate = (
	usage: IUsageSnapshotInput,
	contextWindowTokens: number,
): TUsageUpdate | null => {
	const used = resolveUsedTokens(usage)
	if (used === null) {
		return null
	}
	if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
		return null
	}
	return {
		sessionUpdate: "usage_update",
		used,
		size: contextWindowTokens,
	}
}
