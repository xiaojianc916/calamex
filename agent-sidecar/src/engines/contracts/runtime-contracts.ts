import {
    AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION,
    type TAgentSidecarResponse,
    type TAgentUiEvent,
    type TLanguageModelUsage,
} from '../../schemas/events.js';

type TRuntimeUiEvent<TType extends TAgentUiEvent['type']> = Extract<
    TAgentUiEvent,
    { type: TType }
>;

export const AGENT_RUNTIME_OUTPUT_EVENT_TYPES = [
    'agent_event',
    'plan_ready',
    'plan_record',
    'approval_required',
    'ask_user_required',
] as const satisfies ReadonlyArray<TAgentUiEvent['type']>;

export type TAgentRuntimeOutputEventType = (typeof AGENT_RUNTIME_OUTPUT_EVENT_TYPES)[number];
export type TAgentRuntimeOutputEvent = TRuntimeUiEvent<TAgentRuntimeOutputEventType>;

export interface IAgentTokenUsageSnapshot {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
    readonly usage?: TLanguageModelUsage | null;
}

export interface IAgentRuntimeResponse {
    readonly sessionId: string;
    readonly requestId?: string;
    readonly events: ReadonlyArray<TAgentRuntimeOutputEvent>;
    readonly result: string | null;
    readonly errorMessage?: string;
    /**
     * Stable provider error classification code (e.g. `AI_PROVIDER_AUTH_FAILED`),
     * derived from AI SDK structured error properties (HTTP status code).
     */
    readonly errorCode?: string;
    readonly usage?: IAgentTokenUsageSnapshot;
}

export interface IAgentRuntimeContext {
    readonly requestId: string;
    readonly signal: AbortSignal;
    readonly timeoutMs?: number;
}

export interface IAgentRuntimeRunOptions {
    readonly onEvent?: (event: TAgentRuntimeOutputEvent) => void;
    readonly context?: IAgentRuntimeContext;
}

export const toAgentUiEvent = (event: TAgentRuntimeOutputEvent): TAgentUiEvent => event;

/**
 * Project a runtime response into the sidecar-facing response shape.
 *
 * `errorMessage` 与 `errorCode` 作为顶层字段透传到 wire 信封，使宿主可直接
 * 消费结构化错误码，不再依赖对错误消息字符串的子串匹配。
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
    ...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
    ...(response.errorCode ? { errorCode: response.errorCode } : {}),
});

type AssertRuntimeEventTypesAreUiTypes =
    TAgentRuntimeOutputEventType extends TAgentUiEvent['type'] ? true : never;
const _assertRuntimeEventTypesAreUiTypes: AssertRuntimeEventTypesAreUiTypes = true;
void _assertRuntimeEventTypesAreUiTypes;
