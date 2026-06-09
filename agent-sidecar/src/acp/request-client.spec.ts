import assert from "node:assert/strict"
import { test } from "node:test"

import { jsonRpcError, jsonRpcSuccess, type TJsonRpcRequest } from "./jsonrpc"
import { AcpRequestClient, AcpRpcError } from "./request-client"

test("sendRequest 写出自增 id 的合法请求", () => {
	const sent: TJsonRpcRequest[] = []
	const client = new AcpRequestClient((req) => sent.push(req))
	void client.sendRequest("session/request_permission", { sessionId: "s-1" })
	void client.sendRequest("fs/read_text_file", { path: "a.ts" })
	assert.equal(sent.length, 2)
	assert.equal(sent[0].jsonrpc, "2.0")
	assert.equal(sent[0].id, 1)
	assert.equal(sent[0].method, "session/request_permission")
	assert.deepEqual(sent[0].params, { sessionId: "s-1" })
	assert.equal(sent[1].id, 2)
	assert.equal(client.pendingCount, 2)
})

test("handleResponse 结算成功响应", async () => {
	const sent: TJsonRpcRequest[] = []
	const client = new AcpRequestClient((req) => sent.push(req))
	const promise = client.sendRequest("session/request_permission")
	const matched = client.handleResponse(
		jsonRpcSuccess(sent[0].id, {
			outcome: { outcome: "selected", optionId: "allow" },
		}),
	)
	assert.equal(matched, true)
	assert.equal(client.pendingCount, 0)
	assert.deepEqual(await promise, {
		outcome: { outcome: "selected", optionId: "allow" },
	})
})

test("handleResponse 以 AcpRpcError 拒绝错误响应（保留 code/data）", async () => {
	const sent: TJsonRpcRequest[] = []
	const client = new AcpRequestClient((req) => sent.push(req))
	const promise = client.sendRequest("fs/read_text_file")
	client.handleResponse(
		jsonRpcError(sent[0].id, {
			code: -32002,
			message: "not found",
			data: { path: "a.ts" },
		}),
	)
	await assert.rejects(promise, (err: unknown) => {
		assert.ok(err instanceof AcpRpcError)
		assert.equal(err.code, -32002)
		assert.equal(err.message, "not found")
		assert.deepEqual(err.data, { path: "a.ts" })
		return true
	})
})

test("handleResponse 对未知/重复 id 返回 false", async () => {
	const sent: TJsonRpcRequest[] = []
	const client = new AcpRequestClient((req) => sent.push(req))
	const promise = client.sendRequest("session/request_permission")
	assert.equal(client.handleResponse(jsonRpcSuccess(999, {})), false)
	assert.equal(client.handleResponse(jsonRpcSuccess(null, {})), false)
	assert.equal(
		client.handleResponse(jsonRpcSuccess(sent[0].id, { ok: true })),
		true,
	)
	// 重复结算同一 id 不再命中。
	assert.equal(
		client.handleResponse(jsonRpcSuccess(sent[0].id, { ok: true })),
		false,
	)
	await promise
})

test("startId 可自定义，id 单调自增", () => {
	const sent: TJsonRpcRequest[] = []
	const client = new AcpRequestClient((req) => sent.push(req), 100)
	void client.sendRequest("a")
	void client.sendRequest("b")
	assert.equal(sent[0].id, 100)
	assert.equal(sent[1].id, 101)
})

test("rejectAll 清空并拒绝所有在途请求", async () => {
	const sent: TJsonRpcRequest[] = []
	const client = new AcpRequestClient((req) => sent.push(req))
	const p1 = client.sendRequest("a")
	const p2 = client.sendRequest("b")
	assert.equal(client.pendingCount, 2)
	const reason = new Error("connection closed")
	client.rejectAll(reason)
	assert.equal(client.pendingCount, 0)
	await assert.rejects(p1, (e: unknown) => e === reason)
	await assert.rejects(p2, (e: unknown) => e === reason)
})
