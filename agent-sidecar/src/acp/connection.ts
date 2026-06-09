/**
 * ACP 传输层双工连接（duplex JSON-RPC peer）。
 *
 * sidecar 作为 ACP Agent，需在同一条 stdio 连接上同时承担四件事：
 * - 处理 client→agent 入站请求（initialize / session.* 等）并按同 id 回送 Response；
 * - 处理 client→agent 入站通知（session/cancel 等），不回送；
 * - 发起 agent→client 出站请求（session/request_permission、fs/*、terminal/*）并按 id 等响应；
 * - 发出 agent→client 出站通知（session/update）。
 *
 * 忠实镜像 agentclientprotocol/agent-client-protocol v1：
 * - 线缆信封见 `src/rpc.rs`（JsonRpcMessage flatten {jsonrpc:"2.0"}；Request{id,method,params?}/
 *   untagged Response {id,result}|{id,error} / Notification{method,params?}）。按「是否含
 *   method、是否含 id」三向判别，正是 rpc.rs untagged 的结构化区分。
 * - 换行分隔成帧见 Zed `crates/agent_servers/src/acp.rs`（逐行读 stdout、每帧补 '\n'）。
 *
 * 职责单一：本类只做「消息级」派发与关联，不含字节/换行成帧与 stdio IO
 *（由 stdio 入口装配，与 request-client.ts「sink 注入、无 IO」的既有约定一致）。
 * 出站请求的 id 分配与响应关联复用 {@link AcpRequestClient}，不重复实现。
 */
import {
	ACP_ERROR_CODES,
	acpError,
	jsonRpcError,
	jsonRpcNotification,
	jsonRpcNotificationSchema,
	jsonRpcRequestSchema,
	jsonRpcResponseSchema,
	jsonRpcSuccess,
	type TJsonRpcError,
	type TJsonRpcErrorResponse,
	type TJsonRpcNotification,
	type TJsonRpcRequest,
	type TJsonRpcSuccessResponse,
	type TRequestId,
} from "./jsonrpc"
import { AcpRequestClient, AcpRpcError } from "./request-client"

/** 出站消息：本连接可能写出的全部 JSON-RPC 信封。 */
export type TAcpOutgoingMessage =
	| TJsonRpcRequest
	| TJsonRpcNotification
	| TJsonRpcSuccessResponse
	| TJsonRpcErrorResponse

/** 出站消息写出口：把成帧前的消息交给传输层（stdio 入口负责换行成帧与写盘）。 */
export type TAcpMessageSink = (message: TAcpOutgoingMessage) => void

/** 入站请求处理器：返回值即响应 result（undefined 归一为 null）。 */
export type TAcpRequestHandler = (params: unknown) => unknown | Promise<unknown>

/** 入站通知处理器：无返回，不回送响应。 */
export type TAcpNotificationHandler = (params: unknown) => void | Promise<void>

/** 连接内非致命异常的上报点（缺处理器、孤儿响应、处理器抛错等）。 */
export type TAcpConnectionErrorContext = {
	phase: "request" | "notification" | "response" | "receive"
	method?: string
	id?: TRequestId
}

export type TAcpConnectionOptions = {
	send: TAcpMessageSink
	requestHandlers: Map<string, TAcpRequestHandler>
	notificationHandlers?: Map<string, TAcpNotificationHandler>
	onError?: (error: unknown, context: TAcpConnectionErrorContext) => void
}

/**
 * ACP 双工连接：入站派发 + 出站请求/通知，全部经单一写出口。
 */
export class AcpConnection {
	readonly #send: TAcpMessageSink
	readonly #requestHandlers: Map<string, TAcpRequestHandler>
	readonly #notificationHandlers: Map<string, TAcpNotificationHandler>
	readonly #onError?: (
		error: unknown,
		context: TAcpConnectionErrorContext,
	) => void
	readonly #requestClient: AcpRequestClient

	constructor(options: TAcpConnectionOptions) {
		this.#send = options.send
		this.#requestHandlers = options.requestHandlers
		this.#notificationHandlers = options.notificationHandlers ?? new Map()
		this.#onError = options.onError
		// 出站请求经同一写出口成单一 egress；id 分配与响应关联交由 AcpRequestClient。
		this.#requestClient = new AcpRequestClient((request) => this.#send(request))
	}

	/** 仍在等待响应的出站请求数量。 */
	get pendingRequestCount(): number {
		return this.#requestClient.pendingCount
	}

	/**
	 * 发起 agent→client 出站请求（session/request_permission、fs/*、terminal/* 等），
	 * 返回在收到对应 id 响应时结算的 Promise；错误响应以 AcpRpcError reject。
	 */
	sendRequest(method: string, params?: unknown): Promise<unknown> {
		return this.#requestClient.sendRequest(method, params)
	}

	/** 发出 agent→client 出站通知（session/update 等），不等待响应。 */
	sendNotification(method: string, params?: unknown): void {
		this.#send(jsonRpcNotification(method, params))
	}

	/**
	 * 处理一条已解析为 JSON 的入站消息，按 rpc.rs 的结构三向判别：
	 * - 无 method（含 id 与 result/error）→ 响应：交出站关联器按 id 结算；
	 * - 含 method 且含 id → 请求：路由处理器并回送 Response；
	 * - 含 method 且无 id → 通知：路由通知处理器，不回送。
	 */
	async receive(message: unknown): Promise<void> {
		if (typeof message !== "object" || message === null) {
			this.#onError?.(new Error("入站信封不是 JSON 对象"), { phase: "receive" })
			return
		}

		const record = message as Record<string, unknown>
		const hasMethod = typeof record.method === "string"

		if (!hasMethod) {
			this.#handleResponse(message)
			return
		}

		if ("id" in record) {
			await this.#handleRequest(message)
			return
		}

		await this.#handleNotification(message)
	}

	/** 连接关闭：拒绝并清空所有在途出站请求，杜绝悬挂 Promise 泄漏。 */
	close(reason: unknown): void {
		this.#requestClient.rejectAll(reason)
	}

	#handleResponse(message: unknown): void {
		const parsed = jsonRpcResponseSchema.safeParse(message)
		if (!parsed.success) {
			this.#onError?.(new Error("无法解析的 JSON-RPC 响应信封"), {
				phase: "response",
			})
			return
		}
		const settled = this.#requestClient.handleResponse(parsed.data)
		if (!settled) {
			this.#onError?.(new Error("响应未匹配到在途请求"), {
				phase: "response",
				id: parsed.data.id,
			})
		}
	}

	async #handleRequest(message: unknown): Promise<void> {
		const parsed = jsonRpcRequestSchema.safeParse(message)
		if (!parsed.success) {
			this.#onError?.(new Error("无法解析的 JSON-RPC 请求信封"), {
				phase: "request",
			})
			return
		}
		const request = parsed.data
		const handler = this.#requestHandlers.get(request.method)
		if (!handler) {
			this.#send(
				jsonRpcError(
					request.id,
					acpError(
						ACP_ERROR_CODES.methodNotFound,
						`未实现的方法：${request.method}`,
					),
				),
			)
			return
		}
		try {
			const result = await handler(request.params)
			this.#send(jsonRpcSuccess(request.id, result === undefined ? null : result))
		} catch (error) {
			this.#send(jsonRpcError(request.id, this.#toRpcError(error)))
			this.#onError?.(error, {
				phase: "request",
				method: request.method,
				id: request.id,
			})
		}
	}

	async #handleNotification(message: unknown): Promise<void> {
		const parsed = jsonRpcNotificationSchema.safeParse(message)
		if (!parsed.success) {
			this.#onError?.(new Error("无法解析的 JSON-RPC 通知信封"), {
				phase: "notification",
			})
			return
		}
		const notification = parsed.data
		const handler = this.#notificationHandlers.get(notification.method)
		if (!handler) {
			this.#onError?.(new Error(`未处理的通知：${notification.method}`), {
				phase: "notification",
				method: notification.method,
			})
			return
		}
		try {
			await handler(notification.params)
		} catch (error) {
			this.#onError?.(error, {
				phase: "notification",
				method: notification.method,
			})
		}
	}

	#toRpcError(error: unknown): TJsonRpcError {
		if (error instanceof AcpRpcError) {
			return acpError(error.code, error.message, error.data)
		}
		const message = error instanceof Error ? error.message : String(error)
		return acpError(ACP_ERROR_CODES.internalError, message)
	}
}
