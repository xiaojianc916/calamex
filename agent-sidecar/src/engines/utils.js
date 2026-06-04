import { RequestContext } from '@mastra/core/request-context';
import { RUNTIME_TOOL_PREVIEW_CHARS, TOOL_PREVIEW_REDACTED_TEXT } from './types.js';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { createAgentRuntimeEvent } from '../streaming/stream-types.js';
import { shouldRedactWorkspacePreview } from './workspace.js';
export const createSessionId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
export const APPROVAL_TOKEN_PREFIX = 'mastra-approval.';
export const isNodeTestProcess = () => Boolean(process.env.NODE_TEST_CONTEXT);
export const toRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null);
export const isExecutableToolLike = (tool) => typeof toRecord(tool)?.execute === 'function';
export const toNonEmptyString = (value) => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};
export const isRequestContextLike = (value) => Boolean(value && typeof value === 'object');
export const requestContextToRecord = (value) => {
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
export const createMastraRequestContext = (values) => new RequestContext(Object.entries(values));
export const toJsonValue = (value) => {
    if (value === null
        || typeof value === 'string'
        || typeof value === 'number'
        || typeof value === 'boolean') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => toJsonValue(item));
    }
    const record = toRecord(value);
    if (!record) {
        return String(value);
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, toJsonValue(item)]));
};
export const stringifyJsonValue = (value) => {
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
};
export const createRuntimePreview = (value, limit = RUNTIME_TOOL_PREVIEW_CHARS) => {
    const normalized = stringifyJsonValue(toJsonValue(value))
        .replace(/\s+/gu, ' ')
        .trim();
    if (!normalized) {
        return '';
    }
    const characters = Array.from(normalized);
    const clipped = characters.length <= limit
        ? normalized
        : `${characters.slice(0, limit).join('')}...`;
    return clipped;
};
export const createCommandRuntimeInputPreview = (value) => {
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
export const createCommandRuntimeResultPreview = (value) => {
    const record = toRecord(value);
    if (!record) {
        return createRuntimePreview(value);
    }
    const preview = {};
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
export const createWorkspaceRuntimeInputPreview = (toolName, value) => {
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
export const createWorkspaceRuntimeResultPreview = (toolName, value) => {
    if (toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND) {
        return createCommandRuntimeResultPreview(value);
    }
    return shouldRedactWorkspacePreview(toolName)
        ? TOOL_PREVIEW_REDACTED_TEXT
        : createRuntimePreview(value);
};
export const pushUiEvent = (events, event, options = {}) => {
    events.push(event);
    options.onEvent?.(event);
};
export const createRuntimeEventFactory = (context) => {
    let seq = 0;
    return (draft) => ({
        type: 'agent_event',
        event: createAgentRuntimeEvent(context, seq++, draft),
    });
};
export const attachMcpGatewayMetrics = (metricBuffer, logger) => {
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
