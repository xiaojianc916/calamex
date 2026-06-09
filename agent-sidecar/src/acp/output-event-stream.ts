/**
 * 运行时输出事件 → ACP session/update 出口投影。
 *
 * dispatcher 的出站对偶（与 to-runtime-input 入站投影对称）：
 * runtime 以 TAgentRuntimeOutputEvent（UI 层输出事件：agent_event / plan_ready /
 * plan_record / approval_required）送出；本模块决定哪些变体成为回合过程中的
 * session/update 通知，哪些由带外通道处理：
 * - agent_event       → 委托 toSessionNotifications（富事件 → agent_message_chunk /
 *                       agent_thought_chunk / tool_call(_update) / plan / ...）。
 * - plan_ready/_record → []：计划内容已由富事件 agent.plan.updated → plan 更新随回合
 *                       流式送达，这两个 UI 汇总事件不另发线帧（避免重复）。
 * - approval_required  → []：工具审批走 ACP 反向 session/request_permission（带外往返），
 *                       不作为 session/update 下发。
 *
 * 说明：agent_event 这层 UI 包装是过渡期产物（T-A4 前端切换后，runtime 将直接发
 * TAgentRuntimeEvent）。本模块独立成文，到时可外科式删除 wrapper 拆包而不动 session-stream。
 */
import type { TAgentRuntimeOutputEvent } from "../engines/contracts/runtime-contracts.js"
import type { TSessionNotification } from "./protocol.js"
import { toSessionNotifications } from "./session-stream.js"

const assertNever = (value: never): never => {
	throw new Error(
		`未处理的运行时输出事件类型：${JSON.stringify(value)}`,
	)
}

/**
 * 将单个运行时输出事件投影为零个或多个 session/update 通知。
 * 纯函数；穷尽 switch 保证新增输出事件类型时编译即报错。
 */
export const toSessionNotificationsFromOutputEvent = (
	sessionId: string,
	outputEvent: TAgentRuntimeOutputEvent,
): TSessionNotification[] => {
	switch (outputEvent.type) {
		case "agent_event":
			return toSessionNotifications(sessionId, outputEvent.event)
		case "plan_ready":
		case "plan_record":
			return []
		case "approval_required":
			return []
		default:
			return assertNever(outputEvent)
	}
}

/** 批量版：按顺序 flatMap 多个输出事件。 */
export const toSessionNotificationsFromOutputEvents = (
	sessionId: string,
	outputEvents: readonly TAgentRuntimeOutputEvent[],
): TSessionNotification[] =>
	outputEvents.flatMap((event) =>
		toSessionNotificationsFromOutputEvent(sessionId, event),
	)
