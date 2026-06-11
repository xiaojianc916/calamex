import assert from "node:assert/strict"
import { test } from "node:test"

import { AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION } from "../schemas/events.js"
import {
	CALAMEX_AGENT_CAPABILITY_META,
	CALAMEX_EXT_NAMESPACE,
	MODEL_CHAT_METHOD,
	parseModelChatParams,
	toModelChatExtResult,
} from "./ext-methods.js"

test("MODEL_CHAT_METHOD：命名空间前缀 + model/chat 资源动作", () => {
	assert.equal(MODEL_CHAT_METHOD, `${CALAMEX_EXT_NAMESPACE}/model/chat`)
})

test("能力公示：_meta 暴露 modelChat 扩展方法名", () => {
	const namespaceMeta = CALAMEX_AGENT_CAPABILITY_META[
		CALAMEX_EXT_NAMESPACE
	] as { extMethods: Record<string, string> }
	assert.equal(namespaceMeta.extMethods.modelChat, MODEL_CHAT_METHOD)
})

test("parseModelChatParams：保序透传 system 与对话消息，mode 固定 ask", () => {
	const input = parseModelChatParams({
		messages: [
			{ role: "system", content: "你是标题生成器，只输出 5-10 字标题。" },
			{ role: "user", content: "帮这段对话起个标题" },
		],
		modelConfig: { modelId: "deepseek/deepseek-v4-pro", apiKey: "sk-test" },
	})

	assert.equal(input.mode, "ask")
	assert.equal(input.goal, "")
	assert.equal(input.messages.length, 2)
	assert.equal(input.messages[0]?.role, "system")
	assert.equal(input.messages[1]?.role, "user")
	assert.equal(input.modelConfig?.modelId, "deepseek/deepseek-v4-pro")
})

test("parseModelChatParams：可选字段仅在提供时写入", () => {
	const minimal = parseModelChatParams({
		messages: [{ role: "user", content: "ping" }],
	})
	assert.equal(minimal.goal, "")
	assert.equal(minimal.sessionId, undefined)
	assert.equal(minimal.workspaceRootPath, undefined)
	assert.equal(minimal.modelConfig, undefined)

	const full = parseModelChatParams({
		messages: [{ role: "user", content: "ping" }],
		goal: "连接测试",
		sessionId: "sess-1",
		workspaceRootPath: "/tmp/ws",
	})
	assert.equal(full.goal, "连接测试")
	assert.equal(full.sessionId, "sess-1")
	assert.equal(full.workspaceRootPath, "/tmp/ws")
})

test("parseModelChatParams：messages 为空或缺失时拒绝", () => {
	assert.throws(() => parseModelChatParams({ messages: [] }))
	assert.throws(() => parseModelChatParams({}))
})

test("toModelChatExtResult：投影为标准 sidecar 响应信封", () => {
	const result = toModelChatExtResult({
		sessionId: "sess-1",
		events: [],
		result: "标题：ACP 透传方案",
	})
	assert.equal(result.schemaVersion, AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION)
	assert.equal(result.sessionId, "sess-1")
	assert.equal(result.result, "标题：ACP 透传方案")
	assert.deepEqual(result.events, [])
})
