import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import type { TAgentRuntimeEvent } from "../streaming/stream-types.js"
import type { TAgentRuntimeOutputEvent } from "../engines/contracts/runtime-contracts.js"
import { toSessionNotifications } from "./session-stream.js"
import {
	toSessionNotificationsFromOutputEvent,
	toSessionNotificationsFromOutputEvents,
} from "./output-event-stream.js"

// 最小合法的文本增量富事件（投影只读取 type/text，其余封装字段与本用例无关）。
const textDeltaEvent = (text: string): TAgentRuntimeEvent =>
	({
		type: "agent.text.delta",
		visibility: "user",
		level: "info",
		text,
	}) as unknown as TAgentRuntimeEvent

const agentEvent = (event: TAgentRuntimeEvent): TAgentRuntimeOutputEvent =>
	({ type: "agent_event", event }) as TAgentRuntimeOutputEvent

describe("toSessionNotificationsFromOutputEvent", () => {
	it("agent_event 委托给 toSessionNotifications（等价）", () => {
		const event = textDeltaEvent("你好")
		assert.deepEqual(
			toSessionNotificationsFromOutputEvent("s1", agentEvent(event)),
			toSessionNotifications("s1", event),
		)
	})

	it("agent_event 产生至少一条带同 sessionId 的通知", () => {
		const notifications = toSessionNotificationsFromOutputEvent(
			"s1",
			agentEvent(textDeltaEvent("hi")),
		)
		assert.ok(notifications.length >= 1)
		for (const n of notifications) {
			assert.equal(n.sessionId, "s1")
		}
	})

	it("plan_ready 不下发通知", () => {
		assert.deepEqual(
			toSessionNotificationsFromOutputEvent("s1", {
				type: "plan_ready",
			} as unknown as TAgentRuntimeOutputEvent),
			[],
		)
	})

	it("plan_record 不下发通知", () => {
		assert.deepEqual(
			toSessionNotificationsFromOutputEvent("s1", {
				type: "plan_record",
			} as unknown as TAgentRuntimeOutputEvent),
			[],
		)
	})

	it("approval_required 不下发通知（走反向 request_permission）", () => {
		assert.deepEqual(
			toSessionNotificationsFromOutputEvent("s1", {
				type: "approval_required",
			} as unknown as TAgentRuntimeOutputEvent),
			[],
		)
	})
})

describe("toSessionNotificationsFromOutputEvents", () => {
	it("按顺序 flatMap，丢弃项不产生通知", () => {
		const events: TAgentRuntimeOutputEvent[] = [
			agentEvent(textDeltaEvent("a")),
			{ type: "plan_ready" } as unknown as TAgentRuntimeOutputEvent,
			agentEvent(textDeltaEvent("b")),
			{ type: "approval_required" } as unknown as TAgentRuntimeOutputEvent,
		]
		const expected = [
			...toSessionNotifications("s1", textDeltaEvent("a")),
			...toSessionNotifications("s1", textDeltaEvent("b")),
		]
		assert.deepEqual(
			toSessionNotificationsFromOutputEvents("s1", events),
			expected,
		)
	})

	it("空输入 → 空输出", () => {
		assert.deepEqual(toSessionNotificationsFromOutputEvents("s1", []), [])
	})

	it("全为丢弃项 → 空输出", () => {
		const events = [
			{ type: "plan_ready" },
			{ type: "plan_record" },
			{ type: "approval_required" },
		] as unknown as TAgentRuntimeOutputEvent[]
		assert.deepEqual(toSessionNotificationsFromOutputEvents("s1", events), [])
	})
})
