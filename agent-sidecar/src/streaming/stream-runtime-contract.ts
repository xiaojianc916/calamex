export interface IAgentResultContentBlock {
    type: string;
    text?: unknown;
}

export interface IAgentResultMessage {
    content: IAgentResultContentBlock[];
}

export interface IAgentStreamResult {
    stopReason?: string;
    structuredOutput?: unknown;
    lastMessage: IAgentResultMessage;
}

export type TAgentStreamOptions = Record<string, unknown>;

export interface IAgentEventStreamSource<TResult extends IAgentStreamResult = IAgentStreamResult> {
    stream(prompt: string, options: TAgentStreamOptions): AsyncGenerator<unknown, TResult, undefined>;
}