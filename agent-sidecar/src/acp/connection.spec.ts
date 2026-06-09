import assert from "node:assert/strict"
import { test } from "node:test"

import {
	AcpConnection,
	type TAcpNotificationHandler,
	type TAcpOutgoingMessage,
	type TAcpRequestHandler,
} from "./connection"
import { ACP_ERROR_CODES } from "./jsonrpc"
import { AcpRpcError } from "./request-client"

const createHarness = () => {
	const sent: TAcpOutgoingMessage[] = []
	const requestHandlers = new Map<string, TAcpRequestHandler>()
	const notificationHandlers = new Map<string, TAcpNotificationHandler>()
	const errors: Array<{ error: unknown; method?: string }> = []
	const connection = new AcpConnection({
		send: (message) => {
			sent.push(message)
		},
		requestHandlers,
		notificationHandlers,
		onError: (error, context) => {
			errors.push({ error, method: context.method })
		},
	})
	return { sent, requestHandlers, notificationHandlers, errors, connection }
}

test("入站请求：路由到处理器并以同 id 回送成功响应", async () => {
	const harness = createHarness()
	harness.requestHandlers.set("initialize", (params) => ({ echoed: params }))
	await harness.connection.receive({
		jsonrpc: "2.0",
		id: 7,
		method: "initialize",
		params: { v: 1 },
	})
	assert.deepEqual(harness.sent, [
		{ jsonrpc: "2.0", id: 7, result: { echoed: { v: 1 } } },
	])
})

test("入站请求：未知方法回送 methodNotFound", async () => {
	const harness = createHarness()
	await harness.connection.receive({
		jsonrpc: "2.0",
		id: "abc",
		method: "session/unknown",
	})
	const message = harness.sent[0]
	assert.ok("error" in message)
	assert.equal(message.id, "abc")
	assert.equal(message.error.code, ACP_ERROR_CODES.methodNotFound)
})

test("入站请求：处理器抛 AcpRpcError 时保留 code 与 data", async () => {
	const harness = createHarness()
	harness.requestHandlers.set("session/prompt", () => {
		throw new AcpRpcError({
			code: ACP_ERROR_CODES.authRequired,
			message: "需要鉴权",
			data: { hint: "login" },
		})
	})
	await harness.connection.receive({
		jsonrpc: "2.0",
		id: 1,
		method: "session/prompt",
	})
	const message = harness.sent[0]
	assert.ok("error" in message)
	assert.equal(message.error.code, ACP_ERROR_CODES.authRequired)
	assert.equal(message.error.message, "需要鉴权")
	assert.deepEqual(message.error.data, { hint: "login" })
})

test("入站请求：处理器抛普通错误时映射为 internalError", async () => {
	const harness = createHarness()
	harness.requestHandlers.set("session/new", () => {
		throw new Error("炸了")
	})
	await harness.connection.receive({
		jsonrpc: "2.0",
		id: 2,
		method: "session/new",
	})
	const message = harness.sent[0]
	assert.ok("error" in message)
	assert.equal(message.error.code, ACP_ERROR_CODES.internalError)
	assert.equal(message.error.message, "炸了")
	assert.equal(harness.errors.length, 1)
})

test("入站通知：路由到通知处理器且不回送响应", async () => {
	const harness = createHarness()
	let received: unknown = null
	harness.notificationHandlers.set("session/cancel", (params) => {
		received = params
	})
	await harness.connection.receive({
		jsonrpc: "2.0",
		method: "session/cancel",
		params: { sessionId: "s1" },
	})
	assert.deepEqual(received, { sessionId: "s1" })
	assert.equal(harness.sent.length, 0)
})

test("入站响应：按 id 结算在途出站请求", async () => {
	const harness = createHarness()
	const pending = harness.connection.sendRequest("session/request_permission", {
		sessionId: "s1",
	})
	const frame = harness.sent[0]
	assert.ok("method" in frame && "id" in frame)
	assert.equal(frame.method, "session/request_permission")
	await harness.connection.receive({
		jsonrpc: "2.0",
		id: frame.id,
		result: { ok: true },
	})
	assert.deepEqual(await pending, { ok: true })
})

test("出站请求：写出递增数字 id 的请求帧", () => {
	const harness = createHarness()
	void harness.connection.sendRequest("fs/read_text_file", { path: "/a" })
	void harness.connection.sendRequest("fs/write_text_file", { path: "/b" })
	const first = harness.sent[0]
	const second = harness.sent[1]
	assert.ok("method" in first && "id" in first)
	assert.ok("method" in second && "id" in second)
	assert.equal(first.method, "fs/read_text_file")
	assert.equal(typeof first.id, "number")
	assert.equal(second.id, (first.id as number) + 1)
})

test("出站通知：写出无 id 的通知帧", () => {
	const harness = createHarness()
	harness.connection.sendNotification("session/update", { sessionId: "s1" })
	const message = harness.sent[0]
	assert.ok("method" in message)
	assert.equal(message.method, "session/update")
	assert.equal("id" in message, false)
	assert.deepEqual(message.params, { sessionId: "s1" })
})

test("close：拒绝所有在途出站请求", async () => {
	const harness = createHarness()
	const pending = harness.connection.sendRequest("session/request_permission")
	harness.connection.close(new Error("连接关闭"))
	await assert.rejects(pending, /连接关闭/)
})

test("入站响应：孤儿 id 仅上报不抛错也不回送", async () => {
	const harness = createHarness()
	await harness.connection.receive({ jsonrpc: "2.0", id: 999, result: {} })
	assert.equal(harness.sent.length, 0)
	assert.equal(harness.errors.length, 1)
})
