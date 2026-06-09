import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
	createAgentRuntimeEvent,
	type IAgentRuntimeEventContext,
} from "../streaming/stream-types.js"
import { sessionNotificationSchema } from "./protocol.js"
import {
	toSessionNotifications,
	toSessionNotificationStream,
} from "./session-stream.js"

const ctx: IAgentRuntimeEventContext = {
	runId: "run-1",
	sessionId: "sess-1",
	agentId: "agent-1",
	now: () => "2026-01-01T00:00:00.000Z",
}

test("单条文本增量 → 带 sessionId 的 agent_message_chunk 通知", () => {
	const notifications = toSessionNotifications(
		"s1",
		createAgentRuntimeEvent(ctx, 1, {
			type: "agent.text.delta",
			visibility: "user",
			text: "hi",
		}),
	)
	assert.deepEqual(notifications, [
		{
			sessionId: "s1",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "hi" },
			},
		},
	])
	for (const notification of notifications) {
		sessionNotificationSchema.parse(notification)
	}
})

test("遥测事件不产生通知", () => {
	const notifications = toSessionNotifications(
		"s1",
		createAgentRuntimeEvent(ctx, 2, { type: "agent.run.started", visibility: "debug" }),
	)
	assert.deepEqual(notifications, [])
})

test("批量成帧保序且跳过遥测", () => {
	const notifications = toSessionNotificationStream("s1", [
		createAgentRuntimeEvent(ctx, 3, { type: "agent.text.delta", visibility: "user", text: "a" }),
		createAgentRuntimeEvent(ctx, 4, { type: "agent.run.started", visibility: "debug" }),
		createAgentRuntimeEvent(ctx, 5, {
			type: "agent.tool.started",
			visibility: "user",
			toolUseId: "t1",
			toolName: "read_file",
		}),
	])
	assert.equal(notifications.length, 2)
	assert.equal(notifications[0]?.update.sessionUpdate, "agent_message_chunk")
	assert.equal(notifications[1]?.update.sessionUpdate, "tool_call")
	assert.equal(notifications[0]?.sessionId, "s1")
	for (const notification of notifications) {
		sessionNotificationSchema.parse(notification)
	}
})
