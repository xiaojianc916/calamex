/**
 * calamex sidecar 的原生 ACP Agent 实现。
 *
 * 本文件是 sidecar 作为 ACP Agent 的唯一分发器(dispatcher):实现 SDK 的 `Agent`
 * 接口,把 ACP 的会话生命周期方法接到现有运行时与保留的投影模块:
 * - initialize       → 协商协议版本与能力。
 * - newSession        → 在会话登记表登记 cwd(→workspaceRootPath)、客户端声明的 mcpServers。
 * - setSessionMode    → 校验 modeId 为 TAgentMode 后切换该会话运行模式。
 * - prompt            → 按模式路由到 runtime.chat/plan/execute;过程中的运行时输出事件
 *                       经 output-event-stream 投影为 session/update 通知即时下发,
 *                       回合内若出现待裁决审批,经 session/request_permission 取得裁决后
 *                       回灌 resolveApproval 续跑(见 approval-bridge.ts),直至无待裁决审批,
 *                       回合收尾经 turn-egress 发可选 usage_update + 返回 PromptResponse。
 * - cancel            → 中止该会话当前回合的 AbortController(映射 runtime context.signal)。
 *
 * 设计要点:
 * - 依赖注入(connection / runtime / registry / 生成器),与 JSON-RPC 传输解耦,可单测。
 * - 会话历史由 Agent 按 sessionId 自持(运行时 memory + threadId),故 prompt 只携带
 *   本回合新输入(见 to-runtime-input)。
 * - 模型配置默认由 sidecar 进程环境变量解析(见 models/config.ts),不在 prompt 内携带;
 *   仅在会话显式携带 modelConfig 时使用之。
 */
import {
	PROTOCOL_VERSION,
	RequestError,
	type Agent,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type CancelNotification,
	type InitializeRequest,
	type InitializeResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	type PromptRequest,
	type PromptResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
} from "@agentclientprotocol/sdk"
import { randomUUID } from "node:crypto"

import type {
	IAgentRuntimeRunOptions,
	IAgentTokenUsageSnapshot,
} from "../engines/contracts/runtime-contracts.js"
import {
	AGENT_MODES,
	type TAgentMode,
} from "../engines/contracts/runtime-input.js"
import type {
	IAgentSidecarRuntime,
	TAgentRuntimeOutputEvent,
} from "../engines/runtime.js"
import { resolveAgentModelCapabilitiesFromModelId } from "../models/capabilities.js"
import {
	findPendingApproval,
	toApprovalDecision,
	toRequestPermissionRequest,
} from "./approval-bridge.js"
import { promptResponse } from "./helpers.js"
import { toSessionNotificationsFromOutputEvent } from "./output-event-stream.js"
import { AcpSessionRegistry } from "./session-registry.js"
import { buildPromptRuntimeInput } from "./to-runtime-input.js"
import { buildTurnTrailer } from "./turn-egress.js"
import type { IUsageSnapshotInput } from "./usage.js"

/**
 * Agent 向 client 推送 session/update 通知、并在回合内发起反向权限请求所需的最小连接面。
 * SDK 的 AgentSideConnection 结构上满足本接口;抽象出来便于单测注入假连接。
 */
export interface IAcpAgentConnection {
	sessionUpdate(params: SessionNotification): Promise<void>
	requestPermission(
		params: RequestPermissionRequest,
	): Promise<RequestPermissionResponse>
}

/** 构造参数(均可选,便于测试确定化)。 */
export interface ICalamexAcpAgentOptions {
	/** 会话登记表;默认新建一个(生产用 randomUUID 生成 sessionId)。 */
	registry?: AcpSessionRegistry
	/** newSession 的初始运行模式;默认 "agent"(自主工具执行)。 */
	defaultMode?: TAgentMode
	/** 单回合运行时预算(毫秒,advisory);默认 30 分钟。 */
	turnTimeoutMs?: number
	/** 运行时 requestId 生成器(仅用于日志关联);默认 randomUUID。 */
	generateRequestId?: () => string
}

/** 默认模型标识——镜像 models/config.ts 的 DEFAULT_MODEL_ID,用于解析上下文窗口。 */
const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-pro"

/** 缺省回合超时:30 分钟,与旧 http 层 DEFAULT_RUNTIME_TIMEOUT_MS 一致。 */
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 会话模式 → runtime 方法名的静态路由表。
 * Record<TAgentMode, ...> 强制穷举所有模式:新增模式未映射即编译报错。
 * ask → chat(单轮问答);plan → plan(产出计划待审批);agent/patch/review → execute(自主执行)。
 */
const RUNTIME_METHOD_BY_MODE = {
	ask: "chat",
	plan: "plan",
	agent: "execute",
	patch: "execute",
	review: "execute",
} as const satisfies Record<TAgentMode, "chat" | "plan" | "execute">

/** modeId 是否为合法的运行时模式。 */
const isAgentMode = (value: string): value is TAgentMode =>
	(AGENT_MODES as readonly string[]).includes(value)

/** 未知会话的统一 RPC 错误映射。 */
const sessionNotFound = (sessionId: string): RequestError =>
	RequestError.invalidParams({ sessionId }, `未知会话:${sessionId}`)

/**
 * 把运行时 token 快照适配为解耦的 IUsageSnapshotInput。
 * 优先用扁平计数,缺失时回退到 canonical usage(inputTokens/outputTokens/totalTokens);
 * 三者均无时返回 null(调用方据此决定不发 usage_update)。
 */
const toUsageSnapshotInput = (
	snapshot?: IAgentTokenUsageSnapshot,
): IUsageSnapshotInput | null => {
	if (!snapshot) return null
	const totalTokens = snapshot.totalTokens ?? snapshot.usage?.totalTokens
	const promptTokens = snapshot.promptTokens ?? snapshot.usage?.inputTokens
	const completionTokens =
		snapshot.completionTokens ?? snapshot.usage?.outputTokens
	if (
		totalTokens === undefined &&
		promptTokens === undefined &&
		completionTokens === undefined
	) {
		return null
	}
	return { totalTokens, promptTokens, completionTokens }
}

/**
 * 解析模型上下文窗口 token 总量(驱动 usage_update 的 size)。
 * 会话未携带 modelConfig 时回退到默认模型;标识不合法时也回退,永不抛出。
 */
const resolveContextWindowTokens = (modelId?: string): number => {
	for (const candidate of [modelId, DEFAULT_MODEL_ID]) {
		if (!candidate) continue
		try {
			return resolveAgentModelCapabilitiesFromModelId(candidate)
				.contextWindowTokens
		} catch {
			// 尝试下一个候选(默认模型)。
		}
	}
	return resolveAgentModelCapabilitiesFromModelId(DEFAULT_MODEL_ID)
		.contextWindowTokens
}

/**
 * 原生 ACP Agent。一个实例服务一条 ACP 连接(一个 stdio 客户端),内部按 sessionId 管理多会话。
 */
export class CalamexAcpAgent implements Agent {
	private readonly connection: IAcpAgentConnection
	private readonly runtime: IAgentSidecarRuntime
	private readonly registry: AcpSessionRegistry
	private readonly defaultMode: TAgentMode
	private readonly turnTimeoutMs: number
	private readonly generateRequestId: () => string

	constructor(
		connection: IAcpAgentConnection,
		runtime: IAgentSidecarRuntime,
		options: ICalamexAcpAgentOptions = {},
	) {
		this.connection = connection
		this.runtime = runtime
		this.registry = options.registry ?? new AcpSessionRegistry()
		this.defaultMode = options.defaultMode ?? "agent"
		this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
		this.generateRequestId = options.generateRequestId ?? randomUUID
	}

	async initialize(
		_params: InitializeRequest,
	): Promise<InitializeResponse> {
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: { loadSession: false },
		}
	}

	async newSession(
		params: NewSessionRequest,
	): Promise<NewSessionResponse> {
		const state = this.registry.create({
			workspaceRootPath: params.cwd,
			mcpServers: params.mcpServers ?? [],
			mode: this.defaultMode,
		})
		return { sessionId: state.sessionId }
	}

	async authenticate(
		_params: AuthenticateRequest,
	): Promise<AuthenticateResponse | void> {
		// 本地 sidecar 无需鉴权(模型凭证由环境变量注入)。
		return {}
	}

	async setSessionMode(
		params: SetSessionModeRequest,
	): Promise<SetSessionModeResponse> {
		if (!isAgentMode(params.modeId)) {
			throw RequestError.invalidParams(
				{ modeId: params.modeId, allowed: AGENT_MODES },
				`非法会话模式:${params.modeId}`,
			)
		}
		const state = this.registry.setMode(params.sessionId, params.modeId)
		if (!state) {
			throw sessionNotFound(params.sessionId)
		}
		return {}
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const state = this.registry.get(params.sessionId)
		if (!state) {
			throw sessionNotFound(params.sessionId)
		}
		const controller = this.registry.beginTurn(params.sessionId)
		if (!controller) {
			throw sessionNotFound(params.sessionId)
		}
		// 每次运行时调用共享的 onEvent 投影与运行上下文(requestId 逐次新生,用于日志关联)。
		const runOptions = (): IAgentRuntimeRunOptions => ({
			onEvent: (event) => this.emitOutputEvent(params.sessionId, event),
			context: {
				requestId: this.generateRequestId(),
				signal: controller.signal,
				timeoutMs: this.turnTimeoutMs,
			},
		})
		try {
			const input = buildPromptRuntimeInput({
				sessionId: params.sessionId,
				mode: state.mode,
				prompt: params.prompt,
				workspaceRootPath: state.workspaceRootPath,
				...(state.modelConfig ? { modelConfig: state.modelConfig } : {}),
			})
			const runMethod = this.runtime[RUNTIME_METHOD_BY_MODE[state.mode]]
			let response = await runMethod(input, runOptions())
			// 会话内审批编排循环:每当本次运行以待裁决审批收尾,就向 client 发起
			// session/request_permission,取得裁决后回灌 resolveApproval 续跑同一回合,
			// 直至不再有待裁决审批。因 Agent 全连接共享同一 runtime 实例,回灌必命中
			// 引擎内存中的 pendingApprovals 缓存(端到端事实见 approval-bridge.ts)。
			while (true) {
				// 取消优先:若本回合被 cancel,以 cancelled 收场(ACP 约定)。
				if (controller.signal.aborted) {
					return promptResponse("cancelled")
				}
				// 失败的回合:依 ACP 映射为 JSON-RPC error(报错由 SDK 包装),不占用 stopReason。
				if (response.errorMessage) {
					throw new Error(response.errorMessage)
				}
				const pending = findPendingApproval(response.events)
				if (!pending) {
					break
				}
				const permission = await this.connection.requestPermission(
					toRequestPermissionRequest(params.sessionId, pending),
				)
				if (controller.signal.aborted) {
					return promptResponse("cancelled")
				}
				const decision = toApprovalDecision(permission)
				if (decision === "cancel") {
					// 客户端在权限请求挂起期间取消了本回合:以 cancelled 收场;
					// 引擎侧挂起的运行由其 TTL 驱逐自动回收。
					return promptResponse("cancelled")
				}
				response = await this.runtime.resolveApproval(
					{
						requestId: pending.id,
						decision,
						sessionId: params.sessionId,
						workspaceRootPath: state.workspaceRootPath,
						...(state.modelConfig ? { modelConfig: state.modelConfig } : {}),
					},
					runOptions(),
				)
			}
			const trailer = buildTurnTrailer({
				sessionId: params.sessionId,
				stopReason: "end_turn",
				usage: toUsageSnapshotInput(response.usage),
				contextWindowTokens: resolveContextWindowTokens(
					state.modelConfig?.modelId,
				),
			})
			for (const notification of trailer.notifications) {
				await this.connection.sessionUpdate(notification)
			}
			return trailer.response
		} catch (error) {
			if (controller.signal.aborted) {
				return promptResponse("cancelled")
			}
			throw error
		} finally {
			this.registry.endTurn(params.sessionId)
		}
	}

	async cancel(params: CancelNotification): Promise<void> {
		this.registry.cancel(params.sessionId)
	}

	/**
	 * 把一条运行时输出事件投影为 0..n 条 session/update 通知并下发。
	 * 采用 fire-and-forget:SDK 连接内部用写队列串行化发送,顺序天然保序;
	 * 不 await 以免阻塞 runtime 的事件环。连接已关闭时吞掉 rejection。
	 */
	private emitOutputEvent(
		sessionId: string,
		outputEvent: TAgentRuntimeOutputEvent,
	): void {
		const notifications = toSessionNotificationsFromOutputEvent(
			sessionId,
			outputEvent,
		)
		for (const notification of notifications) {
			void this.connection.sessionUpdate(notification).catch(() => {})
		}
	}
}
