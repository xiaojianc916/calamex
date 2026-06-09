import { strict as assert } from "node:assert"
import { test } from "node:test"
import { toUsageUpdate } from "./usage.js"

test("totalTokens 优先，size 取上下文窗口", () => {
	const update = toUsageUpdate({ totalTokens: 1200, promptTokens: 800, completionTokens: 400 }, 128_000)
	assert.deepEqual(update, { sessionUpdate: "usage_update", used: 1200, size: 128_000 })
})

test("缺 totalTokens 时回退为 prompt+completion", () => {
	const update = toUsageUpdate({ promptTokens: 800, completionTokens: 400 }, 200_000)
	assert.equal(update?.used, 1200)
	assert.equal(update?.size, 200_000)
})

test("无 token 数据 → null", () => {
	assert.equal(toUsageUpdate({}, 128_000), null)
})

test("窗口不合法 → null", () => {
	assert.equal(toUsageUpdate({ totalTokens: 100 }, 0), null)
	assert.equal(toUsageUpdate({ totalTokens: 100 }, Number.NaN), null)
})
