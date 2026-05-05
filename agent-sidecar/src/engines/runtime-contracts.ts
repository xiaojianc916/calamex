import type { TAgentSidecarResponse, TAgentUiEvent } from '../schemas/events.js';

type TRuntimeUiEvent<TType extends TAgentUiEvent['type']> = Extract<TAgentUiEvent, { type: TType }>;

export type TAgentRuntimeOutputEvent =
    | TRuntimeUiEvent<'message_delta'>
    | TRuntimeUiEvent<'agent_event'>
    | TRuntimeUiEvent<'plan_ready'>
    | TRuntimeUiEvent<'tool_start'>
    | TRuntimeUiEvent<'tool_result'>
    | TRuntimeUiEvent<'approval_required'>
    | TRuntimeUiEvent<'diff_ready'>
    | TRuntimeUiEvent<'done'>
    | TRuntimeUiEvent<'error'>;

export interface IAgentRuntimeResponse {
    sessionId: string;
    events: TAgentRuntimeOutputEvent[];
    result: string | null;
}

export interface IAgentRuntimeContext {
    requestId: string;
    signal: AbortSignal;
    timeoutMs?: number;
}

export interface IAgentRuntimeRunOptions {
    onEvent?: (event: TAgentRuntimeOutputEvent) => void;
    context?: IAgentRuntimeContext;
}

export const toAgentUiEvent = (event: TAgentRuntimeOutputEvent): TAgentUiEvent => event;

export const toAgentSidecarResponse = (
    response: IAgentRuntimeResponse,
): TAgentSidecarResponse => ({
    ...response,
    events: response.events.map(toAgentUiEvent),
});