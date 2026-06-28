/**
 * ACP 编排扩展方法的执行核心。
 *
 * 把原生 Mastra 计划编排 workflow 的「跑到挂起/终态 + 流式投影 + runId 注册」从旧 HTTP
 * server.ts 的 /agent/plan/orchestrate(/stream) 与 /resume(/stream) 处理体平移到 ACP 带外
 * 扩展方法的实现体，语义逐一对齐、不自创：
 *   * 自发 runId（randomUUID），不依赖 run.runId 实现细节（与 server.ts、rollback 一致）；
 *   * createRun({ runId }) 建立/重建 run：start 用新 runId；resume 优先内存快路径，未命中
 *     （进程重启 / TTL 回收）时用同 runId 从 libsql 'workflows' 域 rehydrate；
 *   * 始终用 run.stream()/run.resumeStream() 流式执行：把白名单内的内层 agent 事件经注入的
 *     sink 下沉（agent.ts 投影为 session/update，复用既有 ai:sidecar-stream 消费端），丢弃
 *     Mastra 内部生命周期帧；
 *   * 挂起点统一经 suspend/resume 信封驱动（计划审批门 / 工具审批 / 逐步闸门），不走 ACP
 *     反向 session/request_permission——与 HTTP 编排回合的挂起语义保持一致；
 *   * 挂起的 run 在内存注册表保留至多 ORCHESTRATION_RUN_TTL_MS，超时回收，避免长跑 sidecar
 *     永久持有被放弃的 run（与 server.ts 同值同语义）。
 *
 * 纯执行核心：不耦合 JSON-RPC / 传输，sink 由 dispatcher(agent.ts) 注入，便于单测。
 * 复用同目录 ./orchestration-events.js 的 extractOrchestrationAgentEvent 与
 * TPlanOrchestrationRun（已随 server/ 删除从旧 HTTP server 迁入本 acp/ 目录）。
 */
import { randomUUID } from "node:crypto"

import type { IAgentRuntimeModelConfigInput } from "../engines/contracts/runtime-input.js"
import type {
	IAgentSidecarRuntime,
	TAgentRuntimeOutputEvent,
} from "../engines/runtime/runtime.js"
import {
	extractOrchestrationAgentEvent,
	type TPlanOrchestrationRun,
} from "./orchestration-events.js"

/**
 * 内存中保留的「已挂起、等待审批 resume」编排 run 的最长存活时间（与 server.ts 同值）。
 * 超时未 resume 则回收，避免长跑 sidecar 永久持有被放弃的 run。
 */
const ORCHESTRATION_RUN_TTL_MS = 30 * 60 * 1000

/** start 入参（已从扩展方法 schema 投影；executionMode 缺省由 schema 归一为 interactive）。 */
export interface IOrchestrationStartParams {
	goal: string
	executionMode: "interactive" | "autonomous"
	threadId?: string
	modelConfig?: IAgentRuntimeModelConfigInput
}

/** resume 入参（runId 必填；decision 覆盖三类挂起点；modelConfig 用于快照重建时透传请求级模型）。 */
export interface IOrchestrationResumeParams {
	runId: string
	decision: "approve" | "reject" | "continue" | "cancel"
	reason?: string
	modelConfig?: IAgentRuntimeModelConfigInput
}

/** 一次编排切片的结果信封（与 server.ts 流式终帧 { runId, status, result } 同形）。 */
export interface IOrchestrationResult {
	runId: string
	status: string
	result: unknown
}

/**
 * 过程中内层 agent 事件的下沉口：由 dispatcher 注入，把每条白名单事件投影为 session/update。
 * 无关联会话（无 sessionId）时 dispatcher 注入空实现。
 */
export type TOrchestrationEventSink = (event: TAgentRuntimeOutputEvent) => void

/** 注入项：runId 生成器与 TTL，便于测试确定化。默认 randomUUID + 30min。 */
export interface IAcpOrchestrationRunnerOptions {
	generateRunId?: () => string
	runTtlMs?: number
}

export class AcpOrchestrationRunner {
	private readonly runtime: IAgentSidecarRuntime
	private readonly runs = new Map<string, TPlanOrchestrationRun>()
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
	private readonly generateRunId: () => string
	private readonly runTtlMs: number

	constructor(
		runtime: IAgentSidecarRuntime,
		options: IAcpOrchestrationRunnerOptions = {},
	) {
		this.runtime = runtime
		this.generateRunId = options.generateRunId ?? randomUUID
		this.runTtlMs = options.runTtlMs ?? ORCHESTRATION_RUN_TTL_MS
	}

	/** 启动一次编排：自发 runId → createRun → 流式跑到挂起/终态；挂起则保留 run 供 resume。 */
	async start(
		params: IOrchestrationStartParams,
		sink: TOrchestrationEventSink,
	): Promise<IOrchestrationResult> {
		const workflow = this.requireWorkflowBuilder()(params.modelConfig)
		const runId = this.generateRunId()
		const run = await workflow.createRun({ runId })
		this.remember(runId, run)
		// run.stream() 返回 async-iterable 的 run 输出；approval-gate 挂起时流自动闭合，
		// 据 stream.status 决定保留(resume)或回收，与 server.ts /stream 处理体一致。
		const stream = run.stream({
			inputData: {
				goal: params.goal,
				threadId: params.threadId ?? null,
				executionMode: params.executionMode,
			},
		})
		for await (const chunk of stream) {
			const event = extractOrchestrationAgentEvent(chunk)
			if (event) {
				sink(event)
			}
		}
		const result = await stream.result
		const status = stream.status
		if (status !== "suspended") {
			this.forget(runId)
		}
		return { runId, status, result }
	}

	/** 恢复一个被挂起的编排 run：内存快路径未命中时用同 runId 从快照重建，再流式续跑。 */
	async resume(
		params: IOrchestrationResumeParams,
		sink: TOrchestrationEventSink,
	): Promise<IOrchestrationResult> {
		let run = this.runs.get(params.runId)
		if (!run) {
			// 同 runId 的 createRun 会从 storage 的 'workflows' 域 rehydrate 已挂起快照。
			const workflow = this.requireWorkflowBuilder()(params.modelConfig)
			run = await workflow.createRun({ runId: params.runId })
		}
		const stream = run.resumeStream({
			resumeData: {
				decision: params.decision,
				...(params.reason ? { reason: params.reason } : {}),
			},
		})
		for await (const chunk of stream) {
			const event = extractOrchestrationAgentEvent(chunk)
			if (event) {
				sink(event)
			}
		}
		const result = await stream.result
		const status = stream.status
		// 非 suspended 即终态，回收 run；仍 suspended（链式工具审批 / 下一个逐步闸门）时重新登记。
		if (status !== "suspended") {
			this.forget(params.runId)
		} else {
			this.remember(params.runId, run)
		}
		return { runId: params.runId, status, result }
	}

	/** 释放注册表持有的全部计时器与 run（agent/连接关停时调用，幂等）。 */
	dispose(): void {
		for (const timer of this.timers.values()) {
			clearTimeout(timer)
		}
		this.timers.clear()
		this.runs.clear()
	}

	private requireWorkflowBuilder(): NonNullable<
		IAgentSidecarRuntime["buildPlanOrchestrationWorkflow"]
	> {
		const build = this.runtime.buildPlanOrchestrationWorkflow
		if (typeof build !== "function") {
			throw new Error("当前 runtime 不支持原生编排 workflow。")
		}
		return build.bind(this.runtime)
	}

	private remember(runId: string, run: TPlanOrchestrationRun): void {
		this.runs.set(runId, run)
		const existing = this.timers.get(runId)
		if (existing) {
			clearTimeout(existing)
		}
		const timer = setTimeout(() => this.forget(runId), this.runTtlMs)
		// 不让悬挂的回收计时器阻止进程退出。
		timer.unref?.()
		this.timers.set(runId, timer)
	}

	private forget(runId: string): void {
		this.runs.delete(runId)
		const timer = this.timers.get(runId)
		if (timer) {
			clearTimeout(timer)
			this.timers.delete(runId)
		}
	}
}
