import assert from "node:assert/strict"
import { test } from "node:test"

import {
	ACP_PROTOCOL_VERSION,
	contentBlockSchema,
	parseSessionUpdate,
	planEntrySchema,
	requestPermissionOutcomeSchema,
	sessionUpdateSchema,
	textBlock,
	toolKindSchema,
} from "./protocol"

test("协议版本固定为 ACP v1", () => {
	assert.equal(ACP_PROTOCOL_VERSION, 1)
})

test("textBlock 构造合法文本内容块", () => {
	const block = textBlock("你好")
	assert.deepEqual(block, { type: "text", text: "你好" })
	assert.equal(contentBlockSchema.safeParse(block).success, true)
})

test("agent_message_chunk 解析并保留未知字段", () => {
	const parsed = parseSessionUpdate({
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text: "hi" },
		messageId: "m-1",
	})
	assert.ok(parsed)
	assert.equal(parsed.sessionUpdate, "agent_message_chunk")
	// passthrough 应保留 ACP 约定外/新增字段。
	assert.equal((parsed as Record<string, unknown>).messageId, "m-1")
})

test("tool_call 往返保形（含 diff 内容）", () => {
	const update = {
		sessionUpdate: "tool_call" as const,
		toolCallId: "call-1",
		title: "写入文件",
		kind: "edit" as const,
		status: "in_progress" as const,
		content: [
			{ type: "diff" as const, path: "a.ts", oldText: "old", newText: "new" },
		],
	}
	const result = sessionUpdateSchema.safeParse(update)
	assert.equal(result.success, true)
	if (result.success) assert.deepEqual(result.data, update)
})

test("tool_call 缺少必填 title 时拒绝", () => {
	const result = sessionUpdateSchema.safeParse({
		sessionUpdate: "tool_call",
		toolCallId: "call-1",
	})
	assert.equal(result.success, false)
})

test("plan 条目解析", () => {
	const parsed = parseSessionUpdate({
		sessionUpdate: "plan",
		entries: [{ content: "第一步", priority: "high", status: "pending" }],
	})
	assert.ok(parsed)
	assert.equal(parsed.sessionUpdate, "plan")
})

test("usage_update 解析", () => {
	const parsed = parseSessionUpdate({
		sessionUpdate: "usage_update",
		used: 1200,
		size: 128000,
	})
	assert.ok(parsed)
	assert.equal(parsed.sessionUpdate, "usage_update")
})

test("前向兼容：未知工具 kind 回退为 other", () => {
	assert.equal(toolKindSchema.parse("teleport"), "other")
	assert.equal(toolKindSchema.parse("edit"), "edit")
})

test("前向兼容：未知 plan 优先级/状态回退", () => {
	const entry = planEntrySchema.parse({
		content: "x",
		priority: "urgent",
		status: "blocked",
	})
	assert.equal(entry.priority, "medium")
	assert.equal(entry.status, "pending")
})

test("未知 sessionUpdate 变体解析为 null（按约定跳过）", () => {
	assert.equal(parseSessionUpdate({ sessionUpdate: "future_variant" }), null)
	assert.equal(parseSessionUpdate({ nope: true }), null)
})

test("request_permission 结果联合解析", () => {
	assert.equal(
		requestPermissionOutcomeSchema.safeParse({
			outcome: "selected",
			optionId: "opt-1",
		}).success,
		true,
	)
	assert.equal(
		requestPermissionOutcomeSchema.safeParse({ outcome: "cancelled" }).success,
		true,
	)
})
