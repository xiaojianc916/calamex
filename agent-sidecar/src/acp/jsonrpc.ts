/**
 * ACP 传输层 JSON-RPC 2.0 信封与方法名/错误码注册表。
 *
 * 忠实镜像 agentclientprotocol/agent-client-protocol v1：
 * - 消息形状见 `src/rpc.rs`：Request{id,method,params?} / Response={id,result}|{id,error} /
 *   Notification{method,params?}，统一裹上 `{ "jsonrpc": "2.0", ... }`（jsonrpc 为同级字段）。
 * - 稳定方法名见 `schema/v1/meta.json`。
 * - 错误对象与错误码见 `src/v1/error.rs`。
 *
 * 只收录 v1 稳定面，不含 feature-gated 的 unstable 能力：
 * - 取消用稳定的 session/cancel 通知，并由 session/prompt 以 stopReason="cancelled" 收尾，
 *   而非 unstable 的 $/cancel_request + RequestCancelled(-32800)。
 * - 不含 elicitation（UrlElicitationRequired=-32042）。
 *
 * 本模块只定义「传输信封 + 方法名 + 错误码」，不含任何路由 / 派发 / IO 逻辑。
 */
import { z } from "zod"

/** JSON-RPC 协议版本号，线上恒为 "2.0"（见 rpc.rs JsonRpcMessage）。 */
export const JSON_RPC_VERSION = "2.0" as const

// ---------------------------------------------------------------------------
// 方法名注册表（1:1 镜像 schema/v1/meta.json，仅稳定面）
// ---------------------------------------------------------------------------

/** Agent 侧方法：由 client（前端）发起、本 sidecar 作为 Agent 处理。 */
export const ACP_AGENT_METHODS = {
	initialize: "initialize",
	authenticate: "authenticate",
	logout: "logout",
	sessionNew: "session/new",
	sessionLoad: "session/load",
	sessionResume: "session/resume",
	sessionPrompt: "session/prompt",
	sessionCancel: "session/cancel",
	sessionClose: "session/close",
	sessionDelete: "session/delete",
	sessionList: "session/list",
	sessionSetConfigOption: "session/set_config_option",
	sessionSetMode: "session/set_mode",
} as const
export type TAcpAgentMethod =
	(typeof ACP_AGENT_METHODS)[keyof typeof ACP_AGENT_METHODS]

/** Client 侧方法：由 Agent（本 sidecar）反向发起、client（前端）处理。 */
export const ACP_CLIENT_METHODS = {
	sessionUpdate: "session/update",
	sessionRequestPermission: "session/request_permission",
	fsReadTextFile: "fs/read_text_file",
	fsWriteTextFile: "fs/write_text_file",
	terminalCreate: "terminal/create",
	terminalOutput: "terminal/output",
	terminalWaitForExit: "terminal/wait_for_exit",
	terminalKill: "terminal/kill",
	terminalRelease: "terminal/release",
} as const
export type TAcpClientMethod =
	(typeof ACP_CLIENT_METHODS)[keyof typeof ACP_CLIENT_METHODS]

// ---------------------------------------------------------------------------
// 错误码与错误对象（1:1 镜像 src/v1/error.rs，仅稳定面）
// ---------------------------------------------------------------------------

/** JSON-RPC / ACP 稳定错误码；其余整数按 ErrorCode::Other 原样透传。 */
export const ACP_ERROR_CODES = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
	authRequired: -32000,
	resourceNotFound: -32002,
} as const
export type TAcpErrorCode =
	(typeof ACP_ERROR_CODES)[keyof typeof ACP_ERROR_CODES]

/** JSON-RPC 错误对象：{ code, message, data? }（error.rs Error）。 */
export const jsonRpcErrorSchema = z
	.object({
		code: z.number().int(),
		message: z.string(),
		data: z.unknown().optional(),
	})
	.passthrough()
export type TJsonRpcError = z.infer<typeof jsonRpcErrorSchema>

// ---------------------------------------------------------------------------
// 消息信封（1:1 镜像 src/rpc.rs）
// ---------------------------------------------------------------------------

/** 请求 id：string | number | null（rpc.rs RequestId，untagged）。 */
export const requestIdSchema = z.union([z.string(), z.number().int(), z.null()])
export type TRequestId = z.infer<typeof requestIdSchema>

/** 请求：带 id，期待一个对应 id 的响应。 */
export const jsonRpcRequestSchema = z
	.object({
		jsonrpc: z.literal(JSON_RPC_VERSION),
		id: requestIdSchema,
		method: z.string(),
		params: z.unknown().optional(),
	})
	.passthrough()
export type TJsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>

/** 成功响应：{ id, result }。 */
export const jsonRpcSuccessResponseSchema = z
	.object({
		jsonrpc: z.literal(JSON_RPC_VERSION),
		id: requestIdSchema,
		result: z.unknown(),
	})
	.passthrough()
export type TJsonRpcSuccessResponse = z.infer<
	typeof jsonRpcSuccessResponseSchema
>

/** 错误响应：{ id, error }。 */
export const jsonRpcErrorResponseSchema = z
	.object({
		jsonrpc: z.literal(JSON_RPC_VERSION),
		id: requestIdSchema,
		error: jsonRpcErrorSchema,
	})
	.passthrough()
export type TJsonRpcErrorResponse = z.infer<typeof jsonRpcErrorResponseSchema>

/**
 * 响应：成功或错误（rpc.rs Response，untagged，靠是否含 error 字段区分）。
 * 错误分支置于联合首位：含 error 字段者优先命中，否则回落到成功分支。
 */
export const jsonRpcResponseSchema = z.union([
	jsonRpcErrorResponseSchema,
	jsonRpcSuccessResponseSchema,
])
export type TJsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>

/** 通知：无 id，不期待响应。 */
export const jsonRpcNotificationSchema = z
	.object({
		jsonrpc: z.literal(JSON_RPC_VERSION),
		method: z.string(),
		params: z.unknown().optional(),
	})
	.passthrough()
export type TJsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>

// ---------------------------------------------------------------------------
// 构造器与判别（薄封装，保证 jsonrpc 字段恒被写入）
// ---------------------------------------------------------------------------

export const jsonRpcRequest = (
	id: TRequestId,
	method: string,
	params?: unknown,
): TJsonRpcRequest => ({
	jsonrpc: JSON_RPC_VERSION,
	id,
	method,
	...(params === undefined ? {} : { params }),
})

export const jsonRpcNotification = (
	method: string,
	params?: unknown,
): TJsonRpcNotification => ({
	jsonrpc: JSON_RPC_VERSION,
	method,
	...(params === undefined ? {} : { params }),
})

export const jsonRpcSuccess = (
	id: TRequestId,
	result: unknown,
): TJsonRpcSuccessResponse => ({ jsonrpc: JSON_RPC_VERSION, id, result })

export const jsonRpcError = (
	id: TRequestId,
	error: TJsonRpcError,
): TJsonRpcErrorResponse => ({ jsonrpc: JSON_RPC_VERSION, id, error })

/** 构造错误对象：{ code, message, data? }。 */
export const acpError = (
	code: number,
	message: string,
	data?: unknown,
): TJsonRpcError => ({
	code,
	message,
	...(data === undefined ? {} : { data }),
})

/** 响应是否为错误响应（rpc.rs Response 靠 error 字段区分）。 */
export const isJsonRpcErrorResponse = (
	response: TJsonRpcResponse,
): response is TJsonRpcErrorResponse => "error" in response
