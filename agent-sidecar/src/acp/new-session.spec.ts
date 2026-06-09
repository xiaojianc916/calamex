import { test } from "node:test"
import assert from "node:assert/strict"

import {
	newSessionRequestSchema,
	newSessionResponseSchema,
	loadSessionRequestSchema,
	loadSessionResponseSchema,
	newSessionResponse,
} from "./new-session.js"

const stdioServer = { name: "fs", command: "c", args: [], env: [] }

test("newSessionRequest 需要 cwd 与 mcpServers，additionalDirectories 可选", () => {
	const req = newSessionRequestSchema.parse({ cwd: "/repo", mcpServers: [stdioServer] })
	assert.equal(req.cwd, "/repo")
	assert.equal(req.mcpServers.length, 1)
	assert.equal(req.additionalDirectories, undefined)
	assert.throws(() => newSessionRequestSchema.parse({ mcpServers: [] }))
})

test("newSessionResponse 需要 sessionId，modes/configOptions 可选", () => {
	const minimal = newSessionResponseSchema.parse({ sessionId: "s1" })
	assert.equal(minimal.sessionId, "s1")
	const full = newSessionResponseSchema.parse({
		sessionId: "s1",
		modes: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }] },
		configOptions: [
			{ type: "select", id: "model", name: "Model", currentValue: "d", options: [] },
		],
	})
	assert.equal(full.modes?.currentModeId, "agent")
	assert.equal(full.configOptions?.length, 1)
	assert.throws(() => newSessionResponseSchema.parse({}))
})

test("newSessionResponse 构造器：sessionId 必填并合并可选字段", () => {
	assert.deepEqual(newSessionResponse("s1"), { sessionId: "s1" })
	const r = newSessionResponse("s1", {
		modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] },
	})
	assert.equal(r.modes?.currentModeId, "ask")
})

test("loadSessionRequest 需要 cwd/mcpServers/sessionId", () => {
	const req = loadSessionRequestSchema.parse({
		cwd: "/repo",
		mcpServers: [stdioServer],
		sessionId: "s1",
	})
	assert.equal(req.sessionId, "s1")
	assert.throws(() => loadSessionRequestSchema.parse({ cwd: "/repo", mcpServers: [] }))
})

test("loadSessionResponse 可为空或携带 modes/configOptions", () => {
	assert.deepEqual(loadSessionResponseSchema.parse({}) as Record<string, unknown>, {})
	const r = loadSessionResponseSchema.parse({
		modes: { currentModeId: "ask", availableModes: [] },
	})
	assert.equal(r.modes?.currentModeId, "ask")
})
