import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
	createAgentRuntimeEvent,
	type IAgentRuntimeEventContext,
} from "../streaming/stream-types.js"
import {
	inferToolKind,
	projectRuntimeEventToAcp,
	projectRuntimeEventsToAcp,
} from "./from-runtime-event.js"

const ctx: IAgentRuntimeEventContext = {
	runId: "run-1",
	sessionId: "sess-1",
	agentId: "agent-1",
	now: () => "2026-01-01T00:00:00.000Z",
}

test("agent.text.delta → agent_message_chunk", () => {
	const updates = projectRuntimeEventToAcp(
		createAgentRuntimeEvent(ctx, 1, {
			type: "agent.text.delta",
			visibility: "user",
			text: "你好",
		}),
	)
	assert.deepEqual(updates, [
		{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } },
	])
})

test("agent.reasoning.delta → agent_thought_chunk", () => {
	const updates = projectRuntimeEventToAcp(
		createAgentRuntimeEvent(ctx, 2, {
			type: "agent.reasoning.delta",
			visibility: "user",
			text: "thinking",
		}),
	)
	assert.deepEqual(updates, [
		{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
	])
})

test("agent.tool.started → tool_call（复用 toolUseId、推断 kind）", () => {
	const updates = projectRuntimeEventToAcp(
		createAgentRuntimeEvent(ctx, 3, {
			type: "agent.tool.started",
			visibility: "user",
			toolUseId: "call_abc",
			toolName: "read_file",
			inputPreview: '{"path":"a.ts"}',
		}),
	)
	assert.deepEqual(updates, [
		{
			sessionUpdate: "tool_call",
			toolCallId: "call_abc",
			title: "read_file",
			kind: "read",
			status: "in_progress",
			rawInput: '{"path":"a.ts"}',
		},
	])
})

test("agent.tool.started 缺 toolUseId 时回退到 toolName", () => {
	const updates = projectRuntimeEventToAcp(
		createAgentRuntimeEvent(ctx, 4, {
			type: "agent.tool.started",
			visibility: "user",
			toolName: "apply_patch",
		}),
	)
	assert.deepEqual(updates, [
		{
			sessionUpdate: "tool_call",
			toolCallId: "apply_patch",
			title: "apply_patch",
			kind: "edit",
			status: "in_progress",
		},
	])
})

test("agent.tool.progress → tool_call_update（含进度内容）", () => {
	const updates = projectRuntimeEventToAcp(
		createAgentRuntimeEvent(ctx, 5, {
			type: "agent.tool.progress",
			visibility: "user",
			toolUseId: "call_abc",
			dataPreview: "50%",
		}),
	)
	assert.deepEqual(updates, [
		{
			sessionUpdate: "tool_call_update",
			toolCallId: "call_abc",
			status: "in_progress",
			content: [{ type: "content", content: { type: "text", text: "50%" } }],
		},
	])
})

test("agent.tool.progress 无 id 时跳过", () => {
	const updates = projectRuntimeEventToAcp(
		createAgentRuntimeEvent(ctx, 6, {
			type: "agent.tool.progress",
			visibility: "debug",
		}),
	)
	assert.deepEqual(updates, [])
})

test("agent.tool.completed 成功 → completed + rawOutput", () => {
	const updates = projectRuntimeEventToAcp(
		createAgentRuntimeEvent(ctx, 7, {
			type: "agent.tool.completed",
			visibility: "user",
			toolUseId: "call_abc",
			toolName: "read_file",
			ok: true,
			resultPreview: "done",
		}),
	)
	assert.deepEqual(updates, [
		{
			sessionUpdate: "tool_call_update",
			toolCallId: "call_abc",
			status: "completed",
			rawOutput: "done",
		},
	])
})

test("agent.tool.completed 失败 → failed + 错误内容", () => {
	const updates = projectRuntimeEventToAcp(
		createAgentRuntimeEvent(ctx, 8, {
			type: "agent.tool.completed",
			visibility: "user",
			toolUseId: "call_x",
			toolName: "exec",
			ok: false,
			errorMessage: "boom",
		}),
	)
	assert.deepEqual(updates, [
		{
			sessionUpdate: "tool_call_update",
			toolCallId: "call_x",
			status: "failed",
			content: [{ type: "content", content: { type: "text", text: "boom" } }],
		},
	])
})

test("agent.plan.updated → plan（全量条目快照，1:1 对齐 ACP PlanEntry）", () => {
	const updates = projectRuntimeEventToAcp(
		createAgentRuntimeEvent(ctx, 18, {
			type: "agent.plan.updated",
			visibility: "user",
			entries: [
				{ content: "读取源码", priority: "high", status: "completed" },
				{ content: "设计投影", priority: "medium", status: "in_progress" },
				{ content: "补充测试", priority: "low", status: "pending" },
			],
		}),
	)
	assert.deepEqual(updates, [
		{
			sessionUpdate: "plan",
			entries: [
				{ content: "读取源码", priority: "high", status: "completed" },
				{ content: "设计投影", priority: "medium", status: "in_progress" },
				{ content: "补充测试", priority: "low", status: "pending" },
			],
		},
	])
})

test("纯遥测事件投影为空（链路外）", () => {
	const telemetry = [
		createAgentRuntimeEvent(ctx, 9, { type: "agent.run.started", visibility: "debug" }),
		createAgentRuntimeEvent(ctx, 10, { type: "agent.run.completed", visibility: "user" }),
		createAgentRuntimeEvent(ctx, 11, {
			type: "agent.model.completed",
			visibility: "debug",
			ok: true,
		}),
		createAgentRuntimeEvent(ctx, 12, { type: "acontext.token.checked", visibility: "debug" }),
		createAgentRuntimeEvent(ctx, 13, {
			type: "rollback.checkpoint.created",
			visibility: "user",
		}),
		createAgentRuntimeEvent(ctx, 14, { type: "agent.debug", visibility: "debug", name: "trace" }),
	]
	for (const event of telemetry) {
		assert.deepEqual(projectRuntimeEventToAcp(event), [])
	}
})

test("projectRuntimeEventsToAcp 保序聚合", () => {
	const updates = projectRuntimeEventsToAcp([
		createAgentRuntimeEvent(ctx, 15, { type: "agent.text.delta", visibility: "user", text: "a" }),
		createAgentRuntimeEvent(ctx, 16, { type: "agent.run.started", visibility: "debug" }),
		createAgentRuntimeEvent(ctx, 17, {
			type: "agent.tool.started",
			visibility: "user",
			toolUseId: "t1",
			toolName: "search_files",
		}),
	])
	assert.equal(updates.length, 2)
	assert.equal(updates[0]?.sessionUpdate, "agent_message_chunk")
	assert.equal(updates[1]?.sessionUpdate, "tool_call")
})

test("inferToolKind 映射", () => {
	assert.equal(inferToolKind("read_file"), "read")
	assert.equal(inferToolKind("write_file"), "edit")
	assert.equal(inferToolKind("delete_path"), "delete")
	assert.equal(inferToolKind("ripgrep"), "search")
	assert.equal(inferToolKind("run_command"), "execute")
	assert.equal(inferToolKind("fetch_url"), "fetch")
	assert.equal(inferToolKind("rename_symbol"), "move")
	assert.equal(inferToolKind("mystery"), "other")
})
