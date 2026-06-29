import { RequestContext } from '@mastra/core/request-context';
import type { TJsonValue } from '../../schemas/events.js';
import { RUNTIME_TOOL_PREVIEW_CHARS, TOOL_PREVIEW_REDACTED_TEXT, type IMastraExecutableToolLike, type IMcpGatewayMetricLogger, type TMastraRequestContext, type TMastraRequestContextValues } from './types.js';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import type { McpGatewayMetricBuffer } from '../../tools/mcp/index.js';
import { createAgentRuntimeEvent, type IAgentRuntimeEventContext, type TAgentRuntimeEventDraft } from '../../streaming/stream-types.js';
import type { IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from '../contracts/runtime-contracts.js';
import { shouldRedactWorkspacePreview } from '../workspace/workspace.js';

export const createSessionId = (prefix: string): string =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export const APPROVAL_TOKEN_PREFIX = 'mastra-approval.';

export const isNodeTestProcess = (): boolean => Boolean(process.env.NODE_TEST_CONTEXT);

export const toRecord = (value: unknown): Record<string, unknown> | null => (
    value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
);

export const isExecutableToolLike = (tool: unknown): tool is IMastraExecutableToolLike =>
    typeof toRecord(tool)?.execute === 'function';

export const toNonEmptyString = (value: unknown): string | null => {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

export const isRequestContextLike = (value: unknown): value is {
    all?: unknown;
    entries?: () => Iterable<readonly [string, unknown]>;
    toJSON?: () => unknown;
} => Boolean(value && typeof value === 'object');

export const requestContextToRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value) {
        return null;
    }

    if (isRequestContextLike(value)) {
        if (typeof value.toJSON === 'function') {
            const jsonValue = toRecord(value.toJSON());
            if (jsonValue) {
                return jsonValue;
            }
        }

        const allValue = toRecord(value.all);
        if (allValue) {
            return allValue;
        }

        if (typeof value.entries === 'function') {
            return Object.fromEntries(value.entries());
        }
    }

    return toRecord(value);
};

export const createMastraRequestContext = (
    values: Record<string, unknown>,
): TMastraRequestContext => new RequestContext<TMastraRequestContextValues>(
    Object.entries(values),
);

export const toJsonValue = (value: unknown): TJsonValue => {
    if (
        value === null
        || typeof value === 'string'
        || typeof value === 'number'
        || typeof value === 'boolean'
    ) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => toJsonValue(item));
    }

    const record = toRecord(value);
    if (!record) {
        return String(value);
    }

    return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [key, toJsonValue(item)]),
    );
};

export const stringifyJsonValue = (value: TJsonValue): string => {
    if (typeof value === 'string') {
        return value;
    }

    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
};

export const createRuntimePreview = (
    value: unknown,
    limit = RUNTIME_TOOL_PREVIEW_CHARS,
): string => {
    const normalized = stringifyJsonValue(toJsonValue(value))
        .replace(/\s+/gu, ' ')
        .trim();

    if (!normalized) {
        return '';
    }

    // 只扫描到第 limit 个码位即可判定是否需要截断，避免对超长 tool 预览整段物化成码位数组。
    const prefix: string[] = [];
    let truncated = false;
    for (const char of normalized) {
        if (prefix.length >= limit) {
            truncated = true;
            break;
        }
        prefix.push(char);
    }

    return truncated ? `${prefix.join('')}...` : normalized;
};

export const createCommandRuntimeInputPreview = (value: unknown): string => {
    const record = toRecord(value);
    if (!record) {
        return createRuntimePreview(value);
    }

    const command = toNonEmptyString(record.command);
    if (!command) {
        return createRuntimePreview(value);
    }

    return createRuntimePreview({
        command,
        ...(toNonEmptyString(record.cwd) ? { cwd: toNonEmptyString(record.cwd) } : {}),
        ...(typeof record.timeout === 'number' ? { timeout: record.timeout } : {}),
        ...(typeof record.tail === 'number' ? { tail: record.tail } : {}),
        ...(typeof record.background === 'boolean' ? { background: record.background } : {}),
    });
};

export const createCommandRuntimeResultPreview = (value: unknown): string => {
    const record = toRecord(value);
    if (!record) {
        return createRuntimePreview(value);
    }

    const preview: Record<string, unknown> = {};

    for (const key of [
        'command',
        'stdout',
        'stderr',
        'exitCode',
        'executionTimeMs',
        'success',
        'timedOut',
        'killed',
        'stdoutTruncated',
        'stderrTruncated',
        'stdoutDroppedBytes',
        'stderrDroppedBytes',
    ]) {
        if (record[key] !== undefined) {
            preview[key] = record[key];
        }
    }

    return Object.keys(preview).length > 0
        ? createRuntimePreview(preview)
        : createRuntimePreview(value);
};

export const createWorkspaceRuntimeInputPreview = (toolName: string, value: unknown): string => {
    if (value === undefined) {
        return '';
    }

    if (toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND) {
        return createCommandRuntimeInputPreview(value);
    }

    return shouldRedactWorkspacePreview(toolName)
        ? TOOL_PREVIEW_REDACTED_TEXT
        : createRuntimePreview(value);
};

export const createWorkspaceRuntimeResultPreview = (toolName: string, value: unknown): string => {
    if (toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND) {
        return createCommandRuntimeResultPreview(value);
    }

    return shouldRedactWorkspacePreview(toolName)
        ? TOOL_PREVIEW_REDACTED_TEXT
        : createRuntimePreview(value);
};

export const pushUiEvent = (
    events: TAgentRuntimeOutputEvent[],
    event: TAgentRuntimeOutputEvent,
    options: IAgentRuntimeRunOptions = {},
): void => {
    events.push(event);
    options.onEvent?.(event);
};

export const createRuntimeEventFactory = (
    context: IAgentRuntimeEventContext,
): ((draft: TAgentRuntimeEventDraft) => TAgentRuntimeOutputEvent) => {
    let seq = 0;

    return (draft) => ({
        type: 'agent_event',
        event: createAgentRuntimeEvent(context, seq++, draft),
    });
};

export const attachMcpGatewayMetrics = (
    metricBuffer: McpGatewayMetricBuffer,
    logger: IMcpGatewayMetricLogger,
): void => {
    metricBuffer.setListener((metric) => {
        switch (metric.type) {
            case 'mcp_gateway.boot':
            case 'mcp_gateway.catalog':
                logger.info({
                    type: metric.type,
                    serverName: metric.serverName,
                    durationMs: metric.durationMs,
                    activeBundleCount: metric.activeBundleCount,
                    warmBundleCount: metric.warmBundleCount,
                    toolCount: metric.toolCount,
                    errorCount: metric.errorCount,
                    ...(metric.type === 'mcp_gateway.catalog'
                        ? { profile: metric.profile, cacheHit: metric.cacheHit }
                        : {}),
                }, '[mcp-gateway] metric');
                return;
            case 'mcp_gateway.call':
                logger.info({
                    type: metric.type,
                    serverName: metric.serverName,
                    requestedToolName: metric.requestedToolName,
                    resolvedToolName: metric.resolvedToolName,
                    durationMs: metric.durationMs,
                    activeBundleCount: metric.activeBundleCount,
                    warmBundleCount: metric.warmBundleCount,
                    toolCallCount: metric.toolCallCount,
                    errorCount: metric.errorCount,
                }, '[mcp-gateway] metric');
                return;
            case 'mcp_gateway.boot_failed':
                logger.warn({
                    type: metric.type,
                    serverName: metric.serverName,
                    durationMs: metric.durationMs,
                    errorMessage: metric.errorMessage,
                }, '[mcp-gateway] boot failed');
                return;
            case 'mcp_gateway.metric_buffer_dropped':
                logger.warn({
                    type: metric.type,
                    droppedCount: metric.droppedCount,
                }, '[mcp-gateway] metric buffer overflow');
                return;
        }
    });
};
