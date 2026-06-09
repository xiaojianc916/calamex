/**
 * ACP initialize 握手契约 —— initialize 方法的请求/响应，及其引用的能力/实现/鉴权类型。
 *
 * 忠实镜像 agentclientprotocol/agent-client-protocol v1 的稳定 JSON Schema（schema/v1/schema.json）
 * 与 src/v1/agent.rs 的稳定结构体：
 * - ClientCapabilities  { fs: FileSystemCapabilities, terminal }（客户端 → Agent 公布）
 * - AgentCapabilities   { auth, loadSession, mcpCapabilities, promptCapabilities, sessionCapabilities }（Agent → 客户端公布）
 * - Implementation      { name, title?, version }（clientInfo / agentInfo 复用同一形状）
 * - AuthMethod          稳定面仅 untagged 的 AuthMethodAgent { id, name, description? }（无 type 判别字段）
 * - InitializeRequest   { protocolVersion(必填), clientCapabilities, clientInfo? }
 * - InitializeResponse  { protocolVersion(必填), agentCapabilities, authMethods, agentInfo? }
 *
 * 约定同 ./protocol：字段 camelCase、对象一律 .passthrough()（透传含 _meta 的未知字段）。
 * 上游所有能力字段均为 #[serde(default)]，故在线全部可选（缺省即“不支持 / false”）。
 * 方法名常量见 ./jsonrpc 的 ACP_AGENT_METHODS，不在此重复定义。
 */
import { z } from "zod"

import { ACP_PROTOCOL_VERSION } from "./protocol.js"

// ---------------------------------------------------------------------------
// ProtocolVersion —— 协议版本（整数 newtype；当前稳定版见 ./protocol 的 ACP_PROTOCOL_VERSION）
// ---------------------------------------------------------------------------

export const protocolVersionSchema = z.number().int()
export type TProtocolVersion = z.infer<typeof protocolVersionSchema>

// ---------------------------------------------------------------------------
// 客户端能力（ClientCapabilities）—— 客户端在 initialize 中向 Agent 公布
// ---------------------------------------------------------------------------

/** FileSystemCapabilities：客户端支持的文件系统操作，决定 Agent 能否请求 fs/*。 */
export const fileSystemCapabilitiesSchema = z
	.object({
		readTextFile: z.boolean().optional(),
		writeTextFile: z.boolean().optional(),
	})
	.passthrough()
export type TFileSystemCapabilities = z.infer<typeof fileSystemCapabilitiesSchema>

/** ClientCapabilities：客户端公布的能力集合。 */
export const clientCapabilitiesSchema = z
	.object({
		fs: fileSystemCapabilitiesSchema.optional(),
		terminal: z.boolean().optional(),
	})
	.passthrough()
export type TClientCapabilities = z.infer<typeof clientCapabilitiesSchema>

// ---------------------------------------------------------------------------
// Agent 能力（AgentCapabilities）—— Agent 在 initialize 响应中向客户端公布
// ---------------------------------------------------------------------------

/** PromptCapabilities：Agent 在 session/prompt 中可接收的内容类型。 */
export const promptCapabilitiesSchema = z
	.object({
		image: z.boolean().optional(),
		audio: z.boolean().optional(),
		embeddedContext: z.boolean().optional(),
	})
	.passthrough()
export type TPromptCapabilities = z.infer<typeof promptCapabilitiesSchema>

/** McpCapabilities：Agent 支持的 MCP 传输类型。 */
export const mcpCapabilitiesSchema = z
	.object({
		http: z.boolean().optional(),
		sse: z.boolean().optional(),
	})
	.passthrough()
export type TMcpCapabilities = z.infer<typeof mcpCapabilitiesSchema>

/** AgentAuthCapabilities：Agent 鉴权相关能力（logout 以空对象 {} 标记“支持”）。 */
export const agentAuthCapabilitiesSchema = z
	.object({
		logout: z.object({}).passthrough().nullish(),
	})
	.passthrough()
export type TAgentAuthCapabilities = z.infer<typeof agentAuthCapabilitiesSchema>

/** SessionCapabilities：Agent 会话级能力（如 session/list）。 */
export const sessionCapabilitiesSchema = z
	.object({
		list: z.boolean().optional(),
	})
	.passthrough()
export type TSessionCapabilities = z.infer<typeof sessionCapabilitiesSchema>

/** AgentCapabilities：Agent 公布的能力集合。 */
export const agentCapabilitiesSchema = z
	.object({
		auth: agentAuthCapabilitiesSchema.optional(),
		loadSession: z.boolean().optional(),
		mcpCapabilities: mcpCapabilitiesSchema.optional(),
		promptCapabilities: promptCapabilitiesSchema.optional(),
		sessionCapabilities: sessionCapabilitiesSchema.optional(),
	})
	.passthrough()
export type TAgentCapabilities = z.infer<typeof agentCapabilitiesSchema>

// ---------------------------------------------------------------------------
// Implementation —— 客户端/Agent 的名称与版本（clientInfo / agentInfo）
// ---------------------------------------------------------------------------

/** Implementation：实现方的名称、可选展示标题与版本。 */
export const implementationSchema = z
	.object({
		name: z.string(),
		title: z.string().nullish(),
		version: z.string(),
	})
	.passthrough()
export type TImplementation = z.infer<typeof implementationSchema>

// ---------------------------------------------------------------------------
// AuthMethod —— 稳定面仅 untagged 的 AuthMethodAgent（Agent 自行处理鉴权）
// ---------------------------------------------------------------------------

/** AuthMethod（稳定面）：Agent 自行处理鉴权，序列化无 type 判别字段。 */
export const authMethodSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		description: z.string().nullish(),
	})
	.passthrough()
export type TAuthMethod = z.infer<typeof authMethodSchema>

// ---------------------------------------------------------------------------
// initialize —— 请求与响应
// ---------------------------------------------------------------------------

/** InitializeRequest：客户端发起协议初始化握手（protocolVersion 必填）。 */
export const initializeRequestSchema = z
	.object({
		protocolVersion: protocolVersionSchema,
		clientCapabilities: clientCapabilitiesSchema.optional(),
		clientInfo: implementationSchema.nullish(),
	})
	.passthrough()
export type TInitializeRequest = z.infer<typeof initializeRequestSchema>

/** InitializeResponse：Agent 回应协商后的协议版本与自身能力（protocolVersion 必填）。 */
export const initializeResponseSchema = z
	.object({
		protocolVersion: protocolVersionSchema,
		agentCapabilities: agentCapabilitiesSchema.optional(),
		authMethods: z.array(authMethodSchema).optional(),
		agentInfo: implementationSchema.nullish(),
	})
	.passthrough()
export type TInitializeResponse = z.infer<typeof initializeResponseSchema>

/**
 * 构造 InitializeResponse，镜像上游 `InitializeResponse::new(protocol_version)` 及其 builder：
 * 默认协商当前稳定协议版本、空能力（不公布任何可选能力）、无鉴权方法。
 */
export const initializeResponse = (
	protocolVersion: TProtocolVersion = ACP_PROTOCOL_VERSION,
	agentCapabilities: TAgentCapabilities = {},
	authMethods: Array<TAuthMethod> = [],
): TInitializeResponse => ({ protocolVersion, agentCapabilities, authMethods })
