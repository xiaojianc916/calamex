import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const singleTimelineFile = path.join(
  repoRoot,
  'src/components/business/ai/chat/AiThreadSingleMessageTimeline.vue',
);

const memoFile = path.join(
  repoRoot,
  'src/components/business/ai/thread/projection/build-single-message-thread-entries.ts',
);

const projectionIndexFile = path.join(
  repoRoot,
  'src/components/business/ai/thread/projection/index.ts',
);

const fail = (message) => {
  throw new Error(message);
};

const replaceOnce = (source, search, replacement, label) => {
  const count = source.split(search).length - 1;

  if (count !== 1) {
    fail(`[${label}] expected 1 match, got ${count}`);
  }

  return source.replace(search, replacement);
};

if (!fs.existsSync(singleTimelineFile)) {
  fail('[guard] 请先成功应用 Round 26，缺少 AiThreadSingleMessageTimeline.vue。');
}

if (!fs.existsSync(projectionIndexFile)) {
  fail('[missing] src/components/business/ai/thread/projection/index.ts');
}

let singleTimelineSource = fs.readFileSync(singleTimelineFile, 'utf8');

if (singleTimelineSource.includes('buildSingleMessageThreadEntries')) {
  console.log('✅ Round 27 already applied');
  process.exit(0);
}

if (!singleTimelineSource.includes('buildThreadEntries')) {
  fail('[guard] AiThreadSingleMessageTimeline.vue 结构不符合 Round 26 预期。');
}

const memoSource = `import type { IAiChatMessage } from '@/types/ai';
import { buildThreadEntries } from './build-thread-entries';
import type { TAiThreadEntry } from './entry-types';

const SINGLE_MESSAGE_ENTRY_CACHE_LIMIT = 600;
const LONG_TEXT_TAIL_SIGNATURE_LENGTH = 512;

interface ISingleMessageEntryCacheRecord {
  signature: string;
  entries: TAiThreadEntry[];
}

const singleMessageEntryCache = new Map<string, ISingleMessageEntryCacheRecord>();

const boundedTextSignature = (value: string | undefined): string => {
  if (!value) {
    return '';
  }

  if (value.length <= LONG_TEXT_TAIL_SIGNATURE_LENGTH) {
    return value;
  }

  return [
    value.length,
    value.slice(0, 96),
    value.slice(-LONG_TEXT_TAIL_SIGNATURE_LENGTH),
  ].join(':');
};

const safeJsonSignature = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
};

const arrayTailSignature = (values: readonly unknown[] | undefined): string => {
  if (!values || values.length === 0) {
    return '0';
  }

  const tail = values.at(-1);

  return [values.length, safeJsonSignature(tail)].join(':');
};

const buildToolCallsSignature = (message: IAiChatMessage): string => {
  const toolCalls = message.toolCalls;

  if (!toolCalls || toolCalls.length === 0) {
    return '0';
  }

  return toolCalls
    .map((toolCall) =>
      [
        toolCall.id,
        toolCall.name,
        toolCall.status,
        boundedTextSignature(toolCall.summary),
        toolCall.targetPreview ?? '',
      ].join(':'),
    )
    .join('|');
};

const buildMessageSignature = (message: IAiChatMessage): string => {
  const runtimeEvents = message.stream?.runtimeEvents;
  const changedFiles = message.changedFilesSummary?.files;

  return [
    message.role,
    boundedTextSignature(message.content),
    safeJsonSignature(message.references),
    message.stream?.status ?? '',
    arrayTailSignature(runtimeEvents),
    buildToolCallsSignature(message),
    safeJsonSignature(message.actions),
    safeJsonSignature(message.agentConfirmation),
    message.changedFilesSummary?.id ?? '',
    changedFiles?.length ?? 0,
    safeJsonSignature(changedFiles?.at(-1)),
    message.patches?.length ?? 0,
    safeJsonSignature(message.patches?.at(-1)),
  ].join('\\u001f');
};

const trimSingleMessageEntryCache = (): void => {
  while (singleMessageEntryCache.size > SINGLE_MESSAGE_ENTRY_CACHE_LIMIT) {
    const firstKey = singleMessageEntryCache.keys().next().value;

    if (typeof firstKey !== 'string') {
      break;
    }

    singleMessageEntryCache.delete(firstKey);
  }
};

export const buildSingleMessageThreadEntries = (
  message: IAiChatMessage,
): TAiThreadEntry[] => {
  const signature = buildMessageSignature(message);
  const cached = singleMessageEntryCache.get(message.id);

  if (cached?.signature === signature) {
    return cached.entries;
  }

  const entries = buildThreadEntries([message]);

  singleMessageEntryCache.delete(message.id);
  singleMessageEntryCache.set(message.id, {
    signature,
    entries,
  });

  trimSingleMessageEntryCache();

  return entries;
};

export const clearSingleMessageThreadEntryCache = (): void => {
  singleMessageEntryCache.clear();
};
`;

fs.mkdirSync(path.dirname(memoFile), { recursive: true });
fs.writeFileSync(memoFile, memoSource);

singleTimelineSource = replaceOnce(
  singleTimelineSource,
  `import {
  buildThreadEntries,
  type TAiThreadEntry,
} from '@/components/business/ai/thread/projection';`,
  `import {
  buildSingleMessageThreadEntries,
  type TAiThreadEntry,
} from '@/components/business/ai/thread/projection';`,
  'replace projection import',
);

singleTimelineSource = replaceOnce(
  singleTimelineSource,
  `const entries = computed<TAiThreadEntry[]>(() => buildThreadEntries([props.message]));`,
  `const entries = computed<TAiThreadEntry[]>(() => buildSingleMessageThreadEntries(props.message));`,
  'replace entries computed',
);

fs.writeFileSync(singleTimelineFile, singleTimelineSource);

let projectionIndexSource = fs.readFileSync(projectionIndexFile, 'utf8');

if (!projectionIndexSource.includes("from './build-single-message-thread-entries'")) {
  projectionIndexSource = `${projectionIndexSource.trimEnd()}
export {
  buildSingleMessageThreadEntries,
  clearSingleMessageThreadEntryCache,
} from './build-single-message-thread-entries';
`;

  fs.writeFileSync(projectionIndexFile, projectionIndexSource);
}

console.log('✅ Applied Round 27: memoized single-message AI thread projection');
console.log(`📝 Created: ${path.relative(repoRoot, memoFile)}`);
console.log(`📝 Updated: ${path.relative(repoRoot, singleTimelineFile)}`);
console.log(`📝 Updated: ${path.relative(repoRoot, projectionIndexFile)}`);