import {
  EXPLICIT_CONTEXT_MESSAGE_LIMIT,
  type TMastraChatMessage,
  type TMastraImagePart,
  type TMastraTextPart,
  type TMastraUserContent,
} from '../types.js';
import type { IAgentContextReferenceInput, IAgentMessageInput, IAgentRuntimeInput } from '../contracts/runtime-input.js';
import { toRecord } from '../utils.js';

const IMAGE_ATTACHMENT_MODEL_PART_MARKER = 'AI_SDK_IMAGE_PART_JSON:';
const SUPPORTED_IMAGE_PART_SOURCE_PATTERN = /^(?:data:image\/[a-z0-9.+-]+;base64,|https?:\/\/|file:\/\/)/iu;

export const COMPACTION_HANDOFF_PROMPT = `You are compacting this conversation into a handoff for another agent that will resume the work.

Include:
- Goal: what the user is ultimately trying to achieve
- State: progress so far, current blockers, and decisions made
- Context: constraints, preferences, and critical data/examples/references needed to continue
- Next: the specific steps that remain
- Pitfalls: anything tried that didn't work

Write it so the next agent can act without re-asking the user. Be concise and well-structured.`;

export const COMPACTION_RESUME_USER_MESSAGE_PREFIX = 'The previous conversation was compacted. Use this summary as context:';

export type TAgentSessionMessageKind = 'user' | 'assistant' | 'system' | 'tool' | 'compaction';
export type TAgentSessionMessageSource = 'conversation' | 'prompt' | 'runtime' | 'compaction';

export interface IAgentSessionMessageBase {
  readonly id: string;
  readonly kind: TAgentSessionMessageKind;
  readonly source: TAgentSessionMessageSource;
}

export interface IAgentSessionUserMessage extends IAgentSessionMessageBase {
  readonly kind: 'user';
  readonly content: TMastraUserContent;
}

export interface IAgentSessionAssistantMessage extends IAgentSessionMessageBase {
  readonly kind: 'assistant';
  readonly content: string;
}

export interface IAgentSessionSystemMessage extends IAgentSessionMessageBase {
  readonly kind: 'system';
  readonly content: string;
}

export interface IAgentSessionToolMessage extends IAgentSessionMessageBase {
  readonly kind: 'tool';
  readonly content: string;
  readonly toolCallId?: string | undefined;
  readonly name?: string | undefined;
}

export interface IAgentSessionCompactionMessage extends IAgentSessionMessageBase {
  readonly kind: 'compaction';
  readonly source: 'compaction';
  readonly summary: string;
}

export type TAgentSessionMessage =
  | IAgentSessionUserMessage
  | IAgentSessionAssistantMessage
  | IAgentSessionSystemMessage
  | IAgentSessionToolMessage
  | IAgentSessionCompactionMessage;

type TImagePartCarrier = {
  type: 'image';
  image: string;
  mediaType?: string;
};

const isTextPart = (part: unknown): part is TMastraTextPart => {
  const record = toRecord(part);
  return record?.type === 'text' && typeof record.text === 'string';
};

export const getSessionMessageText = (
  content: IAgentMessageInput['content'] | TMastraChatMessage['content'],
): string => {
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

export const buildCompactionResumeUserPrompt = (summary: string): string => {
  const trimmedSummary = summary.trim();

  return trimmedSummary.length > 0
    ? `${COMPACTION_RESUME_USER_MESSAGE_PREFIX}\n\n${trimmedSummary}`
    : COMPACTION_RESUME_USER_MESSAGE_PREFIX;
};

export const createAgentSessionCompactionMessage = (input: {
  id: string;
  summary: string;
}): IAgentSessionCompactionMessage => ({
  id: input.id,
  kind: 'compaction',
  source: 'compaction',
  summary: input.summary.trim(),
});

const parseImagePartCarrier = (line: string): TImagePartCarrier | null => {
  const markerIndex = line.indexOf(IMAGE_ATTACHMENT_MODEL_PART_MARKER);

  if (markerIndex < 0) {
    return null;
  }

  const rawJson = line.slice(markerIndex + IMAGE_ATTACHMENT_MODEL_PART_MARKER.length).trim();

  if (!rawJson) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(rawJson);
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
  } catch {
    return null;
  }
};

export const buildImagePartsFromContext = (
  contextReferences: readonly IAgentContextReferenceInput[] | undefined,
): TMastraImagePart[] => {
  const imageParts: TMastraImagePart[] = [];
  const seenSources = new Set<string>();

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

const buildUserContentWithImages = (
  text: string,
  imageParts: readonly TMastraImagePart[],
): TMastraUserContent => {
  if (imageParts.length === 0) {
    return text;
  }

  const textPart: TMastraTextPart = {
    type: 'text',
    text: text.trim() || '请分析这些图片附件。',
  };

  return [textPart, ...imageParts];
};

const withImagePartsOnUserMessage = (
  message: TAgentSessionMessage,
  imageParts: readonly TMastraImagePart[],
): TAgentSessionMessage => {
  if (message.kind !== 'user' || imageParts.length === 0) {
    return message;
  }

  return {
    ...message,
    content: buildUserContentWithImages(getSessionMessageText(message.content), imageParts),
  };
};

export const hasImageAttachmentParts = (
  contextReferences: readonly IAgentContextReferenceInput[] | undefined,
): boolean => buildImagePartsFromContext(contextReferences).length > 0;

export const isVisionModelId = (modelId: string): boolean => {
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

export const findLastUserMessage = (messages: readonly IAgentMessageInput[]): IAgentMessageInput | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role === 'user') {
      return message;
    }
  }

  return null;
};

export const buildMastraUserPrompt = (input: IAgentRuntimeInput): string => {
  const lastUserContent = getSessionMessageText(findLastUserMessage(input.messages)?.content ?? '').trim();
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

const createConversationSessionMessages = (
  inputMessages: readonly IAgentMessageInput[],
): TAgentSessionMessage[] => inputMessages
  .map<TAgentSessionMessage | null>((message, index) => {
    const content = getSessionMessageText(message.content).trim();

    if (!content) {
      return null;
    }

    if (message.role === 'user') {
      return {
        id: `runtime-message:${index}`,
        kind: 'user',
        source: 'conversation',
        content,
      };
    }

    if (message.role === 'assistant') {
      return {
        id: `runtime-message:${index}`,
        kind: 'assistant',
        source: 'conversation',
        content,
      };
    }

    if (message.role === 'tool') {
      return {
        id: `runtime-message:${index}`,
        kind: 'tool',
        source: 'conversation',
        content,
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.name ? { name: message.name } : {}),
      };
    }

    return {
      id: `runtime-message:${index}`,
      kind: 'system',
      source: 'conversation',
      content,
    };
  })
  .filter((message): message is TAgentSessionMessage => message !== null)
  .slice(-EXPLICIT_CONTEXT_MESSAGE_LIMIT);

export const createAgentSessionMessagesFromRuntimeInput = (
  input: IAgentRuntimeInput,
): TAgentSessionMessage[] => {
  const userPrompt = buildMastraUserPrompt(input).trim();
  const imageParts = buildImagePartsFromContext(input.context);
  const conversationMessages = createConversationSessionMessages(input.messages)
    .filter((message): message is IAgentSessionUserMessage | IAgentSessionAssistantMessage =>
      message.kind === 'user' || message.kind === 'assistant');

  if (conversationMessages.length === 0) {
    return [{
      id: 'runtime-prompt',
      kind: 'user',
      source: 'prompt',
      content: buildUserContentWithImages(
        userPrompt.length > 0
          ? userPrompt
          : (input.goal.trim().length > 0 ? input.goal : '继续。'),
        imageParts,
      ),
    }];
  }

  if (userPrompt.length === 0) {
    for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
      if (conversationMessages[index]?.kind === 'user') {
        return conversationMessages.map((message, messageIndex) =>
          messageIndex === index ? withImagePartsOnUserMessage(message, imageParts) : message);
      }
    }

    return conversationMessages;
  }

  for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
    if (conversationMessages[index]?.kind === 'user') {
      return conversationMessages.map((message, messageIndex) =>
        messageIndex === index
          ? {
            ...message,
            source: 'prompt',
            content: buildUserContentWithImages(userPrompt, imageParts),
          }
          : message);
    }
  }

  return [
    ...conversationMessages,
    {
      id: 'runtime-prompt',
      kind: 'user',
      source: 'prompt',
      content: buildUserContentWithImages(userPrompt, imageParts),
    },
  ];
};

export const buildMastraMessagesFromSessionMessages = (
  messages: readonly TAgentSessionMessage[],
): TMastraChatMessage[] => messages
  .flatMap<TMastraChatMessage>((message) => {
    if (message.kind === 'user' || message.kind === 'assistant') {
      return [{
        role: message.kind,
        content: message.content,
      }];
    }

    if (message.kind === 'compaction') {
      return [{
        role: 'user',
        content: buildCompactionResumeUserPrompt(message.summary),
      }];
    }

    return [];
  });

export const buildMastraMessages = (input: IAgentRuntimeInput): TMastraChatMessage[] =>
  buildMastraMessagesFromSessionMessages(createAgentSessionMessagesFromRuntimeInput(input));
