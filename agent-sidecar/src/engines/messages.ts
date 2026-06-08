import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import type { ToolCallPayload } from '@mastra/core/stream';
import {
    buildMastraMessages,
    buildMastraUserPrompt,
    findLastUserMessage,
    hasImageAttachmentParts,
    isVisionModelId,
} from './session/session-messages.js';
import { toNonEmptyString, toRecord } from './utils.js';

export {
    buildMastraMessages,
    buildMastraUserPrompt,
    findLastUserMessage,
    hasImageAttachmentParts,
    isVisionModelId,
};

export const formatApprovalSummary = (payload: ToolCallPayload): string => {
    if (payload.args === undefined) {
        return `${payload.toolName} 请求执行，但当前没有可展示的参数。`;
    }

    if (payload.toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND) {
        const command = toNonEmptyString(toRecord(payload.args)?.command);
        return command
            ? `请求执行命令：${command}`
            : '请求执行命令，请确认是否继续。';
    }

    return `${payload.toolName} 请求执行，参数内容已收敛显示，请确认是否继续。`;
};

export const normalizeMastraError = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }

    const message = toRecord(error)?.message;
    return typeof message === 'string' && message.trim().length > 0
        ? message
        : String(error);
};
