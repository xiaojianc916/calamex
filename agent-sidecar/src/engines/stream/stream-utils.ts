import type { ToolCallChunk, ToolResultChunk } from '@mastra/core/stream';
import { createRuntimePreview } from '../shared/utils.js';
import { type TDoneTokenSnapshot, type TCompatibleReasoningDeltaChunk, type TCompatibleToolResultPayload, type TMastraErrorChunk, type TMastraFinishChunk, type TMastraStreamChunk, type TMastraTextDeltaChunk, type TMastraToolCallApprovalChunk, type TMastraToolCallSuspendedChunk, type TMastraToolErrorChunk, type TOmDataChunk, type TOmMemoryCompressedEventDraft, type TSandboxDataChunk } from '../shared/types.js';
import { toJsonValue, toRecord } from '../shared/utils.js';

export const getTextDelta = (chunk: TMastraTextDeltaChunk): string => chunk.payload.text;

export const isReasoningDeltaChunk = (
    chunk: TMastraStreamChunk,
): chunk is TCompatibleReasoningDeltaChunk => chunk.type === 'reasoning-delta';

export const getReasoningDelta = (chunk: TMastraStreamChunk): string | null => {
    if (isReasoningDeltaChunk(chunk)) {
        return chunk.payload.text
            ?? chunk.payload.reasoning
            ?? chunk.payload.delta
            ?? chunk.payload.reasoning_content
            ?? chunk.payload.reasoningContent
            ?? null;
    }

    return null;
};

export const isSandboxDataChunk = (chunk: TMastraStreamChunk): chunk is TSandboxDataChunk =>
    chunk.type === 'data-sandbox-command'
    || chunk.type === 'data-sandbox-stdout'
    || chunk.type === 'data-sandbox-stderr'
    || chunk.type === 'data-sandbox-exit';

export const createSandboxToolProgressPreview = (chunk: TSandboxDataChunk): string =>
    createRuntimePreview({
        stream: chunk.type.replace(/^data-sandbox-/u, ''),
        ...toJsonValue(chunk.data) as Record<string, unknown>,
    });

export const isTextDeltaChunk = (
    chunk: TMastraStreamChunk,
): chunk is TMastraTextDeltaChunk => chunk.type === 'text-delta';

export const isToolCallChunk = (
    chunk: TMastraStreamChunk,
): chunk is ToolCallChunk | TMastraToolCallApprovalChunk =>
    (chunk.type === 'tool-call' || chunk.type === 'tool-call-approval')
    && typeof chunk.payload.toolName === 'string'
    && typeof chunk.payload.toolCallId === 'string';

export const isToolResultChunk = (
    chunk: TMastraStreamChunk,
): chunk is ToolResultChunk & { payload: TCompatibleToolResultPayload } =>
    chunk.type === 'tool-result'
    && typeof chunk.payload.toolName === 'string'
    && 'result' in chunk.payload;

export const isToolCallSuspendedChunk = (
    chunk: TMastraStreamChunk,
): chunk is TMastraToolCallSuspendedChunk =>
    chunk.type === 'tool-call-suspended'
    && typeof chunk.payload.toolCallId === 'string'
    && typeof chunk.payload.toolName === 'string';

export const isToolErrorChunk = (
    chunk: TMastraStreamChunk,
): chunk is TMastraToolErrorChunk =>
    chunk.type === 'tool-error'
    && typeof chunk.payload.toolName === 'string';

export const isErrorChunk = (
    chunk: TMastraStreamChunk,
): chunk is TMastraErrorChunk => chunk.type === 'error';

export const isOmOperationType = (value: unknown): value is TOmMemoryCompressedEventDraft['operationType'] =>
    value === 'observation' || value === 'reflection';

export const isOmActivationTrigger = (
    value: unknown,
): value is NonNullable<TOmMemoryCompressedEventDraft['triggeredBy']> =>
    value === 'threshold' || value === 'ttl' || value === 'provider_change';

export const toFiniteNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const toNonNegativeFiniteNumber = (value: unknown): number | undefined => {
    const candidate = toFiniteNumber(value);
    return candidate !== undefined && candidate >= 0 ? candidate : undefined;
};

export const sumTokenCounts = (
    left: number | undefined,
    right: number | undefined,
): number | undefined => {
    if (left === undefined && right === undefined) {
        return undefined;
    }

    return (left ?? 0) + (right ?? 0);
};

export const sumRequiredTokenCounts = (
    left: number | undefined,
    right: number | undefined,
): number => (left ?? 0) + (right ?? 0);

export const readRawTokenValue = (
    raw: Record<string, unknown> | null,
    key: string,
): number | undefined => toNonNegativeFiniteNumber(raw?.[key]);

export const parseInputTokenDetails = (
    record: Record<string, unknown>,
    inputTokens: number,
): NonNullable<NonNullable<TDoneTokenSnapshot['usage']>['inputTokenDetails']> | undefined => {
    const inputTokenDetailsRecord = toRecord(record.inputTokenDetails);
    const raw = toRecord(record.raw);
    const rawCacheHitTokens = readRawTokenValue(raw, 'prompt_cache_hit_tokens');
    const rawCacheMissTokens = readRawTokenValue(raw, 'prompt_cache_miss_tokens');
    const cacheReadTokens = toNonNegativeFiniteNumber(inputTokenDetailsRecord?.cacheReadTokens)
        ?? toNonNegativeFiniteNumber(record.cachedInputTokens)
        ?? rawCacheHitTokens;
    const noCacheTokens = toNonNegativeFiniteNumber(inputTokenDetailsRecord?.noCacheTokens)
        ?? rawCacheMissTokens;
    const cacheWriteTokens = toNonNegativeFiniteNumber(inputTokenDetailsRecord?.cacheWriteTokens);

    if (
        cacheReadTokens === undefined
        && noCacheTokens === undefined
        && cacheWriteTokens === undefined
    ) {
        return undefined;
    }

    const resolvedCacheReadTokens = cacheReadTokens ?? 0;
    const resolvedNoCacheTokens = noCacheTokens ?? Math.max(0, inputTokens - resolvedCacheReadTokens);

    return {
        noCacheTokens: resolvedNoCacheTokens,
        cacheReadTokens: resolvedCacheReadTokens,
        cacheWriteTokens: cacheWriteTokens ?? 0,
    };
};

export const parseOutputTokenDetails = (
    record: Record<string, unknown>,
    outputTokens: number,
): NonNullable<NonNullable<TDoneTokenSnapshot['usage']>['outputTokenDetails']> | undefined => {
    const outputTokenDetailsRecord = toRecord(record.outputTokenDetails);
    const raw = toRecord(record.raw);
    const rawCompletionTokenDetails = toRecord(raw?.completion_tokens_details);
    const textTokens = toNonNegativeFiniteNumber(outputTokenDetailsRecord?.textTokens);
    const reasoningTokens = toNonNegativeFiniteNumber(outputTokenDetailsRecord?.reasoningTokens)
        ?? toNonNegativeFiniteNumber(record.reasoningTokens)
        ?? toNonNegativeFiniteNumber(rawCompletionTokenDetails?.reasoning_tokens);

    if (textTokens === undefined && reasoningTokens === undefined) {
        return undefined;
    }

    const resolvedReasoningTokens = reasoningTokens ?? 0;

    return {
        textTokens: textTokens ?? Math.max(0, outputTokens - resolvedReasoningTokens),
        reasoningTokens: resolvedReasoningTokens,
    };
};

export const aggregateDoneTokenSnapshot = (
    current: TDoneTokenSnapshot | undefined,
    next: TDoneTokenSnapshot,
): TDoneTokenSnapshot => {
    if (!current) {
        return next;
    }

    const promptTokens = sumTokenCounts(current.promptTokens, next.promptTokens);
    const completionTokens = sumTokenCounts(current.completionTokens, next.completionTokens);
    const totalTokens = sumTokenCounts(current.totalTokens, next.totalTokens);
    const currentUsage = current.usage ?? undefined;
    const nextUsage = next.usage ?? undefined;
    const inputTokenDetails = currentUsage?.inputTokenDetails || nextUsage?.inputTokenDetails
        ? {
            noCacheTokens: sumTokenCounts(
                currentUsage?.inputTokenDetails?.noCacheTokens,
                nextUsage?.inputTokenDetails?.noCacheTokens,
            ) ?? 0,
            cacheReadTokens: sumTokenCounts(
                currentUsage?.inputTokenDetails?.cacheReadTokens,
                nextUsage?.inputTokenDetails?.cacheReadTokens,
            ) ?? 0,
            cacheWriteTokens: sumTokenCounts(
                currentUsage?.inputTokenDetails?.cacheWriteTokens,
                nextUsage?.inputTokenDetails?.cacheWriteTokens,
            ) ?? 0,
        }
        : undefined;
    const outputTokenDetails = currentUsage?.outputTokenDetails || nextUsage?.outputTokenDetails
        ? {
            textTokens: sumTokenCounts(
                currentUsage?.outputTokenDetails?.textTokens,
                nextUsage?.outputTokenDetails?.textTokens,
            ) ?? 0,
            reasoningTokens: sumTokenCounts(
                currentUsage?.outputTokenDetails?.reasoningTokens,
                nextUsage?.outputTokenDetails?.reasoningTokens,
            ) ?? 0,
        }
        : undefined;
    const cachedInputTokens = sumTokenCounts(
        currentUsage?.cachedInputTokens,
        nextUsage?.cachedInputTokens,
    );
    const reasoningTokens = sumTokenCounts(
        currentUsage?.reasoningTokens,
        nextUsage?.reasoningTokens,
    );

    return {
        ...(promptTokens !== undefined ? { promptTokens } : {}),
        ...(completionTokens !== undefined ? { completionTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        usage: {
            inputTokens: sumRequiredTokenCounts(currentUsage?.inputTokens, nextUsage?.inputTokens),
            ...(inputTokenDetails ? { inputTokenDetails } : {}),
            outputTokens: sumRequiredTokenCounts(currentUsage?.outputTokens, nextUsage?.outputTokens),
            ...(outputTokenDetails ? { outputTokenDetails } : {}),
            totalTokens: sumRequiredTokenCounts(currentUsage?.totalTokens, nextUsage?.totalTokens),
            ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        },
    };
};

export const parseDoneTokenSnapshot = (value: unknown): TDoneTokenSnapshot | undefined => {
    const record = toRecord(value);

    if (!record) {
        return undefined;
    }

    const inputTokens = toNonNegativeFiniteNumber(record.inputTokens);
    const outputTokens = toNonNegativeFiniteNumber(record.outputTokens);
    const totalTokens = toNonNegativeFiniteNumber(record.totalTokens);

    if (
        inputTokens === undefined
        || outputTokens === undefined
        || totalTokens === undefined
    ) {
        return undefined;
    }

    const inputTokenDetails = parseInputTokenDetails(record, inputTokens);
    const outputTokenDetails = parseOutputTokenDetails(record, outputTokens);
    const cachedInputTokens = toNonNegativeFiniteNumber(record.cachedInputTokens);
    const reasoningTokens = toNonNegativeFiniteNumber(record.reasoningTokens);

    return {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens,
        usage: {
            inputTokens,
            outputTokens,
            totalTokens,
            ...(inputTokenDetails ? { inputTokenDetails } : {}),
            ...(outputTokenDetails ? { outputTokenDetails } : {}),
            ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
            ...('raw' in record ? { raw: record.raw } : {}),
        },
    };
};

export const isFinishChunk = (chunk: TMastraStreamChunk): chunk is TMastraFinishChunk => chunk.type === 'finish';

export const extractFinishTokenSnapshot = (chunk: TMastraStreamChunk): TDoneTokenSnapshot | undefined =>
    isFinishChunk(chunk)
        ? parseDoneTokenSnapshot(chunk.payload.output?.usage)
        : undefined;

export const isOmDataChunk = (chunk: TMastraStreamChunk): chunk is TOmDataChunk =>
    chunk.type === 'data-om-activation' || chunk.type === 'data-om-observation-end';

export const createOmMemoryCompressedEventDraft = (chunk: TMastraStreamChunk): TOmMemoryCompressedEventDraft | null => {
    if (!isOmDataChunk(chunk)) {
        return null;
    }

    const data = toRecord(chunk.data);
    const operationType = data?.operationType;

    if (!data || !isOmOperationType(operationType)) {
        return null;
    }

    const tokensActivated = chunk.type === 'data-om-activation'
        ? toFiniteNumber(data.tokensActivated)
        : toFiniteNumber(data.tokensObserved);
    const observationTokens = toFiniteNumber(data.observationTokens);
    const messagesActivated = toFiniteNumber(data.messagesActivated);
    const chunksActivated = toFiniteNumber(data.chunksActivated);
    const durationMs = toFiniteNumber(data.durationMs);
    const triggeredBy = isOmActivationTrigger(data.triggeredBy) ? data.triggeredBy : undefined;

    return {
        type: 'acontext.memory.compressed',
        visibility: 'user',
        level: 'info',
        operationType,
        ...(tokensActivated !== undefined ? { tokensActivated } : {}),
        ...(observationTokens !== undefined ? { observationTokens } : {}),
        ...(messagesActivated !== undefined ? { messagesActivated } : {}),
        ...(chunksActivated !== undefined ? { chunksActivated } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(triggeredBy ? { triggeredBy } : {}),
    };
};
