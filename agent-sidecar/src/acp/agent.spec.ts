import assert from "node:assert/strict"
import { test } from "node:test"

import type {
	RequestPermissionRequest,
	SessionNotification,
} from "@agentclientprotocol/sdk"

import { encodeApprovalRequestId } from "../engines/approval-client/utils.js"
import type {
	IAgentRuntimeResponse,
	IAgentRuntimeRunOptions,
} from "../engines/contracts/runtime-contracts.js"
import type { IAgentRuntimeInput } from "../engines/contracts/runtime-input.js"
import type { IAgentSidecarRuntime } from "../engines/runtime.js"
import { createAgentRuntimeEvent } from "../streaming/stream-types.js"
import { CalamexAcpAgent, type IAcpAgentConnection } from "./agent.js"

// 记录型假连接:收集所有下发的 session/update 通知;requestPermission 默认抛错
// (未配置即视为用例不应触发审批),可由参数注入确定化的裁决处理器。
const recordingConnection = (
	requestPermission?: IAcpAgentConnection["requestPermission"],
): {
	connection: IAcpAgentConnection
	notifications: SessionNotification[]
} => {
	const notifications: SessionNotification[] = []
	const connection: IAcpAgentConnection = {
		sessionUpdate: async (params) => {
			notifications.push(params)
		},
		requestPermission:
			requestPermission ??
			(async () => {
				throw new Error("本用例未配置 requestPermission")
			}),
	}
	return { connection, notifications }
}

const rejectMethod = async (): Promise<IAgentRuntimeResponse> => {
	throw new Error("本用例未实现该运行时方法")
}

// 用统一 run 实现填 chat/plan/execute,其余方法报错;overrides 可单独覆盖某方法。
const makeRuntime = (
	run: (
		input: IAgentRuntimeInput,
		options?: IAgentRuntimeRunOptions,
	) => Promise<IAgentRuntimeResponse>,
	overrides: Partial<IAgentSidecarRuntime> = {},
): IAgentSidecarRuntime => ({
	name: "mastra",
	version: "test",
	chat: run,
	plan: run,
	execute: run,
	validatePlan: rejectMethod,
	replanPlan: rejectMethod,
	approvePlan: rejectMethod,
	getPlan: rejectMethod,
	rejectPlan: rejectMethod,
	finishPlan: rejectMethod,
	resolveApproval: rejectMethod,
	restoreCheckpoint: rejectMethod,
	...overrides,
})

const eventContext = {
	runId: "run-1",
	sessionId: "sess-1",
	agentId: "agent-1",
	now: () => "2026-01-01T00:00:00.000Z",
}

test("prompt 把 agent_event 投影为 session/update,并在收尾发 usage_update + end_turn", async () => {
	const { connection, notifications } = recordingConnection()
	const agent = new CalamexAcpAgent(
		connection,
		makeRuntime(async (input, options) => {
			options?.onEvent?.({
				type: "agent_event",
				event: createAgentRuntimeEvent(eventContext, 1, {
					type: "agent.text.delta",
					visibility: "user",
					text: "你好",
				}),
			})
			return {
				sessionId: input.sessionId ?? "",
				events: [],
				result: "你好",
				usage: { totalTokens: 1200 },
			}
		}),
		{ generateRequestId: () => "req-1" },
	)
	const { sessionId } = await agent.newSession({ cwd: "/work", mcpServers: [] })
	const response = await agent.prompt({
		sessionId,
		prompt: [{ type: "text", text: "hi" }],
	})
	assert.equal(response.stopReason, "end_turn")
	const chunk = notifications.find(
		(n) => n.update.sessionUpdate === "agent_message_chunk",
	)
	assert.ok(chunk, "应有 agent_message_chunk 通知")
	const usage = notifications.find(
		(n) => n.update.sessionUpdate === "usage_update",
	)
	assert.ok(usage, "应有 usage_update 通知")
	assert.equal((usage.update as { used: number }).used, 1200)
	assert.equal((usage.update as { size: number }).size, 128_000)
})

test("prompt 在工具审批挂起时发起 request_permission,批准后回灌 resolveApproval 续跑", async () => {
	const approvals: RequestPermissionRequest[] = []
	const { connection } = recordingConnection(async (request) => {
		approvals.push(request)
		return { outcome: { outcome: "selected", optionId: "allow-once" } }
	})
	const pendingRequest = {
		id: encodeApprovalRequestId("run-9", "tool-7"),
		toolName: "shell",
		question: "运行命令?",
		summary: "rm -rf /tmp/x",
		riskLevel: "high" as const,
		reversible: false,
		createdAt: "2026-01-01T00:00:00.000Z",
	}
	let executeCalls = 0
	const resolveCalls: Array<{ requestId: string; decision: string }> = []
	const runtime = makeRuntime(
		async (input) => {
			executeCalls += 1
			return {
				sessionId: input.sessionId ?? "",
				events: [
					{ type: "approval_required" as const, request: pendingRequest },
				],
				result: null,
			}
		},
		{
			resolveApproval: async (input) => {
				resolveCalls.push({
					requestId: input.requestId,
					decision: input.decision,
				})
				return {
					sessionId: input.sessionId ?? "",
					events: [],
					result: "完成",
					usage: { totalTokens: 10 },
				}
			},
		},
	)
	const agent = new CalamexAcpAgent(connection, runtime)
	const { sessionId } = await agent.newSession({ cwd: "/w", mcpServers: [] })
	const response = await agent.prompt({
		sessionId,
		prompt: [{ type: "text", text: "go" }],
	})
	assert.equal(response.stopReason, "end_turn")
	assert.equal(executeCalls, 1)
	assert.equal(approvals.length, 1)
	// 权限请求的 toolCallId 应是从审批 token 解码出的原始 Mastra toolCallId。
	assert.equal(approvals[0]?.toolCall.toolCallId, "tool-7")
	// 裁决应以 approval_required 的 request.id 原样回灌,且映射为 approve。
	assert.deepEqual(resolveCalls, [
		{ requestId: pendingRequest.id, decision: "approve" },
	])
})

test("prompt 在回合被 cancel 后返回 cancelled", async () => {
	const { connection } = recordingConnection()
	let release: (() => void) | undefined
	const agent = new CalamexAcpAgent(
		connection,
		makeRuntime(
			(input) =>
				new Promise((resolve) => {
					release = () =>
						resolve({ sessionId: input.sessionId ?? "", events: [], result: null })
				}),
		),
	)
	const { sessionId } = await agent.newSession({ cwd: "/w", mcpServers: [] })
	const pending = agent.prompt({
		sessionId,
		prompt: [{ type: "text", text: "go" }],
	})
	await agent.cancel({ sessionId })
	release?.()
	const response = await pending
	assert.equal(response.stopReason, "cancelled")
})

test("setSessionMode 拒绝非法模式,接受合法模式并路由到对应 runtime 方法", async () => {
	const { connection } = recordingConnection()
	const calls: string[] = []
	const runtime = makeRuntime(
		async (input) => {
			calls.push("execute")
			return { sessionId: input.sessionId ?? "", events: [], result: null }
		},
		{
			chat: async (input) => {
				calls.push("chat")
				return { sessionId: input.sessionId ?? "", events: [], result: null }
			},
			plan: async (input) => {
				calls.push("plan")
				return { sessionId: input.sessionId ?? "", events: [], result: null }
			},
		},
	)
	const agent = new CalamexAcpAgent(connection, runtime)
	const { sessionId } = await agent.newSession({ cwd: "/w", mcpServers: [] })
	await assert.rejects(() =>
		agent.setSessionMode({ sessionId, modeId: "bogus" }),
	)
	await agent.setSessionMode({ sessionId, modeId: "plan" })
	await agent.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] })
	await agent.setSessionMode({ sessionId, modeId: "ask" })
	await agent.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] })
	assert.deepEqual(calls, ["plan", "chat"])
})

test("prompt 对未知会话抛出错误", async () => {
	const { connection } = recordingConnection()
	const agent = new CalamexAcpAgent(
		connection,
		makeRuntime(async (input) => ({
			sessionId: input.sessionId ?? "",
			events: [],
			result: null,
		})),
	)
	await assert.rejects(() =>
		agent.prompt({ sessionId: "nope", prompt: [{ type: "text", text: "x" }] }),
	)
})
