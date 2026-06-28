/* ============================================================================
 * ACP-native 工具调用 wire 类型（ADR-20260617）
 *
 * ACP 是与 Mastra `TAgentRuntimeEvent` 平级的「第二语言」：外部 ACP agent
 * （如 Kimi）经 Rust host 最小透传，工具调用以 ACP `session/update` 的
 * `tool_call` / `tool_call_update` 形态到达前端，**不**伪造 Mastra 遥测 base
 * 字段（runId / agentId / timestamp / seq / schemaVersion …）。
 *
 * 这些类型直接从 `@agentclientprotocol/sdk` 的 `SessionUpdate` 判别联合中
 * `Extract` 出两支变体，零手写、零漂移——SDK 升级时类型自动跟随。前端投影层
 * （ACL）据此归一到 `src/types/ai/thread` 协议 VM（`aiThreadToolCallSchema`），
 * 与 Mastra 源共用同一渲染 VM。
 *
 * 注：本文件为纯新增类型出口，先不接入主 barrel / 契约 union（接线在后续
 * 迁移步骤完成），以保证该步零运行时风险。类型名与 sidecar 侧
 * `builtin-agent/src/acp/from-runtime-event.ts` 的 SDK 导入保持同源。
 * ========================================================================== */
import type { SessionUpdate, ToolCallContent, ToolKind } from '@agentclientprotocol/sdk';

/**
 * ACP `session/update` 首次出现的工具调用（`sessionUpdate: 'tool_call'`）。
 * 携带 `toolCallId` / `title` / `kind` / `status` / `content[]` / `locations[]` /
 * `rawInput` / `rawOutput`（以 SDK 定义为准）。
 */
export type TAcpToolCall = Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>;

/**
 * 同一 `toolCallId` 的增量更新（`sessionUpdate: 'tool_call_update'`）。
 * reduce 层以 `toolCallId` 为键将 started → update(N) → completed 收敛为同一条。
 */
export type TAcpToolCallUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>;

/**
 * 工具产出内容块（content | diff | terminal）与工具种类，原名 re-export，
 * 供投影层单点引用，避免多处直接依赖 SDK 路径。
 */
export type { ToolCallContent as TAcpToolCallContent, ToolKind as TAcpToolKind };
