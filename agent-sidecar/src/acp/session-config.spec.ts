import { test } from "node:test"
import assert from "node:assert/strict"

import {
	sessionConfigSelectOptionSchema,
	sessionConfigSelectGroupSchema,
	sessionConfigSelectOptionsSchema,
	sessionConfigOptionSchema,
	setSessionConfigOptionRequestSchema,
	setSessionConfigOptionResponseSchema,
	setSessionConfigOptionResponse,
} from "./session-config.js"

test("selectOption 需要 value 与 name，description 可缺省", () => {
	const opt = sessionConfigSelectOptionSchema.parse({ value: "v1", name: "One" })
	assert.equal(opt.value, "v1")
	assert.equal(opt.description, undefined)
	assert.throws(() => sessionConfigSelectOptionSchema.parse({ name: "One" }))
})

test("selectGroup 需要 group/name/options", () => {
	const grp = sessionConfigSelectGroupSchema.parse({
		group: "g1",
		name: "Group",
		options: [{ value: "v1", name: "One" }],
	})
	assert.equal(grp.options.length, 1)
	assert.throws(() => sessionConfigSelectGroupSchema.parse({ group: "g1", name: "Group" }))
})

test("selectOptions 并集：未分组、分组、空数组均可", () => {
	assert.equal(sessionConfigSelectOptionsSchema.parse([{ value: "v", name: "n" }]).length, 1)
	assert.equal(
		sessionConfigSelectOptionsSchema.parse([
			{ group: "g", name: "G", options: [{ value: "v", name: "n" }] },
		]).length,
		1,
	)
	assert.deepEqual(sessionConfigSelectOptionsSchema.parse([]), [])
})

test("sessionConfigOption 解析 select 变体，category 可缺省", () => {
	const opt = sessionConfigOptionSchema.parse({
		type: "select",
		id: "model",
		name: "Model",
		currentValue: "deepseek",
		options: [{ value: "deepseek", name: "DeepSeek" }],
	})
	assert.equal(opt.type, "select")
	assert.equal(opt.currentValue, "deepseek")
})

test("sessionConfigOption 拒绝未知 type 与缺 currentValue", () => {
	assert.throws(() => sessionConfigOptionSchema.parse({ type: "toggle", id: "x", name: "X" }))
	assert.throws(() =>
		sessionConfigOptionSchema.parse({ type: "select", id: "x", name: "X", options: [] }),
	)
})

test("setSessionConfigOption 请求/响应与构造器", () => {
	const req = setSessionConfigOptionRequestSchema.parse({
		sessionId: "s1",
		configId: "model",
		value: "deepseek",
	})
	assert.equal(req.configId, "model")
	const built = setSessionConfigOptionResponse([
		{ type: "select", id: "model", name: "Model", currentValue: "deepseek", options: [] },
	])
	assert.equal(setSessionConfigOptionResponseSchema.parse(built).configOptions.length, 1)
})
