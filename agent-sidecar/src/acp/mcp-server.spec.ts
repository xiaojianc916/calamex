import { test } from "node:test"
import assert from "node:assert/strict"

import {
	envVariableSchema,
	httpHeaderSchema,
	mcpServerStdioSchema,
	mcpServerHttpSchema,
	mcpServerSseSchema,
	mcpServerSchema,
} from "./mcp-server.js"

test("envVariable 需要 name 与 value 且透传 _meta", () => {
	assert.deepEqual(
		envVariableSchema.parse({ name: "API_KEY", value: "secret", _meta: { a: 1 } }),
		{ name: "API_KEY", value: "secret", _meta: { a: 1 } },
	)
	assert.throws(() => envVariableSchema.parse({ name: "API_KEY" }))
})

test("httpHeader 需要 name 与 value", () => {
	assert.deepEqual(httpHeaderSchema.parse({ name: "Authorization", value: "Bearer x" }), {
		name: "Authorization",
		value: "Bearer x",
	})
	assert.throws(() => httpHeaderSchema.parse({ value: "Bearer x" }))
})

test("stdio 传输解析 name/command/args/env，缺 command 报错", () => {
	const stdio = mcpServerStdioSchema.parse({
		name: "fs",
		command: "/usr/bin/mcp-fs",
		args: ["--root", "/tmp"],
		env: [{ name: "DEBUG", value: "1" }],
	})
	assert.equal(stdio.command, "/usr/bin/mcp-fs")
	assert.equal(stdio.env[0].name, "DEBUG")
	assert.throws(() => mcpServerStdioSchema.parse({ name: "fs", args: [], env: [] }))
})

test("http 传输需要 type 字面量 http 与 url/headers", () => {
	const http = mcpServerHttpSchema.parse({
		type: "http",
		name: "remote",
		url: "https://mcp.example.com",
		headers: [{ name: "Authorization", value: "Bearer x" }],
	})
	assert.equal(http.type, "http")
	assert.equal(http.url, "https://mcp.example.com")
	assert.throws(() =>
		mcpServerHttpSchema.parse({ type: "sse", name: "x", url: "u", headers: [] }),
	)
})

test("sse 传输需要 type 字面量 sse", () => {
	const sse = mcpServerSseSchema.parse({
		type: "sse",
		name: "events",
		url: "https://mcp.example.com/sse",
		headers: [],
	})
	assert.equal(sse.type, "sse")
})

test("McpServer 并集按结构判别三种传输", () => {
	const stdio = mcpServerSchema.parse({ name: "fs", command: "c", args: [], env: [] })
	assert.ok(!("type" in stdio))
	const http = mcpServerSchema.parse({ type: "http", name: "r", url: "u", headers: [] })
	assert.ok("type" in http && http.type === "http")
	const sse = mcpServerSchema.parse({ type: "sse", name: "e", url: "u", headers: [] })
	assert.ok("type" in sse && sse.type === "sse")
})

test("McpServer 拒绝既非 stdio 也非 http/sse 的对象", () => {
	assert.throws(() => mcpServerSchema.parse({ name: "incomplete" }))
})

test("stdio 透传 _meta 等未知字段", () => {
	const parsed = mcpServerStdioSchema.parse({
		name: "fs",
		command: "c",
		args: [],
		env: [],
		_meta: { trace: "t" },
	}) as Record<string, unknown>
	assert.deepEqual(parsed._meta, { trace: "t" })
})
