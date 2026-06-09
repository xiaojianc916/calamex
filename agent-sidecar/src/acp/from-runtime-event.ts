/**
 * 运行时富事件 → ACP SessionUpdate 投影。
 *
 * 这是 sidecar 内部 `TAgentRuntimeEvent`（见 ../streaming/stream-types，29 类）
 * 通向 ACP 线上协议的唯一边界：
 * - 模型文本增量  → agent_message_chunk
 * - 模型推理增量  → agent_thought_chunk
 * - 工具生命周期  → tool_call / tool_call_update
 * - 计划快照      → plan（全量条目替换）
 *
 * 其余事件（运行生命周期、模型计量、acontext 预算、rollback、side-effect、
 * 消息记账、调试）属于「链路外」遥测：按 ACP 前向兼容约定，它们不进入
 * SessionUpdate 流，而由响应信封 / 可观测性侧通道承载，这里显式返回 []。
 *
 * 关键设计：工具调用直接复用富事件自带的 `toolUseId` 作为 ACP `toolCallId`，
 * 故 started / progress / completed 天然以同一 id 关联——彻底取代旧消费端
 * 用 toolName 猜测 id 的脆弱做法。本模块为纯函数，无 I/O、无状态。
 */
import type { TAgentRuntimeEvent } from "../streaming/stream-types.js"
import type {
	SessionUpdate,
	ToolCallContent,
	ToolKind,
} from "@agentclientprotocol/sdk"
import { textBlock } from "./helpers.js"

/**
 * 从工具名启发式推断 ACP ToolKind。kind 仅用于 UI 图标/分组，推断不准
 * 不影响协议正确性（schema 对未知值 .catch("other")）。
 */
export const inferToolKind = (toolName: string): ToolKind => {
	const name = toolName.toLowerCase()
	const has = (...needles: string[]): boolean =>
		needles.some((needle) => name.includes(needle))
	if (has("delete", "remove", "unlink")) return "delete"
	if (has("rename", "move")) return "move"
	if (has("search", "grep", "glob", "ripgrep", "find")) return "search"
	if (
		has(
			"write",
			"edit",
			"patch",
			"apply",
			"create",
			"update",
			"insert",
			"replace",
			"format",
		)
	)
		return "edit"
	if (has("read", "cat", "view", "open", "list", "stat", "get")) return "read"
	if (has("exec", "run", "bash", "shell", "command", "terminal", "spawn"))
		return "execute"
	if (has("fetch", "http", "web", "url", "download", "browse")) return "fetch"
	if (has("think", "reason", "plan", "reflect")) return "think"
	return "other"
}

/**
 * 解析工具调用的稳定 id：优先 `toolUseId`，回退到 `toolName`。
 *
 * 运行时**应当**始终提供 `toolUseId`；回退仅为兜底（同名工具并发时可能串台），
 * 后续单元会在发射端将 `toolUseId` 收紧为必填，使回退分支不可达。
 * 当两者皆缺（如无名进度心跳）时返回 null，调用方据此跳过该事件。
 */
const resolveToolCallId = (event: {
	toolUseId?: string
	toolName?: string
}): string | null => {
	if (typeof event.toolUseId === "string" && event.toolUseId.length > 0) {
		return event.toolUseId
	}
	if (typeof event.toolName === "string" && event.toolName.length > 0) {
		return event.toolName
	}
	return null
}

const assertNever = (event: never): never => {
	throw new Error(`未处理的运行时事件类型：${JSON.stringify(event)}`)
}

/**
 * 将单条运行时富事件投影为 0..n 条 ACP SessionUpdate。
 *
 * 返回空数组有两种**正当**含义（均非缺陷）：
 * 1. 该事件类型属于链路外遥测，ACP 无对应 wire 形态；
 * 2. 工具进度事件缺少可关联的 id，无法挂到某个 tool_call 上。
 */
export const projectRuntimeEventToAcp = (
	event: TAgentRuntimeEvent,
): SessionUpdate[] => {
	switch (event.type) {
		case "agent.text.delta":
			return [
				{ sessionUpdate: "agent_message_chunk", content: textBlock(event.text) },
			]
		case "agent.reasoning.delta":
			return [
				{ sessionUpdate: "agent_thought_chunk", content: textBlock(event.text) },
			]
		case "agent.tool.started": {
			const toolCallId = resolveToolCallId(event)
			if (toolCallId === null) return []
			return [
				{
					sessionUpdate: "tool_call",
					toolCallId,
					title: event.toolName,
					kind: inferToolKind(event.toolName),
					status: "in_progress",
					...(event.inputPreview !== undefined
						? { rawInput: event.inputPreview }
						: {}),
				},
			]
		}
		case "agent.tool.progress": {
			const toolCallId = resolveToolCallId(event)
			if (toolCallId === null) return []
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId,
					status: "in_progress",
					...(event.dataPreview !== undefined
						? {
								content: [
									{ type: "content", content: textBlock(event.dataPreview) },
								],
							}
						: {}),
				},
			]
		}
		case "agent.tool.completed": {
			const toolCallId = resolveToolCallId(event)
			if (toolCallId === null) return []
			const content: ToolCallContent[] = []
			if (
				!event.ok &&
				typeof event.errorMessage === "string" &&
				event.errorMessage.length > 0
			) {
				content.push({ type: "content", content: textBlock(event.errorMessage) })
			}
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId,
					status: event.ok ? "completed" : "failed",
					...(content.length > 0 ? { content } : {}),
					...(event.resultPreview !== undefined
						? { rawOutput: event.resultPreview }
						: {}),
				},
			]
		}
		case "agent.plan.updated":
			// ACP 计划是全量快照：client 以每条 plan 更新整体替换计划
			// （见 plan.rs `Plan.entries`）。条目形状已 1:1 对齐 ACP PlanEntry，
			// 显式重建对象以剔除任何 runtime-only 字段、并满足 schema。
			return [
				{
					sessionUpdate: "plan",
					entries: event.entries.map((entry) => ({
						content: entry.content,
						priority: entry.priority,
						status: entry.status,
					})),
				},
			]
		// ---- 链路外遥测 / 生命周期 / 计量：不投影为 SessionUpdate。 ----
		case "agent.run.started":
		case "agent.run.completed":
		case "agent.run.error":
		case "agent.model.started":
		case "agent.model.completed":
		case "acontext.envelope.injected":
		case "acontext.envelope.replaced":
		case "acontext.token.checked":
		case "acontext.provider_payload.checked":
		case "acontext.tool_summary.recorded":
		case "acontext.memory.compressed":
		case "acontext.context_compaction.started":
		case "acontext.context_compaction.updated":
		case "acontext.context_compaction.completed":
		case "rollback.checkpoint.created":
		case "rollback.checkpoint.failed":
		case "rollback.restore.started":
		case "rollback.restore.completed":
		case "rollback.restore.failed":
		case "side_effect.recorded":
		case "side_effect.warning":
		case "agent.message.added":
		case "agent.debug":
			return []
		default:
			return assertNever(event)
	}
}

/** 批量投影：保序 flatMap。 */
export const projectRuntimeEventsToAcp = (
	events: ReadonlyArray<TAgentRuntimeEvent>,
): SessionUpdate[] => events.flatMap((event) => projectRuntimeEventToAcp(event))
