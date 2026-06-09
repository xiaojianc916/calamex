/**
 * ACP 会话登记表 —— Agent 侧按 sessionId 持有的会话状态与当前回合的取消句柄。
 *
 * 纯状态容器，不耦合 JSON-RPC / 传输：
 * - session/new      → create()：登记 cwd(→workspaceRootPath)、客户端声明的 mcpServers、初始模式。
 * - session/set_mode → setMode()：切换已登记会话的运行模式。
 * - session/prompt   → get() 读状态构造运行时输入；beginTurn()/endTurn() 管理回合 AbortController。
 * - session/cancel   → cancel()：中止该会话当前回合（映射运行时 options.context.signal）。
 *
 * 模式标识与 runtime 的 TAgentMode 同构（ACP SessionModeId 即 AGENT_MODES 之一），故直接存
 * TAgentMode；非法 modeId 的校验、以及找不到会话的 RPC 错误映射，都留给 dispatcher——
 * 本表只返回 undefined / 布尔，保持纯净、可单测、与传输无关。
 */
import { randomUUID } from "node:crypto"

import type {
	IAgentRuntimeModelConfigInput,
	TAgentMode,
} from "../engines/contracts/runtime-input.js"
import type { TMcpServer } from "./mcp-server.js"

/**
 * 单个会话的可变状态。
 * workspaceRootPath / mcpServers 建立后不变；mode / modelConfig 可更新；
 * abortController 随回合起止（无活跃回合时为 null）。
 */
export interface IAcpSessionState {
	readonly sessionId: string
	readonly workspaceRootPath: string
	readonly mcpServers: readonly TMcpServer[]
	mode: TAgentMode
	modelConfig?: IAgentRuntimeModelConfigInput
	abortController: AbortController | null
}

/** create() 入参：来自 session/new 的 cwd、客户端声明的 mcpServers、初始模式与可选模型配置。 */
export interface IAcpSessionCreateParams {
	workspaceRootPath: string
	mcpServers: readonly TMcpServer[]
	mode: TAgentMode
	modelConfig?: IAgentRuntimeModelConfigInput
}

/** 注入项：仅 sessionId 生成器，便于测试确定化。默认 randomUUID。 */
export interface IAcpSessionRegistryOptions {
	generateSessionId?: () => string
}

export class AcpSessionRegistry {
	private readonly sessions = new Map<string, IAcpSessionState>()
	private readonly generateSessionId: () => string

	constructor(options: IAcpSessionRegistryOptions = {}) {
		this.generateSessionId = options.generateSessionId ?? randomUUID
	}

	/** 登记新会话并返回其状态。sessionId 由注入的生成器产生（默认 randomUUID）。 */
	create(params: IAcpSessionCreateParams): IAcpSessionState {
		const sessionId = this.generateSessionId()
		const state: IAcpSessionState = {
			sessionId,
			workspaceRootPath: params.workspaceRootPath,
			mcpServers: params.mcpServers,
			mode: params.mode,
			abortController: null,
			...(params.modelConfig ? { modelConfig: params.modelConfig } : {}),
		}
		this.sessions.set(sessionId, state)
		return state
	}

	/** 读取会话状态；不存在返回 undefined（RPC 错误映射由调用方负责）。 */
	get(sessionId: string): IAcpSessionState | undefined {
		return this.sessions.get(sessionId)
	}

	/** 是否已登记该会话。 */
	has(sessionId: string): boolean {
		return this.sessions.has(sessionId)
	}

	/** 当前登记的会话数。 */
	get size(): number {
		return this.sessions.size
	}

	/** 切换已登记会话的运行模式；返回更新后的状态，会话不存在返回 undefined。 */
	setMode(sessionId: string, mode: TAgentMode): IAcpSessionState | undefined {
		const state = this.sessions.get(sessionId)
		if (!state) return undefined
		state.mode = mode
		return state
	}

	/**
	 * 开启一个新回合：创建并登记全新的 AbortController 返回之，以接入运行时 options.context.signal。
	 * 若上一个回合的句柄仍在（异常未清理），先中止以防泄漏。会话不存在返回 undefined。
	 */
	beginTurn(sessionId: string): AbortController | undefined {
		const state = this.sessions.get(sessionId)
		if (!state) return undefined
		state.abortController?.abort()
		const controller = new AbortController()
		state.abortController = controller
		return controller
	}

	/** 结束当前回合：清空取消句柄（不主动 abort——正常完成无需中止）。会话不存在则无操作。 */
	endTurn(sessionId: string): void {
		const state = this.sessions.get(sessionId)
		if (state) {
			state.abortController = null
		}
	}

	/**
	 * 取消会话当前回合：存在活跃句柄则 abort 并清空，返回 true；
	 * 无活跃回合（或会话不存在）返回 false。映射 ACP session/cancel 通知。
	 */
	cancel(sessionId: string): boolean {
		const state = this.sessions.get(sessionId)
		if (!state?.abortController) return false
		state.abortController.abort()
		state.abortController = null
		return true
	}

	/** 注销会话；返回是否确有移除。若有活跃回合，一并中止避免悬挂运行。 */
	delete(sessionId: string): boolean {
		const state = this.sessions.get(sessionId)
		if (!state) return false
		state.abortController?.abort()
		return this.sessions.delete(sessionId)
	}
}
