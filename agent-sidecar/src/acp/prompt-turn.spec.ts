import assert from "node:assert/strict"
import { test } from "node:test"

import { textBlock } from "./protocol.js"
import {
	cancelNotificationSchema,
	promptRequestSchema,
	promptResponse,
	promptResponseSchema,
	stopReasonSchema,
} from "./prompt-turn.js"

test("StopReason 1:1 对齐 src/v1/agent.rs（稳定面 5 个变体）", () => {
	for (const reason of [
		"end_turn",
		"max_tokens",
		"max_turn_requests",
		"refusal",
		"cancelled",
	]) {
		assert.equal(stopReasonSchema.parse(reason), reason)
	}
})

test("StopReason 未知值按 ACP 前向兼容回退到 end_turn", () => {
	assert.equal(stopReasonSchema.parse("some_future_reason"), "end_turn")
})

test("PromptRequest：sessionId + prompt(ContentBlock[])，passthrough 透传 _meta", () => {
	const parsed = promptRequestSchema.parse({
		sessionId: "s1",
		prompt: [textBlock("你好")],
		_meta: { trace: "abc" },
	})
	assert.equal(parsed.sessionId, "s1")
	assert.deepEqual(parsed.prompt, [{ type: "text", text: "你好" }])
	assert.deepEqual((parsed as Record<string, unknown>)._meta, { trace: "abc" })
})

test("PromptRequest 拒绝缺失 sessionId 或 prompt 非数组", () => {
	assert.equal(promptRequestSchema.safeParse({ prompt: [] }).success, false)
	assert.equal(
		promptRequestSchema.safeParse({ sessionId: "s1", prompt: "nope" }).success,
		false,
	)
})

test("promptResponse 构造器镜像 PromptResponse::new，且通过 schema 校验", () => {
	const res = promptResponse("end_turn")
	assert.deepEqual(res, { stopReason: "end_turn" })
	assert.equal(promptResponseSchema.safeParse(res).success, true)
})

test("CancelNotification：sessionId，passthrough 透传 _meta", () => {
	const parsed = cancelNotificationSchema.parse({
		sessionId: "s2",
		_meta: { reason: "user" },
	})
	assert.equal(parsed.sessionId, "s2")
	assert.deepEqual((parsed as Record<string, unknown>)._meta, { reason: "user" })
})
