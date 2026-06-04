import { randomUUID } from 'node:crypto';
/**
 * 内部 runtime event 协议版本。
 *
 * 这是 sidecar 内部事件契约（`TAgentRuntimeEvent`），
 * 不是 UI wire envelope（后者由 `events.ts.AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION` 管）。
 */
export const AGENT_RUNTIME_EVENT_SCHEMA_VERSION = 1;
export const AGENT_RUNTIME_EVENT_TYPES = [
    'agent.run.started',
    'agent.text.delta',
    'agent.reasoning.delta',
    'agent.model.started',
    'agent.model.completed',
    'agent.tool.started',
    'agent.tool.progress',
    'agent.tool.completed',
    'acontext.envelope.injected',
    'acontext.envelope.replaced',
    'acontext.token.checked',
    'acontext.provider_payload.checked',
    'acontext.tool_summary.recorded',
    'acontext.memory.compressed',
    'rollback.checkpoint.created',
    'rollback.checkpoint.failed',
    'rollback.restore.started',
    'rollback.restore.completed',
    'rollback.restore.failed',
    'side_effect.recorded',
    'side_effect.warning',
    'agent.message.added',
    'agent.run.completed',
    'agent.run.error',
    'agent.debug',
];
const _assertExhaustive = true;
void _assertExhaustive;
/**
 * 构造一个 `TAgentRuntimeEvent`。
 *
 * 使用泛型保留调用方处的具体子类型：
 * ```ts
 * const ev = createAgentRuntimeEvent(ctx, 1, {
 *   type: 'agent.tool.started',
 *   visibility: 'user',
 *   toolName: 'x',
 * });
 * // ev 推断为 IAgentToolStartedEvent & IAgentRuntimeEventBase
 * ```
 */
export const createAgentRuntimeEvent = (context, seq, draft) => ({
    id: randomUUID(),
    runId: context.runId,
    sessionId: context.sessionId,
    agentId: context.agentId,
    timestamp: context.now ? context.now() : new Date().toISOString(),
    seq,
    schemaVersion: AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
    redacted: true,
    ...(context.traceId ? { traceId: context.traceId } : {}),
    ...draft,
});
