import assert from "node:assert/strict"
import { test } from "node:test"

import {
	AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
	type TAgentRuntimeEvent,
	type TAgentRuntimeEventType,
} from "../streaming/stream-types.js"
import { assembleTurnEgress, buildTurnTrailer } from "./turn-egress.js"

const SESSION_ID = "session-1"

/** 构造一条满足基字段的运行时富事件；type-specific 字段经 extra 注入。 */
const makeEvent = (
	type: TAgentRuntimeEventType,
	seq: number,
	extra: Record<string, unknown> = {},
): TAgentRuntimeEvent =>
	({
		id: `evt-${seq}`,
		type,
		runId: "run-1",
		sessionId: SESSION_ID,
		agentId: "agent-1",
		timestamp: "2026-01-01T00:00:00.000Z",
		seq,
		schemaVersion: AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
		redacted: true,
		visibility: "user",
		...extra,
	}) as TAgentRuntimeEvent

test("buildTurnTrailer：有 token 用量且窗口合法时产出 usage_update 收尾通知", () => {
	const trailer = buildTurnTrailer({
		sessionId: SESSION_ID,
		stopReason: "end_turn",
		usage: { totalTokens: 1200 },
		contextWindowTokens: 128000,
	})
	assert.equal(trailer.notifications.length, 1)
	const [note] = trailer.notifications
	assert.equal(note.sessionId, SESSION_ID)
	assert.equal(note.update.sessionUpdate, "usage_update")
	if (note.update.sessionUpdate === "usage_update") {
		assert.equal(note.update.used, 1200)
		assert.equal(note.update.size, 128000)
	}
	assert.equal(trailer.response.stopReason, "end_turn")
})

test("buildTurnTrailer：无 token 用量时仅给出响应、无收尾通知", () => {
	const trailer = buildTurnTrailer({
		sessionId: SESSION_ID,
		stopReason: "cancelled",
	})
	assert.deepEqual(trailer.notifications, [])
	assert.equal(trailer.response.stopReason, "cancelled")
})

test("buildTurnTrailer：有用量但缺上下文窗口时省略 usage_update", () => {
	const trailer = buildTurnTrailer({
		sessionId: SESSION_ID,
		stopReason: "end_turn",
		usage: { totalTokens: 10 },
	})
	assert.deepEqual(trailer.notifications, [])
})

test("buildTurnTrailer：上下文窗口非正数时省略 usage_update", () => {
	const trailer = buildTurnTrailer({
		sessionId: SESSION_ID,
		stopReason: "end_turn",
		usage: { totalTokens: 10 },
		contextWindowTokens: 0,
	})
	assert.deepEqual(trailer.notifications, [])
})

test("assembleTurnEgress：过程通知保序在前，usage_update 收尾在后", () => {
	const events = [
		makeEvent("agent.run.started", 0),
		makeEvent("agent.text.delta", 1, { text: "你好" }),
		makeEvent("agent.tool.started", 2, {
			toolName: "read_file",
			toolUseId: "call-1",
		}),
		makeEvent("agent.debug", 3, { name: "noop" }),
	]
	const egress = assembleTurnEgress(events, {
		sessionId: SESSION_ID,
		stopReason: "end_turn",
		usage: { totalTokens: 50 },
		contextWindowTokens: 64000,
	})
	assert.deepEqual(
		egress.notifications.map((note) => note.update.sessionUpdate),
		["agent_message_chunk", "tool_call", "usage_update"],
	)
	for (const note of egress.notifications) {
		assert.equal(note.sessionId, SESSION_ID)
	}
	assert.equal(egress.response.stopReason, "end_turn")
})

test("assembleTurnEgress：空事件且无用量时只剩响应", () => {
	const egress = assembleTurnEgress([], {
		sessionId: SESSION_ID,
		stopReason: "end_turn",
	})
	assert.deepEqual(egress.notifications, [])
	assert.equal(egress.response.stopReason, "end_turn")
})
