import { REASONING_SEGMENT_CHARS } from './constants';
import type {
  IInlineMarkdownToken,
  IReasoningMarkdownBlock,
  TInlineMarkdownTokenKind,
} from './types';

const inlineMarkdownTokenCache = new Map<string, IInlineMarkdownToken[]>();
const reasoningMarkdownBlockCache = new Map<string, IReasoningMarkdownBlock[]>();

export const splitReasoningSegments = (value: string): string[] => {
  const normalized = value.trim();

  if (!normalized) {
    return [];
  }

  if (/^\s{0,3}(```+|~~~+)/mu.test(normalized)) {
    return [normalized];
  }

  const paragraphs = normalized
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const segments: string[] = [];

  for (const paragraph of paragraphs) {
    const chars = Array.from(paragraph);

    if (chars.length <= REASONING_SEGMENT_CHARS) {
      segments.push(paragraph);
      continue;
    }

    for (let cursor = 0; cursor < chars.length; cursor += REASONING_SEGMENT_CHARS) {
      segments.push(chars.slice(cursor, cursor + REASONING_SEGMENT_CHARS).join(''));
    }
  }

  return segments;
};

const pushInlineMarkdownToken = (
  tokens: IInlineMarkdownToken[],
  kind: TInlineMarkdownTokenKind,
  text: string,
): void => {
  if (!text) {
    return;
  }

  const previous = tokens.at(-1);
  if (previous?.kind === kind) {
    previous.text += text;
    return;
  }

  tokens.push({ kind, text });
};

const findNextSingleAsterisk = (value: string, startIndex: number): number => {
  for (let index = startIndex; index < value.length; index += 1) {
    if (value[index] !== '*') {
      continue;
    }

    if (value[index - 1] === '*' || value[index + 1] === '*') {
      continue;
    }

    return index;
  }

  return -1;
};

export const tokenizeInlineMarkdown = (value: string): IInlineMarkdownToken[] => {
  const cached = inlineMarkdownTokenCache.get(value);
  if (cached) {
    return cached;
  }

  const tokens: IInlineMarkdownToken[] = [];
  let plainBuffer = '';
  let index = 0;

  const flushPlain = (): void => {
    pushInlineMarkdownToken(tokens, 'text', plainBuffer);
    plainBuffer = '';
  };

  while (index < value.length) {
    if (value[index] === '`') {
      const endIndex = value.indexOf('`', index + 1);
      if (endIndex > index + 1) {
        flushPlain();
        pushInlineMarkdownToken(tokens, 'code', value.slice(index + 1, endIndex));
        index = endIndex + 1;
        continue;
      }
    }

    if (value.startsWith('**', index)) {
      const endIndex = value.indexOf('**', index + 2);
      if (endIndex > index + 2) {
        flushPlain();
        pushInlineMarkdownToken(tokens, 'strong', value.slice(index + 2, endIndex));
        index = endIndex + 2;
        continue;
      }
    }

    if (value[index] === '*' && value[index + 1] !== '*' && value[index - 1] !== '*') {
      const endIndex = findNextSingleAsterisk(value, index + 1);
      if (endIndex > index + 1) {
        flushPlain();
        pushInlineMarkdownToken(tokens, 'emphasis', value.slice(index + 1, endIndex));
        index = endIndex + 1;
        continue;
      }
    }

    plainBuffer += value[index];
    index += 1;
  }

  flushPlain();

  if (inlineMarkdownTokenCache.size > 240) {
    inlineMarkdownTokenCache.clear();
  }

  inlineMarkdownTokenCache.set(value, tokens);
  return tokens;
};

const isReasoningHeadingLine = (line: string): boolean => {
  if (line.includes('://')) {
    return false;
  }

  if (/^\s{0,3}#{1,6}\s+\S/u.test(line)) {
    return true;
  }

  const trimmed = line.trim();
  return trimmed.length > 1 && trimmed.length <= 80 && /[:：]$/u.test(trimmed);
};

const normalizeReasoningHeadingText = (line: string): string =>
  line
    .trim()
    .replace(/^\s{0,3}#{1,6}\s+/u, '')
    .replace(/\s+#*\s*$/u, '');

const resolveFenceLanguage = (info: string): string => info.trim().split(/\s+/u, 1)[0] ?? '';

const isClosingFenceLine = (line: string, openingFence: string): boolean => {
  const match = /^\s{0,3}(```+|~~~+)\s*$/u.exec(line);

  return Boolean(
    match && match[1][0] === openingFence[0] && match[1].length >= openingFence.length,
  );
};

export const parseReasoningMarkdownBlocks = (segment: string): IReasoningMarkdownBlock[] => {
  const cached = reasoningMarkdownBlockCache.get(segment);
  if (cached) {
    return cached;
  }

  const blocks: IReasoningMarkdownBlock[] = [];
  const paragraphLines: string[] = [];
  let listType: 'ordered-list' | 'unordered-list' | undefined;
  let listItems: string[] = [];
  let codeFence: string | null = null;
  let codeFenceInfo = '';
  let codeLines: string[] = [];

  const pushBlock = (block: Omit<IReasoningMarkdownBlock, 'id'>): void => {
    blocks.push({
      ...block,
      id: `${blocks.length}:${block.type}`,
    });
  };

  const flushParagraph = (): void => {
    const text = paragraphLines.join('\n').trim();
    paragraphLines.length = 0;

    if (text) {
      pushBlock({ type: 'paragraph', text });
    }
  };

  const flushList = (): void => {
    if (listType && listItems.length > 0) {
      pushBlock({ type: listType, items: listItems });
    }

    listType = undefined;
    listItems = [];
  };

  const flushInlineBlocks = (): void => {
    flushParagraph();
    flushList();
  };

  const flushCodeBlock = (): void => {
    if (!codeFence) {
      return;
    }

    pushBlock({
      type: 'code-block',
      code: codeLines.join('\n'),
      language: resolveFenceLanguage(codeFenceInfo),
      info: codeFenceInfo,
    });

    codeFence = null;
    codeFenceInfo = '';
    codeLines = [];
  };

  for (const line of segment.replace(/\r\n?/gu, '\n').split('\n')) {
    if (codeFence) {
      if (isClosingFenceLine(line, codeFence)) {
        flushCodeBlock();
        continue;
      }

      codeLines.push(line);
      continue;
    }

    const codeFenceMatch = /^\s{0,3}(```+|~~~+)(.*)$/u.exec(line);
    if (codeFenceMatch) {
      flushInlineBlocks();
      codeFence = codeFenceMatch[1];
      codeFenceInfo = codeFenceMatch[2].trim();
      codeLines = [];
      continue;
    }

    const trimmed = line.trim();

    if (!trimmed) {
      flushInlineBlocks();
      continue;
    }

    const unorderedMatch = /^\s{0,3}[-*+]\s+(.+)$/u.exec(line);
    if (unorderedMatch) {
      flushParagraph();

      if (listType !== 'unordered-list') {
        flushList();
        listType = 'unordered-list';
      }

      listItems.push(unorderedMatch[1].trim());
      continue;
    }

    const orderedMatch = /^\s{0,3}\d+[.)]\s+(.+)$/u.exec(line);
    if (orderedMatch) {
      flushParagraph();

      if (listType !== 'ordered-list') {
        flushList();
        listType = 'ordered-list';
      }

      listItems.push(orderedMatch[1].trim());
      continue;
    }

    const quoteMatch = /^\s{0,3}>\s?(.+)$/u.exec(line);
    if (quoteMatch) {
      flushInlineBlocks();
      pushBlock({ type: 'quote', text: quoteMatch[1].trim() });
      continue;
    }

    if (isReasoningHeadingLine(line)) {
      flushInlineBlocks();
      pushBlock({ type: 'heading', text: normalizeReasoningHeadingText(line) });
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushInlineBlocks();
  flushCodeBlock();

  if (reasoningMarkdownBlockCache.size > 240) {
    reasoningMarkdownBlockCache.clear();
  }

  reasoningMarkdownBlockCache.set(segment, blocks);
  return blocks;
};
