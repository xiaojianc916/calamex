/**
 * ACP agent 侧出站请求关联器。
 *
 * sidecar 作为 ACP Agent，除了发 session/update 通知，还会反向向 client 发起
 * 需要应答的请求（如 session/request_permission、fs/*、terminal/*）。JSON-RPC 靠
 * 请求 id 关联响应：发出 { id, method, params } 后，须等到带同一 id 的 Response
 * 才能拿到结果。本模块封装这条「发请求 → 按 id 等响应」的最小关联逻辑。
 *
 * 语义取自 JSON-RPC 2.0 与 ACP src/rpc.rs 的线上约定：
 * - 单调自增数字 id（RequestId 允许 string|number|null，此处选数字最简且无歧义）；
 * - pending 表按 id 暂存 resolve/reject，收到 Response 时按 id 结算；
 * - 错误响应以 AcpRpcError（携带 code/data）reject；未知/重复 id 视为未命中。
 *
 * 纯关联逻辑：实际写出经注入的 sink，不含任何 IO / 路由 / 超时（超时由上层编排负责）。
 */
import {
	isJsonRpcErrorResponse,
	jsonRpcRequest,
	type TJsonRpcError,
	type TJsonRpcRequest,
	type TJsonRpcResponse,
} from "./jsonrpc"

/** JSON-RPC 错误响应映射成的可抛出错误，保留 code/data 以便上层分支处理。 */
export class AcpRpcError extends Error {
	readonly code: number
	readonly data?: unknown

	constructor(error: TJsonRpcError) {
		super(error.message)
		this.name = "AcpRpcError"
		this.code = error.code
		this.data = error.data
	}
}

/** 出站请求写出口：把成帧后的请求交给传输层（Rust 转发 / stdio / socket）。 */
export type TAcpRequestSink = (request: TJsonRpcRequest) => void

type PendingEntry = {
	resolve: (result: unknown) => void
	reject: (reason: unknown) => void
}

/**
 * agent → client 出站请求的 id 分配 + 响应关联器。
 */
export class AcpRequestClient {
	readonly #send: TAcpRequestSink
	readonly #pending = new Map<number, PendingEntry>()
	#nextId: number

	constructor(send: TAcpRequestSink, startId = 1) {
		this.#send = send
		this.#nextId = startId
	}

	/** 当前仍在等待响应的请求数量。 */
	get pendingCount(): number {
		return this.#pending.size
	}

	/**
	 * 发起一条需要应答的请求：分配 id、写出、返回在收到对应响应时结算的 Promise。
	 * 成功响应 resolve 其 result；错误响应以 {@link AcpRpcError} reject。
	 */
	sendRequest(method: string, params?: unknown): Promise<unknown> {
		const id = this.#nextId++
		return new Promise<unknown>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject })
			this.#send(jsonRpcRequest(id, method, params))
		})
	}

	/**
	 * 用收到的响应结算对应 id 的等待者。
	 * 命中并结算返回 true；id 非数字 / 未知 / 已结算返回 false（交由上层另作路由）。
	 */
	handleResponse(response: TJsonRpcResponse): boolean {
		const { id } = response
		if (typeof id !== "number") return false
		const entry = this.#pending.get(id)
		if (!entry) return false
		this.#pending.delete(id)
		if (isJsonRpcErrorResponse(response)) {
			entry.reject(new AcpRpcError(response.error))
		} else {
			entry.resolve(response.result)
		}
		return true
	}

	/**
	 * 拒绝并清空所有在途请求（用于连接关闭 / 会话结束的无泄漏收尾）。
	 */
	rejectAll(reason: unknown): void {
		for (const entry of this.#pending.values()) entry.reject(reason)
		this.#pending.clear()
	}
}
