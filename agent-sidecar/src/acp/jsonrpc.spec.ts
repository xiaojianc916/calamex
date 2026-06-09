import assert from "node:assert/strict"
import { test } from "node:test"

import {
	ACP_AGENT_METHODS,
	ACP_CLIENT_METHODS,
	ACP_ERROR_CODES,
	JSON_RPC_VERSION,
	acpError,
	isJsonRpcErrorResponse,
	jsonRpcError,
	jsonRpcNotification,
	jsonRpcNotificationSchema,
	jsonRpcRequest,
	jsonRpcRequestSchema,
	jsonRpcResponseSchema,
	jsonRpcSuccess,
	requestIdSchema,
} from "./jsonrpc.js"

test("方法名注册表 1:1 对齐 schema/v1/meta.json（稳定面）", () => {
	assert.equal(ACP_AGENT_METHODS.initialize, "initialize")
	assert.equal(ACP_AGENT_METHODS.sessionNew, "session/new")
	assert.equal(ACP_AGENT_METHODS.sessionPrompt, "session/prompt")
	assert.equal(ACP_AGENT_METHODS.sessionCancel, "session/cancel")
	assert.equal(ACP_CLIENT_METHODS.sessionUpdate, "session/update")
	assert.equal(
		ACP_CLIENT_METHODS.sessionRequestPermission,
		"session/request_permission",
	)
})

test("错误码 1:1 对齐 src/v1/error.rs（稳定面）", () => {
	assert.equal(ACP_ERROR_CODES.parseError, -32700)
	assert.equal(ACP_ERROR_CODES.invalidRequest, -32600)
	assert.equal(ACP_ERROR_CODES.methodNotFound, -32601)
	assert.equal(ACP_ERROR_CODES.invalidParams, -32602)
	assert.equal(ACP_ERROR_CODES.internalError, -32603)
	assert.equal(ACP_ERROR_CODES.authRequired, -32000)
	assert.equal(ACP_ERROR_CODES.resourceNotFound, -32002)
})

test("requestId 接受 string | number | null，拒绝非整数", () => {
	assert.equal(requestIdSchema.parse("id-1"), "id-1")
	assert.equal(requestIdSchema.parse(7), 7)
	assert.equal(requestIdSchema.parse(null), null)
	assert.equal(requestIdSchema.safeParse(1.5).success, false)
})

test("通知信封：无 id、jsonrpc 恒为 2.0，匹配 rpc.rs 线上形状", () => {
	const note = jsonRpcNotification(ACP_CLIENT_METHODS.sessionUpdate, {
		sessionId: "test-456",
		update: {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Hello" },
		},
	})
	assert.deepEqual(note, {
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "test-456",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Hello" },
			},
		},
	})
	assert.equal("id" in note, false)
	assert.equal(jsonRpcNotificationSchema.safeParse(note).success, true)
})

test("请求信封：带 id 与 method", () => {
	const req = jsonRpcRequest(1, ACP_AGENT_METHODS.sessionPrompt, {
		sessionId: "s1",
	})
	assert.equal(req.jsonrpc, JSON_RPC_VERSION)
	assert.equal(req.id, 1)
	assert.equal(req.method, "session/prompt")
	assert.equal(jsonRpcRequestSchema.safeParse(req).success, true)
})

test("响应：成功与错误靠 error 字段区分", () => {
	const ok = jsonRpcResponseSchema.parse(jsonRpcSuccess(1, { stopReason: "end_turn" }))
	assert.equal(isJsonRpcErrorResponse(ok), false)

	const parsedErr = jsonRpcResponseSchema.parse(
		jsonRpcError(2, acpError(ACP_ERROR_CODES.methodNotFound, "Method not found")),
	)
	assert.equal(isJsonRpcErrorResponse(parsedErr), true)
	if (isJsonRpcErrorResponse(parsedErr)) {
		assert.equal(parsedErr.error.code, -32601)
	}
})
