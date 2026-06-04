import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { EXPLICIT_CONTEXT_MESSAGE_LIMIT, } from './types.js';
import { toNonEmptyString, toRecord } from './utils.js';
const IMAGE_ATTACHMENT_MODEL_PART_MARKER = 'AI_SDK_IMAGE_PART_JSON:';
const SUPPORTED_IMAGE_PART_SOURCE_PATTERN = /^(?:data:image\/[a-z0-9.+-]+;base64,|https?:\/\/|file:\/\/)/iu;
const isTextPart = (part) => {
    const record = toRecord(part);
    return record?.type === 'text' && typeof record.text === 'string';
};
const getContentText = (content) => {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .filter(isTextPart)
        .map((part) => part.text)
        .join('\n');
};
const parseImagePartCarrier = (line) => {
    const markerIndex = line.indexOf(IMAGE_ATTACHMENT_MODEL_PART_MARKER);
    if (markerIndex < 0) {
        return null;
    }
    const rawJson = line.slice(markerIndex + IMAGE_ATTACHMENT_MODEL_PART_MARKER.length).trim();
    if (!rawJson) {
        return null;
    }
    try {
        const parsed = JSON.parse(rawJson);
        const record = toRecord(parsed);
        const image = typeof record?.image === 'string' ? record.image.trim() : '';
        const mediaType = typeof record?.mediaType === 'string' ? record.mediaType.trim() : '';
        if (record?.type !== 'image' || !SUPPORTED_IMAGE_PART_SOURCE_PATTERN.test(image)) {
            return null;
        }
        return {
            type: 'image',
            image,
            ...(mediaType ? { mediaType } : {}),
        };
    }
    catch {
        return null;
    }
};
const buildImagePartsFromContext = (contextReferences) => {
    const imageParts = [];
    const seenSources = new Set();
    for (const reference of contextReferences ?? []) {
        if (reference.kind !== 'image-attachment') {
            continue;
        }
        for (const line of reference.contentPreview.split('\n')) {
            const carrier = parseImagePartCarrier(line);
            if (!carrier || seenSources.has(carrier.image)) {
                continue;
            }
            seenSources.add(carrier.image);
            imageParts.push({
                type: 'image',
                image: carrier.image,
                ...(carrier.mediaType ? { mediaType: carrier.mediaType } : {}),
            });
        }
    }
    return imageParts;
};
const buildUserContentWithImages = (text, imageParts) => {
    if (imageParts.length === 0) {
        return text;
    }
    const textPart = {
        type: 'text',
        text: text.trim() || '请分析这些图片附件。',
    };
    return [textPart, ...imageParts];
};
const withImagePartsOnUserMessage = (message, imageParts) => {
    if (message.role !== 'user' || imageParts.length === 0) {
        return message;
    }
    return {
        ...message,
        content: buildUserContentWithImages(getContentText(message.content), imageParts),
    };
};
export const hasImageAttachmentParts = (contextReferences) => buildImagePartsFromContext(contextReferences).length > 0;
export const isVisionModelId = (modelId) => {
    const normalized = modelId.trim().toLowerCase();
    if (!normalized) {
        return false;
    }
    if (normalized.includes('deepseek')) {
        return false;
    }
    return [
        'gpt-4o',
        'gpt-4.1',
        'gpt-5',
        'gemini',
        'claude-3',
        'claude-4',
        'qwen-vl',
        'qwen2-vl',
        'qwen2.5-vl',
        'qwen3-vl',
        'glm-4v',
        'vision',
        'vl-',
        '-vl',
    ].some((keyword) => normalized.includes(keyword));
};
export const findLastUserMessage = (messages) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'user') {
            return message;
        }
    }
    return null;
};
export const buildMastraUserPrompt = (input) => {
    const lastUserContent = getContentText(findLastUserMessage(input.messages)?.content ?? '').trim();
    const request = lastUserContent || input.goal.trim();
    const goal = request === input.goal ? '' : `目标：${input.goal}`;
    const outputContract = input.mode === 'plan'
        ? '输出格式：返回一个简洁的 json object，根对象必须直接包含 goal、steps；steps 只写短标题节点，不要包裹在 plan/result/data 字段里。'
        : '';
    return [
        outputContract,
        goal,
        request,
    ]
        .filter((line) => line.trim().length > 0)
        .join('\n');
};
export const buildMastraMessages = (input) => {
    const userPrompt = buildMastraUserPrompt(input).trim();
    const imageParts = buildImagePartsFromContext(input.context);
    const conversationMessages = input.messages
        .filter((message) => (message.role === 'user' || message.role === 'assistant')
        && getContentText(message.content).trim().length > 0)
        .map((message) => ({
        role: message.role,
        content: getContentText(message.content).trim(),
    }))
        .slice(-EXPLICIT_CONTEXT_MESSAGE_LIMIT);
    if (conversationMessages.length === 0) {
        return [{
                role: 'user',
                content: buildUserContentWithImages(userPrompt.length > 0
                    ? userPrompt
                    : (input.goal.trim().length > 0 ? input.goal : '继续。'), imageParts),
            }];
    }
    if (userPrompt.length === 0) {
        for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
            if (conversationMessages[index]?.role === 'user') {
                return conversationMessages.map((message, messageIndex) => messageIndex === index ? withImagePartsOnUserMessage(message, imageParts) : message);
            }
        }
        return conversationMessages;
    }
    for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
        if (conversationMessages[index]?.role === 'user') {
            return conversationMessages.map((message, messageIndex) => messageIndex === index
                ? {
                    role: 'user',
                    content: buildUserContentWithImages(userPrompt, imageParts),
                }
                : message);
        }
    }
    return [
        ...conversationMessages,
        { role: 'user', content: buildUserContentWithImages(userPrompt, imageParts) },
    ];
};
export const formatApprovalSummary = (payload) => {
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
export const normalizeMastraError = (error) => {
    if (error instanceof Error) {
        return error.message;
    }
    const message = toRecord(error)?.message;
    return typeof message === 'string' && message.trim().length > 0
        ? message
        : String(error);
};
