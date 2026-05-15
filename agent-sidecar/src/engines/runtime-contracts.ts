import {
    AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION,
    type TAgentSidecarResponse,
    type TAgentUiEvent,
} from '../schemas/events.js';

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
 */
export const AGENT_RUNTIME_OUTPUT_EVENT_TYPES = [
    'message_delta',
    'message_clear',
    'agent_event',
    'plan_ready',
    'plan_record',
    'tool_start',
    'tool_result',
    'approval_required',
    'diff_ready',
    'done',
    'error',
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
    events: response.events.slice(),
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