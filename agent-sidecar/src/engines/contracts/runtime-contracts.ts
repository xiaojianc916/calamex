import {
    AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION,
    type TAgentSidecarResponse,
    type TAgentUiEvent,
    type TLanguageModelUsage,
} from '../../schemas/events.js';

// -----------------------------------------------------------------------------
// Helper: extract a single UI event variant by its discriminator.
// -----------------------------------------------------------------------------

type TRuntimeUiEvent<TType extends TAgentUiEvent['type']> = Extract<
    TAgentUiEvent,
    { type: TType }
>;

/**
 * Discriminator strings of the UI events the runtime is **allowed** to emit.
 *
 * This is intentionally an allowlist, not the full `TAgentUiEvent` union:
 * - Some UI events are produced exclusively by the host (Tauri layer) and
 *   should never originate from the agent runtime.
 * - When a new UI event is added to `TAgentUiEvent`, you must explicitly opt
 *   it in here. The `assertRuntimeEventTypeCovered` check below makes the
 *   intent visible at compile time but does **not** auto-include new variants.
 *
 * NOTE（ACP 原生重写，U3a）：正文增量与工具生命周期已全面收敛为富事件
 * `agent_event`（agent.text.delta / agent.tool.*），故 `message_delta` / `tool_start`
 * 已零生产端；`message_clear` / `diff_ready` 在 sidecar 从未有生产端。四者均已从
 * 本白名单移除。扁平的工具完成事件 `tool_result` 同样已被富事件
 * `agent.tool.completed` 取代（validator / replanner / base 兜底审批三处生产端均已
 * 改写），零生产端后从白名单移除；前端事件适配层对扁平与富两种形态产出完全一致的
 * AG-UI 输出（TOOL_CALL_END + TOOL_CALL_RESULT），故为无损收敛。
 *
 * 终态终止事件 `done` 同样已移除：依据 ACP，turn 的最终结果由 prompt 响应的
 * `result` 承载、token 用量经 `session/update` 的 `usage_update` 通知投影（见
 * {@link IAgentTokenUsageSnapshot} 与 {@link IAgentRuntimeResponse.usage}），均不再
 * 需要一个独立的终止 UI 事件。
 *
 * 扁平错误事件 `error` 亦已移除：依据 ACP，失败的 turn 由响应的
 * {@link IAgentRuntimeResponse.errorMessage} 承载，并在 egress 映射为 JSON-RPC
 * error / 带外信号，运行时不再发射独立的错误 UI 事件；遗留 wire 帧由 http 边界
 * shim（{@link toAgentSidecarResponse} 与 handlePostStream）临时重建，待前端迁移
 * 至 ACP（U4）后连同 shim 一并删除。至此白名单精确收敛为实际发射的核心变体。
 *
 * NOTE（ask_user HITL）：`ask_user_required` 是 ask_user 工具挂起时投影的结构化
 * 反向提问事件。与 `approval_required` 同属带外承载（随 prompt 响应信封下发、不作为
 * session/update 通知），但携带多问多选的结构化表单而非单一批准请求；恢复经专用
 * ext 方法回传富答案（见 acp/ext-methods 的 ask-user resume），而非 approve/reject。
 * 发射端随 base.ts 的挂起分支特化落地（2b）；本提交仅纳入契约与出口投影。
 */
export const AGENT_RUNTIME_OUTPUT_EVENT_TYPES = [
    'agent_event',
    'plan_ready',
    'plan_record',
    'approval_required',
    'ask_user_required',
] as const satisfies ReadonlyArray<TAgentUiEvent['type']>;

export type TAgentRuntimeOutputEventType = (typeof AGENT_RUNTIME_OUTPUT_EVENT_TYPES)[number];

/**
 * The strict subset of UI events the agent runtime may produce.
 *
 * Any event passed into the sidecar response **must** narrow to one of these
 * variants. UI-side events outside this set (e.g. lifecycle events generated
 * by the host) are not valid runtime outputs.
 */
export type TAgentRuntimeOutputEvent = TRuntimeUiEvent<TAgentRuntimeOutputEventType>;

// -----------------------------------------------------------------------------
// Token usage snapshot.
// -----------------------------------------------------------------------------

/**
 * Aggregated token usage captured at the end of a run.
 *
 * Per ACP, token usage is **not** a terminal field on the prompt response; it
 * is surfaced via a `session/update` `usage_update` notification. This snapshot
 * is the runtime-internal carrier of that data: the ACP egress layer projects
 * it into a `usage_update` (with `size` taken from the model's context window)
 * when serializing the run. It is intentionally decoupled from any single UI
 * event so no producer needs to fabricate a terminal event just to report it.
 *
 * The `usage` field mirrors {@link TLanguageModelUsage}; the flat
 * prompt/completion/total counts are kept only for backward-compatible
 * consumers and should be considered deprecated in favour of `usage`.
 */
export interface IAgentTokenUsageSnapshot {
    /** @deprecated prefer `usage.inputTokens` */
    readonly promptTokens?: number;
    /** @deprecated prefer `usage.outputTokens` */
    readonly completionTokens?: number;
    /** @deprecated prefer `usage.totalTokens` */
    readonly totalTokens?: number;
    readonly usage?: TLanguageModelUsage | null;
}

// -----------------------------------------------------------------------------
// Public response / option contracts.
// -----------------------------------------------------------------------------

export interface IAgentRuntimeResponse {
    /** Stable identifier for the chat session this run belongs to. */
    readonly sessionId: string;
    /** Echo of the originating request id (for log correlation / dedup). */
    readonly requestId?: string;
    /**
     * Full ordered event log produced by this run.
     *
     * If the caller supplied `IAgentRuntimeRunOptions.onEvent`, each event in
     * this array has already been delivered via that callback. The array is a
     * post-hoc snapshot; consumers should not assume it is still mutable.
     */
    readonly events: ReadonlyArray<TAgentRuntimeOutputEvent>;
    /** Final assistant message text, or `null` if the run produced no message. */
    readonly result: string | null;
    /**
     * Human-readable failure message when the run errored, otherwise absent.
     *
     * Per ACP, a failed turn is not modelled as a UI event: it is surfaced via
     * the prompt response (mapped to a JSON-RPC error / out-of-band signal by
     * the egress layer). This field is the runtime-internal carrier of that
     * message. When set, `result` is `null`. The legacy UI-side `error` frame
     * is reconstructed at the transport boundary (see {@link toAgentSidecarResponse}
     * and handlePostStream) until the frontend migrates to ACP (U4).
     */
    readonly errorMessage?: string;
    /**
     * Aggregated token usage for the run, if available.
     *
     * Carried here (rather than on a terminal event) so the ACP egress layer
     * can emit a `usage_update` session notification; see
     * {@link IAgentTokenUsageSnapshot}.
     */
    readonly usage?: IAgentTokenUsageSnapshot;
}

export interface IAgentRuntimeContext {
    /** Caller-supplied request id; surfaced back in {@link IAgentRuntimeResponse.requestId}. */
    readonly requestId: string;
    /** Aborts the run cooperatively. Once aborted, the runtime must emit a terminal event. */
    readonly signal: AbortSignal;
    /** Optional wall-clock budget. Implementations should treat as advisory. */
    readonly timeoutMs?: number;
}

export interface IAgentRuntimeRunOptions {
    /**
     * Streaming callback. Invoked once per event in the order they are produced.
     * The same events also appear in {@link IAgentRuntimeResponse.events}; callers
     * should pick one consumption mode and not double-handle.
     */
    readonly onEvent?: (event: TAgentRuntimeOutputEvent) => void;
    readonly context?: IAgentRuntimeContext;
}

// -----------------------------------------------------------------------------
// Bridging to the UI-side schema.
// -----------------------------------------------------------------------------

/**
 * Widens a runtime event to the broader UI-event union.
 *
 * This is intentionally an identity at runtime; its sole purpose is to drop
 * the narrow `TAgentRuntimeOutputEvent` type so the value can flow into APIs
 * typed against the full `TAgentUiEvent` union without an `as` cast.
 */
export const toAgentUiEvent = (event: TAgentRuntimeOutputEvent): TAgentUiEvent => event;

/**
 * Project a runtime response into the sidecar-facing response shape.
 *
 * The returned object holds a shallow copy of the events array so callers may
 * not mutate the original response. Individual event objects are shared by
 * reference (they are themselves immutable in practice).
 *
 * 边界倒计时 shim：当响应携带 `errorMessage` 时，向信封 events 末尾追加一条遗留
 * `error` UI 事件，使未迁移的前端 / Rust 在旧协议下错误展示行为保持不变。待前端
 * 迁移至 ACP（U4）后，errorMessage 将直接映射为 JSON-RPC error，本 shim 删除。
 *
 * Note: `requestId` is intentionally dropped here — it lives on the internal
 * runtime contract but is not part of the public sidecar response envelope.
 * If the IPC layer needs it for correlation, it should read it directly from
 * `IAgentRuntimeResponse.requestId` before projection.
 */
export const toAgentSidecarResponse = (
    response: IAgentRuntimeResponse,
): TAgentSidecarResponse => ({
    schemaVersion: AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION,
    sessionId: response.sessionId,
    events: response.errorMessage
        ? [...response.events, { type: 'error' as const, message: response.errorMessage }]
        : response.events.slice(),
    result: response.result,
});

// -----------------------------------------------------------------------------
// Compile-time guards.
// -----------------------------------------------------------------------------

/**
 * Compile-time assertion that every entry in `AGENT_RUNTIME_OUTPUT_EVENT_TYPES`
 * is a valid `TAgentUiEvent['type']`. The `satisfies` clause above already
 * enforces this, but this explicit type-level check makes the intent visible
 * if `TAgentUiEvent` ever changes shape.
 */
type AssertRuntimeEventTypesAreUiTypes =
    TAgentRuntimeOutputEventType extends TAgentUiEvent['type'] ? true : never;

const _assertRuntimeEventTypesAreUiTypes: AssertRuntimeEventTypesAreUiTypes = true;
void _assertRuntimeEventTypesAreUiTypes;