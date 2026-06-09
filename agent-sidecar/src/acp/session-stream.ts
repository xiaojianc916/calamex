/**
 * 运行时富事件 → ACP 会话通知（session/update）的出口成帧。
 *
 * 纯函数：复用 projectRuntimeEventToAcp 将每条 SessionUpdate 包进
 * { sessionId, update } 信封。这是 sidecar 作为 ACP Agent 向 client 推送
 * session/update 通知的唯一成帧点——上游负责产生富事件，本模块
 * 只负责投影 + 装信封，不含传输 / IO 逻辑。
 *
 * 遥测类富事件（链路外）投影为空，因此自然不会产生任何通知。
 */
import type { TAgentRuntimeEvent } from "../streaming/stream-types.js"
import { projectRuntimeEventToAcp } from "./from-runtime-event.js"
import type { TSessionNotification } from "./protocol.js"

/** 将单条富事件成帧为 0..n 条 ACP 会话通知。 */
export const toSessionNotifications = (
	sessionId: string,
	event: TAgentRuntimeEvent,
): TSessionNotification[] =>
	projectRuntimeEventToAcp(event).map((update) => ({ sessionId, update }))

/** 批量成帧：保序 flatMap。 */
export const toSessionNotificationStream = (
	sessionId: string,
	events: ReadonlyArray<TAgentRuntimeEvent>,
): TSessionNotification[] =>
	events.flatMap((event) => toSessionNotifications(sessionId, event))
