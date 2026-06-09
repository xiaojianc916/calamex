/**
 * ACP MCP 服务器配置契约 —— session/new 与 session/load 中由客户端声明、交给 Agent 连接的 MCP 服务器。
 *
 * 忠实镜像 agentclientprotocol/agent-client-protocol v1 的稳定 JSON Schema（schema/v1/schema.json）
 * 与 src/v1/agent.rs 的稳定结构体：
 * - EnvVariable     { name, value }（启动 stdio 服务器时设置的环境变量）
 * - HttpHeader      { name, value }（向 http/sse 服务器发起请求时设置的 HTTP 头）
 * - McpServerStdio  { name, command, args, env }（所有 Agent 必须支持的默认传输；序列化无 type 判别字段）
 * - McpServerHttp   { type:"http", name, url, headers }（需 Agent 公布 mcpCapabilities.http）
 * - McpServerSse    { type:"sse",  name, url, headers }（需 Agent 公布 mcpCapabilities.sse）
 * - McpServer       三传输变体的并集（anyOf）：stdio 无 type，http/sse 以 type 字段判别
 *
 * 约定同 ./protocol：字段 camelCase、对象一律 .passthrough()（透传含 _meta 的未知字段）。
 * McpServer 为客户端 → Agent 的入参（由 Agent 解析），故只建模 schema，不提供构造器。
 */
import { z } from "zod"

// ---------------------------------------------------------------------------
// 叶子类型 —— 环境变量与 HTTP 头
// ---------------------------------------------------------------------------

/** EnvVariable：启动 MCP 服务器时设置的环境变量。 */
export const envVariableSchema = z
	.object({
		name: z.string(),
		value: z.string(),
	})
	.passthrough()
export type TEnvVariable = z.infer<typeof envVariableSchema>

/** HttpHeader：向 http/sse MCP 服务器发起请求时设置的 HTTP 头。 */
export const httpHeaderSchema = z
	.object({
		name: z.string(),
		value: z.string(),
	})
	.passthrough()
export type THttpHeader = z.infer<typeof httpHeaderSchema>

// ---------------------------------------------------------------------------
// 三种传输配置
// ---------------------------------------------------------------------------

/** McpServerStdio：stdio 传输配置（所有 Agent 必须支持；序列化无 type 字段）。 */
export const mcpServerStdioSchema = z
	.object({
		name: z.string(),
		command: z.string(),
		args: z.array(z.string()),
		env: z.array(envVariableSchema),
	})
	.passthrough()
export type TMcpServerStdio = z.infer<typeof mcpServerStdioSchema>

/** McpServerHttp：HTTP 传输配置（需 Agent 公布 mcpCapabilities.http）。 */
export const mcpServerHttpSchema = z
	.object({
		type: z.literal("http"),
		name: z.string(),
		url: z.string(),
		headers: z.array(httpHeaderSchema),
	})
	.passthrough()
export type TMcpServerHttp = z.infer<typeof mcpServerHttpSchema>

/** McpServerSse：SSE 传输配置（需 Agent 公布 mcpCapabilities.sse）。 */
export const mcpServerSseSchema = z
	.object({
		type: z.literal("sse"),
		name: z.string(),
		url: z.string(),
		headers: z.array(httpHeaderSchema),
	})
	.passthrough()
export type TMcpServerSse = z.infer<typeof mcpServerSseSchema>

// ---------------------------------------------------------------------------
// McpServer —— 三传输变体的并集
// ---------------------------------------------------------------------------

/**
 * McpServer：连接 MCP 服务器的配置。
 *
 * 对应 schema 的 anyOf：http/sse 携带 type 字面量判别字段，stdio 为无 type 的默认变体。
 * 三者必填字段互斥（stdio 需 command/args/env；http/sse 需 url/headers 且 type 固定），
 * 故并集解析无歧义，与变体顺序无关。
 */
export const mcpServerSchema = z.union([
	mcpServerHttpSchema,
	mcpServerSseSchema,
	mcpServerStdioSchema,
])
export type TMcpServer = z.infer<typeof mcpServerSchema>
