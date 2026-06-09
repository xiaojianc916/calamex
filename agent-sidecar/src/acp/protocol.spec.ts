import assert from "node:assert/strict"
import { test } from "node:test"

import {
	ACP_PROTOCOL_VERSION,
	contentBlockSchema,
	parseSessionUpdate,
	planEntrySchema,
	requestPermissionOutcomeSchema,
	requestPermissionRequest,
	requestPermissionRequestSchema,
	requestPermissionResponseSchema,
	sessionUpdateSchema,
	textBlock,
	toolCallUpdateSchema,
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

test("toolCallUpdateSchema 解析完整工具调用更新（title 可选）", () => {
	const update = {
		toolCallId: "call-1",
		title: "写入文件",
		kind: "edit" as const,
		status: "in_progress" as const,
		content: [{ type: "diff" as const, path: "a.ts", newText: "new" }],
	}
	assert.equal(toolCallUpdateSchema.safeParse(update).success, true)
	// title 省略仍合法（部分更新）。
	assert.equal(
		toolCallUpdateSchema.safeParse({ toolCallId: "call-2" }).success,
		true,
	)
})

test("requestPermissionRequest 构造合法请求（toolCall 为完整 ToolCallUpdate）", () => {
	const request = requestPermissionRequest(
		"session-1",
		{ toolCallId: "call-1", title: "删除文件", kind: "delete" },
		[
			{ optionId: "allow", name: "允许一次", kind: "allow_once" },
			{ optionId: "reject", name: "拒绝", kind: "reject_once" },
		],
	)
	const result = requestPermissionRequestSchema.safeParse(request)
	assert.equal(result.success, true)
	assert.equal(request.toolCall.toolCallId, "call-1")
	assert.equal(request.options.length, 2)
})

test("requestPermissionResponse 解析 selected/cancelled 并保留 _meta", () => {
	const selected = requestPermissionResponseSchema.safeParse({
		outcome: { outcome: "selected", optionId: "allow" },
		_meta: { source: "client" },
	})
	assert.equal(selected.success, true)
	if (selected.success) {
		assert.equal(selected.data.outcome.outcome, "selected")
		assert.equal(
			(selected.data as Record<string, unknown>)._meta !== undefined,
			true,
		)
	}
	assert.equal(
		requestPermissionResponseSchema.safeParse({
			outcome: { outcome: "cancelled" },
		}).success,
		true,
	)
})

test("requestPermissionRequest 缺少必填 toolCall 时 schema 拒绝", () => {
	assert.equal(
		requestPermissionRequestSchema.safeParse({
			sessionId: "s-1",
			options: [],
		}).success,
		false,
	)
})
