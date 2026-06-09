import assert from "node:assert/strict"
import { test } from "node:test"

import { ACP_PROTOCOL_VERSION } from "./protocol.js"
import {
	agentCapabilitiesSchema,
	authMethodSchema,
	clientCapabilitiesSchema,
	implementationSchema,
	initializeRequestSchema,
	initializeResponse,
	initializeResponseSchema,
	protocolVersionSchema,
} from "./initialize.js"

test("ProtocolVersion 必须是整数；拒绝小数与字符串", () => {
	assert.equal(protocolVersionSchema.parse(1), 1)
	assert.equal(protocolVersionSchema.safeParse(1.5).success, false)
	assert.equal(protocolVersionSchema.safeParse("1").success, false)
})

test("ClientCapabilities：fs + terminal，passthrough 透传 _meta；空对象合法", () => {
	const parsed = clientCapabilitiesSchema.parse({
		fs: { readTextFile: true, writeTextFile: false },
		terminal: true,
		_meta: { x: 1 },
	})
	assert.equal(parsed.fs?.readTextFile, true)
	assert.equal(parsed.terminal, true)
	assert.deepEqual((parsed as Record<string, unknown>)._meta, { x: 1 })
	assert.equal(clientCapabilitiesSchema.safeParse({}).success, true)
})

test("AgentCapabilities：auth/loadSession/mcp/prompt/session 五字段全部可选", () => {
	const parsed = agentCapabilitiesSchema.parse({
		auth: { logout: {} },
		loadSession: true,
		mcpCapabilities: { http: true, sse: false },
		promptCapabilities: { image: true, audio: false, embeddedContext: true },
		sessionCapabilities: { list: true },
	})
	assert.equal(parsed.loadSession, true)
	assert.equal(parsed.mcpCapabilities?.http, true)
	assert.equal(parsed.promptCapabilities?.embeddedContext, true)
	assert.equal(parsed.sessionCapabilities?.list, true)
	assert.equal(agentCapabilitiesSchema.safeParse({}).success, true)
})

test("Implementation：name + version 必填，title 可选", () => {
	assert.equal(
		implementationSchema.parse({ name: "calamex", version: "1.0.0" }).name,
		"calamex",
	)
	assert.equal(implementationSchema.safeParse({ name: "x" }).success, false)
	assert.equal(implementationSchema.safeParse({ version: "1" }).success, false)
})

test("AuthMethod：id + name 必填（untagged 无 type），description/_meta 透传", () => {
	const parsed = authMethodSchema.parse({
		id: "agent-default",
		name: "Agent",
		_meta: { k: "v" },
	})
	assert.equal(parsed.id, "agent-default")
	assert.deepEqual((parsed as Record<string, unknown>)._meta, { k: "v" })
	assert.equal(authMethodSchema.safeParse({ name: "x" }).success, false)
})

test("InitializeRequest：protocolVersion 必填；解析 clientCapabilities/clientInfo", () => {
	const parsed = initializeRequestSchema.parse({
		protocolVersion: ACP_PROTOCOL_VERSION,
		clientCapabilities: { terminal: true },
		clientInfo: { name: "zed", version: "0.1.0" },
	})
	assert.equal(parsed.protocolVersion, ACP_PROTOCOL_VERSION)
	assert.equal(parsed.clientCapabilities?.terminal, true)
	assert.equal(parsed.clientInfo?.name, "zed")
	assert.equal(initializeRequestSchema.safeParse({}).success, false)
})

test("initializeResponse 构造器镜像 InitializeResponse::new，并通过 schema", () => {
	const res = initializeResponse()
	assert.deepEqual(res, {
		protocolVersion: ACP_PROTOCOL_VERSION,
		agentCapabilities: {},
		authMethods: [],
	})
	assert.equal(initializeResponseSchema.safeParse(res).success, true)
})

test("initializeResponse 接受能力与鉴权方法覆盖", () => {
	const res = initializeResponse(
		ACP_PROTOCOL_VERSION,
		{ promptCapabilities: { image: true } },
		[{ id: "a", name: "Agent" }],
	)
	assert.equal(res.agentCapabilities?.promptCapabilities?.image, true)
	assert.equal(res.authMethods?.length, 1)
	assert.equal(initializeResponseSchema.safeParse(res).success, true)
})
