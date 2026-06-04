import { AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION, } from '../../schemas/events.js';
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
];
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
export const toAgentUiEvent = (event) => event;
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
export const toAgentSidecarResponse = (response) => ({
    schemaVersion: AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION,
    sessionId: response.sessionId,
    events: response.events.slice(),
    result: response.result,
});
const _assertRuntimeEventTypesAreUiTypes = true;
void _assertRuntimeEventTypesAreUiTypes;
