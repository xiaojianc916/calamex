/**
 * 一次 prompt 回合的完整 ACP 出口组装。
 *
 * sidecar 作为 ACP Agent，一次 session/prompt 回合的线上输出由两部分构成：
 *   1. 过程中的若干 session/update 通知（文本/推理增量、工具生命周期、计划快照）；
 *   2. 回合收尾：一条可选的 usage_update 通知 + 一条 session/prompt 响应（stopReason）。
 *
 * 本模块是把内部富事件流收敛成上述线上形状的唯一「整回合」组装点，纯函数、无 IO，
 * 完全复用既有 acp 原语（session-stream / usage / prompt-turn），不重复任何投影逻辑：
 * - 流式传输层逐事件调用 toSessionNotifications（见 ./session-stream）即时下发过程通知，
 *   回合结束再调用 buildTurnTrailer 取得「收尾通知 + 响应」。
 * - 非流式（批量）调用方用 assembleTurnEgress 一次性拿到全部通知 + 响应。
 *
 * usage_update 的 size 取自模型上下文窗口（IAgentModelCapabilities.contextWindowTokens）；
 * 窗口缺失或无 token 数据时，按 ACP 前向兼容约定静默省略该通知（见 ./usage）。
 */
import type { TAgentRuntimeEvent } from "../streaming/stream-types.js"
import type { TSessionNotification } from "./protocol.js"
import {
	promptResponse,
	type TPromptResponse,
	type TStopReason,
} from "./prompt-turn.js"
import { toSessionNotificationStream } from "./session-stream.js"
import { toUsageUpdate, type IUsageSnapshotInput } from "./usage.js"

/** 回合收尾所需的计量与终止信息。 */
export interface ITurnTrailerInput {
	sessionId: string
	stopReason: TStopReason
	usage?: IUsageSnapshotInput | null
	contextWindowTokens?: number | null
}

/** 回合收尾的线上输出：收尾通知（usage_update，可能为空）+ prompt 响应。 */
export interface ITurnTrailer {
	notifications: TSessionNotification[]
	response: TPromptResponse
}

/**
 * 构造回合收尾输出。usage_update 仅在「有 token 数据且上下文窗口合法」时产生，
 * 否则 notifications 为空——调用方无需自行判空。
 */
export const buildTurnTrailer = (input: ITurnTrailerInput): ITurnTrailer => {
	const notifications: TSessionNotification[] = []
	const usageUpdate =
		input.usage != null && typeof input.contextWindowTokens === "number"
			? toUsageUpdate(input.usage, input.contextWindowTokens)
			: null
	if (usageUpdate !== null) {
		notifications.push({ sessionId: input.sessionId, update: usageUpdate })
	}
	return { notifications, response: promptResponse(input.stopReason) }
}

/** 一次回合的完整 ACP 出口：过程通知 + 收尾通知 + 响应。 */
export interface ITurnEgress {
	notifications: TSessionNotification[]
	response: TPromptResponse
}

/**
 * 批量组装一次回合的全部线上输出（保序）：先把事件流投影为过程通知，
 * 再追加收尾通知，最后给出响应。适用于非流式调用方；流式调用方应改用
 * 逐事件的 toSessionNotifications + 末尾一次 buildTurnTrailer。
 */
export const assembleTurnEgress = (
	events: ReadonlyArray<TAgentRuntimeEvent>,
	input: ITurnTrailerInput,
): ITurnEgress => {
	const trailer = buildTurnTrailer(input)
	return {
		notifications: [
			...toSessionNotificationStream(input.sessionId, events),
			...trailer.notifications,
		],
		response: trailer.response,
	}
}
