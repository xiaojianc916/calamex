import { computed, readonly, ref, unref, type MaybeRef } from 'vue';
import { parseFenceInfo } from '@/services/modules/ai-code-detect';
import type { IAiCodeBlock, TAiSupportedLang } from '@/types/ai-code';

const MAX_STREAMING_CODE_BLOCK_CHARS = 64 * 1024;
const FENCE_LINE_PATTERN = /^```([^`]*)$/;

export type TStreamingFenceParserStatus = 'idle' | 'streaming' | 'completed' | 'cancelled';

export interface IAiStreamingFenceParserSnapshot {
  messageId: string;
  status: TStreamingFenceParserStatus;
  blocks: IAiCodeBlock[];
  openBlock: IAiCodeBlock | null;
  closedBlockIds: string[];
  stableContent: string;
}

interface IParsedFenceBlock {
  rawInfo: string;
  content: string;
  closed: boolean;
}

interface IParsedFenceResult {
  blocks: IParsedFenceBlock[];
  openBlockStartOffset: number | null;
}

const textEncoder = new TextEncoder();

const splitPreserveLineBreaks = (value: string): string[] => {
  const matches = value.match(/.*(?:\r\n|\n|\r|$)/g) ?? [];
  return matches.filter((line) => line.length > 0);
};

const stripLineBreak = (value: string): string => value.replace(/(?:\r\n|\n|\r)$/u, '');

const createCodeBlock = (
  messageId: string,
  index: number,
  parsed: IParsedFenceBlock,
  contextLang: TAiSupportedLang | undefined,
  isCancelled: boolean,
): IAiCodeBlock => {
  const chars = [...parsed.content];
  const truncated = chars.length > MAX_STREAMING_CODE_BLOCK_CHARS;
  const content = truncated ? chars.slice(0, MAX_STREAMING_CODE_BLOCK_CHARS).join('') : parsed.content;
  const streamState = isCancelled ? 'cancelled' : parsed.closed ? 'closed' : 'open';

  return {
    id: `${messageId}:${index}`,
    messageId,
    index,
    fence: parseFenceInfo(parsed.rawInfo, content, contextLang),
    content,
    closed: parsed.closed && !isCancelled,
    streamState,
    byteLength: textEncoder.encode(parsed.content).byteLength,
    truncated,
  };
};

const parseFences = (text: string): IParsedFenceResult => {
  const parsed: IParsedFenceBlock[] = [];
  let openBlock: IParsedFenceBlock | null = null;
  let offset = 0;
  let openBlockStartOffset: number | null = null;

  for (const line of splitPreserveLineBreaks(text)) {
    const lineStartOffset = offset;
    offset += line.length;
    const withoutBreak = stripLineBreak(line);
    const fenceMatch = FENCE_LINE_PATTERN.exec(withoutBreak);

    if (!openBlock) {
      if (!fenceMatch) continue;
      openBlockStartOffset = lineStartOffset;
      openBlock = {
        rawInfo: fenceMatch[1]?.trim() ?? '',
        content: '',
        closed: false,
      };
      continue;
    }

    if (fenceMatch && withoutBreak.trim() === '```') {
      parsed.push({ ...openBlock, closed: true });
      openBlock = null;
      openBlockStartOffset = null;
      continue;
    }

    openBlock.content += line;
  }

  if (openBlock) parsed.push(openBlock);
  return { blocks: parsed, openBlockStartOffset };
};

export const createStreamingFenceParser = (
  messageId: string,
  contextLang?: TAiSupportedLang,
) => {
  let text = '';
  let status: TStreamingFenceParserStatus = 'idle';
  let previousClosedIds = new Set<string>();
  let lastSnapshot: IAiStreamingFenceParserSnapshot = {
    messageId,
    status,
    blocks: [],
    openBlock: null,
    closedBlockIds: [],
    stableContent: '',
  };

  const buildSnapshot = (isCancelled: boolean, nextStatus: TStreamingFenceParserStatus): IAiStreamingFenceParserSnapshot => {
    const parsedResult = parseFences(text);
    const parsedBlocks = parsedResult.blocks;
    const stableContent = parsedResult.openBlockStartOffset === null
      ? text
      : text.slice(0, parsedResult.openBlockStartOffset);
    const blocks: IAiCodeBlock[] = [];
    let openBlock: IAiCodeBlock | null = null;

    parsedBlocks.forEach((parsed, index) => {
      const shouldCancelBlock = isCancelled && !parsed.closed && index === parsedBlocks.length - 1;
      const block = createCodeBlock(messageId, index, parsed, contextLang, shouldCancelBlock);
      if (block.closed) {
        blocks.push(block);
        return;
      }
      openBlock = block;
    });

    const closedIds = blocks.map((block) => block.id);
    const closedBlockIds = closedIds.filter((id) => !previousClosedIds.has(id));
    previousClosedIds = new Set(closedIds);
    status = nextStatus;
    lastSnapshot = {
      messageId,
      status,
      blocks,
      openBlock,
      closedBlockIds,
      stableContent,
    };
    return lastSnapshot;
  };

  return {
    append(chunk: string): IAiStreamingFenceParserSnapshot {
      if (status === 'cancelled') return lastSnapshot;
      if (chunk.length > 0) text += chunk;
      return buildSnapshot(false, 'streaming');
    },
    complete(): IAiStreamingFenceParserSnapshot {
      if (status === 'cancelled') return lastSnapshot;
      return buildSnapshot(false, 'completed');
    },
    cancel(): IAiStreamingFenceParserSnapshot {
      return buildSnapshot(true, 'cancelled');
    },
    snapshot(): IAiStreamingFenceParserSnapshot {
      return lastSnapshot;
    },
  };
};

export const useStreamingFenceParser = (
  messageId: MaybeRef<string>,
  contextLang?: MaybeRef<TAiSupportedLang | undefined>,
) => {
  const snapshot = ref<IAiStreamingFenceParserSnapshot>({
    messageId: unref(messageId),
    status: 'idle',
    blocks: [],
    openBlock: null,
    closedBlockIds: [],
    stableContent: '',
  });
  let parser = createStreamingFenceParser(unref(messageId), unref(contextLang));

  const appendChunk = (chunk: string): IAiStreamingFenceParserSnapshot => {
    snapshot.value = parser.append(chunk);
    return snapshot.value;
  };

  const complete = (): IAiStreamingFenceParserSnapshot => {
    snapshot.value = parser.complete();
    return snapshot.value;
  };

  const cancel = (): IAiStreamingFenceParserSnapshot => {
    snapshot.value = parser.cancel();
    return snapshot.value;
  };

  const reset = (): void => {
    parser = createStreamingFenceParser(unref(messageId), unref(contextLang));
    snapshot.value = parser.snapshot();
  };

  return {
    snapshot: readonly(snapshot),
    blocks: computed(() => snapshot.value.blocks),
    openBlock: computed(() => snapshot.value.openBlock),
    closedBlockIds: computed(() => snapshot.value.closedBlockIds),
    stableContent: computed(() => snapshot.value.stableContent),
    status: computed(() => snapshot.value.status),
    appendChunk,
    complete,
    cancel,
    reset,
  };
};
