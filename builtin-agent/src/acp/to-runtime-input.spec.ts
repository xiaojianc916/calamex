import assert from "node:assert/strict"
import { test } from "node:test"

import type { ContentBlock } from "@agentclientprotocol/sdk"
import {
	buildPromptRuntimeInput,
	contentBlockToText,
	promptToUserText,
} from "./to-runtime-input.js"

test("文本块拼接为 goal 与单条 user 消息", () => {
	const prompt: ContentBlock[] = [
		{ type: "text", text: "第一段" },
		{ type: "text", text: "第二段" },
	]
	const input = buildPromptRuntimeInput({
		sessionId: "s1",
		mode: "agent",
		prompt,
	})
	assert.equal(input.sessionId, "s1")
	assert.equal(input.mode, "agent")
	assert.equal(input.goal, "第一段\n\n第二段")
	assert.deepEqual(input.messages, [
		{ role: "user", content: "第一段\n\n第二段" },
	])
})

test("resource_link 投影为可读引用行", () => {
	assert.equal(
		contentBlockToText({
			type: "resource_link",
			uri: "file:///a.ts",
			name: "a.ts",
		}),
		"引用：a.ts（file:///a.ts）",
	)
})

test("resource：内联 text 投影为带附件抬头的正文，无 text 用 uri", () => {
	assert.equal(
		contentBlockToText({
			type: "resource",
			resource: { uri: "attachment:///b.ts", text: "内联内容" },
		} as ContentBlock),
		"附件 b.ts：\n内联内容",
	)
	assert.equal(
		contentBlockToText({
			type: "resource",
			resource: {
				uri: "attachment:///b.ts",
				text: "内联内容",
				mimeType: "text/x-typescript",
			},
		} as ContentBlock),
		"附件 b.ts（text/x-typescript）：\n内联内容",
	)
	assert.equal(
		contentBlockToText({
			type: "resource",
			resource: { uri: "file:///c.ts" },
		} as ContentBlock),
		"引用：file:///c.ts",
	)
})

test("image / audio 无内联文本被跳过", () => {
	assert.equal(
		contentBlockToText({ type: "image", data: "x", mimeType: "image/png" }),
		null,
	)
	assert.equal(
		contentBlockToText({ type: "audio", data: "x", mimeType: "audio/wav" }),
		null,
	)
	const prompt: ContentBlock[] = [
		{ type: "text", text: "看图" },
		{ type: "image", data: "x", mimeType: "image/png" },
	]
	assert.equal(promptToUserText(prompt), "看图")
})

test("空 prompt 回退到兑底 goal", () => {
	const input = buildPromptRuntimeInput({
		sessionId: "s1",
		mode: "ask",
		prompt: [],
	})
	assert.equal(input.goal, "继续当前任务")
	assert.deepEqual(input.messages, [
		{ role: "user", content: "继续当前任务" },
	])
})

test("可选字段仅在提供时写入", () => {
	const base = buildPromptRuntimeInput({
		sessionId: "s1",
		mode: "agent",
		prompt: [{ type: "text", text: "hi" }],
	})
	assert.equal("workspaceRootPath" in base, false)
	assert.equal("threadId" in base, false)
	assert.equal("modelConfig" in base, false)

	const full = buildPromptRuntimeInput({
		sessionId: "s1",
		mode: "agent",
		prompt: [{ type: "text", text: "hi" }],
		workspaceRootPath: "/repo",
		threadId: "t1",
		modelConfig: { modelId: "m", apiKey: "k" },
	})
	assert.equal(full.workspaceRootPath, "/repo")
	assert.equal(full.threadId, "t1")
	assert.deepEqual(full.modelConfig, { modelId: "m", apiKey: "k" })
})
