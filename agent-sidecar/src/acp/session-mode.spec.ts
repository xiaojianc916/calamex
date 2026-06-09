import { test } from "node:test"
import assert from "node:assert/strict"

import {
	sessionModeSchema,
	sessionModeStateSchema,
	setSessionModeRequestSchema,
	setSessionModeResponseSchema,
	setSessionModeResponse,
} from "./session-mode.js"

test("sessionMode 需要 id 与 name 且透传 _meta", () => {
	const mode = sessionModeSchema.parse({ id: "ask", name: "Ask", _meta: { x: 1 } })
	assert.equal(mode.id, "ask")
	assert.equal(mode.name, "Ask")
	assert.throws(() => sessionModeSchema.parse({ id: "ask" }))
})

test("sessionMode 的 description 可缺省或为 null", () => {
	assert.equal(sessionModeSchema.parse({ id: "a", name: "A" }).description, undefined)
	assert.equal(
		sessionModeSchema.parse({ id: "a", name: "A", description: null }).description,
		null,
	)
	assert.equal(
		sessionModeSchema.parse({ id: "a", name: "A", description: "desc" }).description,
		"desc",
	)
})

test("sessionModeState 需要 currentModeId 与 availableModes", () => {
	const state = sessionModeStateSchema.parse({
		currentModeId: "agent",
		availableModes: [
			{ id: "ask", name: "Ask" },
			{ id: "agent", name: "Agent" },
		],
	})
	assert.equal(state.currentModeId, "agent")
	assert.equal(state.availableModes.length, 2)
	assert.throws(() => sessionModeStateSchema.parse({ availableModes: [] }))
})

test("setSessionModeRequest 需要 sessionId 与 modeId", () => {
	const req = setSessionModeRequestSchema.parse({ sessionId: "s1", modeId: "plan" })
	assert.equal(req.sessionId, "s1")
	assert.equal(req.modeId, "plan")
	assert.throws(() => setSessionModeRequestSchema.parse({ sessionId: "s1" }))
})

test("setSessionModeResponse 解析空对象并透传 _meta", () => {
	assert.deepEqual(
		setSessionModeResponseSchema.parse({ _meta: { ok: true } }) as Record<string, unknown>,
		{ _meta: { ok: true } },
	)
})

test("setSessionModeResponse 构造器返回空响应", () => {
	assert.deepEqual(setSessionModeResponse(), {})
})
