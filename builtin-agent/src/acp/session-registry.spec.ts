import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
	AcpSessionRegistry,
	type IAcpSessionCreateParams,
} from "./session-registry.js"
import type { McpServer } from "@agentclientprotocol/sdk"

const stdioServer: McpServer = {
	name: "fs",
	command: "node",
	args: ["server.js"],
	env: [{ name: "TOKEN", value: "secret" }],
}

const baseParams = (): IAcpSessionCreateParams => ({
	workspaceRootPath: "/work/repo",
	mcpServers: [stdioServer],
	mode: "agent",
})

// 确定化 sessionId 生成器，便于断言。
const sequentialIds = (): (() => string) => {
	let n = 0
	return () => `session-${++n}`
}

describe("AcpSessionRegistry", () => {
	it("create 登记会话并返回初始状态", () => {
		const registry = new AcpSessionRegistry({ generateSessionId: sequentialIds() })
		const state = registry.create(baseParams())
		assert.equal(state.sessionId, "session-1")
		assert.equal(state.workspaceRootPath, "/work/repo")
		assert.deepEqual(state.mcpServers, [stdioServer])
		assert.equal(state.mode, "agent")
		assert.equal(state.abortController, null)
		assert.equal(registry.size, 1)
		assert.equal(registry.get("session-1"), state)
	})

	it("create 仅在提供时写入 modelConfig", () => {
		const registry = new AcpSessionRegistry({ generateSessionId: sequentialIds() })
		const without = registry.create(baseParams())
		assert.equal("modelConfig" in without, false)
		const withConfig = registry.create({
			...baseParams(),
			modelConfig: { modelId: "deepseek/deepseek-v4-pro", apiKey: "k" },
		})
		assert.deepEqual(withConfig.modelConfig, {
			modelId: "deepseek/deepseek-v4-pro",
			apiKey: "k",
		})
	})

	it("默认使用 randomUUID 生成不重复 sessionId", () => {
		const registry = new AcpSessionRegistry()
		const a = registry.create(baseParams())
		const b = registry.create(baseParams())
		assert.notEqual(a.sessionId, b.sessionId)
		assert.equal(registry.size, 2)
	})

	it("get / has 对未知会话返回 undefined / false", () => {
		const registry = new AcpSessionRegistry()
		assert.equal(registry.get("missing"), undefined)
		assert.equal(registry.has("missing"), false)
	})

	it("setMode 切换已登记会话模式，未知会话返回 undefined", () => {
		const registry = new AcpSessionRegistry({ generateSessionId: sequentialIds() })
		registry.create(baseParams())
		const updated = registry.setMode("session-1", "plan")
		assert.equal(updated?.mode, "plan")
		assert.equal(registry.get("session-1")?.mode, "plan")
		assert.equal(registry.setMode("missing", "ask"), undefined)
	})

	it("beginTurn 登记全新句柄，再次调用先中止上一个", () => {
		const registry = new AcpSessionRegistry({ generateSessionId: sequentialIds() })
		registry.create(baseParams())
		const first = registry.beginTurn("session-1")
		assert.ok(first)
		assert.equal(registry.get("session-1")?.abortController, first)
		assert.equal(first.signal.aborted, false)
		const second = registry.beginTurn("session-1")
		assert.ok(second)
		assert.equal(first.signal.aborted, true)
		assert.equal(second.signal.aborted, false)
		assert.equal(registry.get("session-1")?.abortController, second)
	})

	it("beginTurn 对未知会话返回 undefined", () => {
		const registry = new AcpSessionRegistry()
		assert.equal(registry.beginTurn("missing"), undefined)
	})

	it("endTurn 清空句柄但不主动中止", () => {
		const registry = new AcpSessionRegistry({ generateSessionId: sequentialIds() })
		registry.create(baseParams())
		const controller = registry.beginTurn("session-1")
		assert.ok(controller)
		registry.endTurn("session-1")
		assert.equal(registry.get("session-1")?.abortController, null)
		assert.equal(controller.signal.aborted, false)
	})

	it("cancel 中止活跃回合并清空，返回 true", () => {
		const registry = new AcpSessionRegistry({ generateSessionId: sequentialIds() })
		registry.create(baseParams())
		const controller = registry.beginTurn("session-1")
		assert.ok(controller)
		assert.equal(registry.cancel("session-1"), true)
		assert.equal(controller.signal.aborted, true)
		assert.equal(registry.get("session-1")?.abortController, null)
	})

	it("cancel 在无活跃回合 / 未知会话时返回 false", () => {
		const registry = new AcpSessionRegistry({ generateSessionId: sequentialIds() })
		registry.create(baseParams())
		assert.equal(registry.cancel("session-1"), false)
		assert.equal(registry.cancel("missing"), false)
	})

	it("delete 注销会话并中止其活跃回合", () => {
		const registry = new AcpSessionRegistry({ generateSessionId: sequentialIds() })
		registry.create(baseParams())
		const controller = registry.beginTurn("session-1")
		assert.ok(controller)
		assert.equal(registry.delete("session-1"), true)
		assert.equal(controller.signal.aborted, true)
		assert.equal(registry.has("session-1"), false)
		assert.equal(registry.size, 0)
	})

	it("delete 对未知会话返回 false", () => {
		const registry = new AcpSessionRegistry()
		assert.equal(registry.delete("missing"), false)
	})
})
