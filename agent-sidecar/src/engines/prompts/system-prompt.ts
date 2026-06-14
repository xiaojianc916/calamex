import type { IAgentStreamResult } from '../../streaming/stream-runtime-contract.js';
import type { IAgentRuntimeInput } from '../contracts/runtime-input.js';
import { assembleSystemPromptContext, UNSPECIFIED_MODEL_LABEL } from './domain/system-prompt-context.js';
import { renderSystemPrompt } from './templates/system-prompt.template.js';

/**
 * 构建系统提示词。装配（strong-typed context）与渲染（Handlebars 严格模板）分离，
 * 实现见 ./domain 与 ./templates；本文件保留为稳定的对外入口，调用方无需改动。
 */
export const buildSystemPrompt = (
    input: IAgentRuntimeInput,
    modelId: string = UNSPECIFIED_MODEL_LABEL,
): string => renderSystemPrompt(assembleSystemPromptContext(input, modelId));

export const extractVisibleAgentResultText = (result: IAgentStreamResult): string => {
    const lastMessage = result.lastMessage;
    if (!lastMessage || !Array.isArray(lastMessage.content)) return '';

    const textParts: string[] = [];
    for (const block of lastMessage.content) {
        if (block.type !== 'textBlock') continue;
        if (typeof block.text !== 'string') continue;
        if (block.text.trim().length === 0) continue;
        textParts.push(block.text);
    }
    // 显式选择无分隔：流式过程中多个 textBlock 通常是同一段文本被分片，
    // 用空字符串拼回最贴近原文。
    return textParts.join('').trim();
};
