import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const markdownFile = path.join(
  repoRoot,
  'src/components/business/ai/chat/AiMarkdown.vue',
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

if (!fs.existsSync(markdownFile)) {
  fail(`[missing] ${path.relative(repoRoot, markdownFile)}`);
}

let source = fs.readFileSync(markdownFile, 'utf8');

if (source.includes('AI_MARKDOWN_STREAM_UPDATE_INTERVAL_MS')) {
  console.log('✅ Round 28 already applied');
  process.exit(0);
}

if (!source.includes('MarkdownRender') || !source.includes('normalizeAiMath')) {
  fail('[guard] AiMarkdown.vue 结构异常，请贴当前文件内容。');
}

source = replaceOnce(
  source,
  `const AI_MARKDOWN_COMPONENTS = {
  code_block: AiMarkdownCodeBlock,
  table: AiMarkdownTable,
} satisfies Partial<CustomComponents>;`,
  `const AI_MARKDOWN_COMPONENTS = {
  code_block: AiMarkdownCodeBlock,
  table: AiMarkdownTable,
} satisfies Partial<CustomComponents>;

const AI_MARKDOWN_STREAM_UPDATE_INTERVAL_MS = 48;
const AI_MARKDOWN_FINAL_NORMALIZE_CACHE_LIMIT = 500;
const AI_MARKDOWN_LONG_CONTENT_HEAD_SIGNATURE = 96;
const AI_MARKDOWN_LONG_CONTENT_TAIL_SIGNATURE = 512;

interface IAiMarkdownNormalizeCacheRecord {
  content: string;
  normalized: string;
}

const finalNormalizeCache = new Map<string, IAiMarkdownNormalizeCacheRecord>();

const buildFinalNormalizeCacheKey = (messageId: string, content: string): string => {
  if (content.length <= AI_MARKDOWN_LONG_CONTENT_TAIL_SIGNATURE) {
    return \`\${messageId}:\${content.length}:\${content}\`;
  }

  return [
    messageId,
    content.length,
    content.slice(0, AI_MARKDOWN_LONG_CONTENT_HEAD_SIGNATURE),
    content.slice(-AI_MARKDOWN_LONG_CONTENT_TAIL_SIGNATURE),
  ].join(':');
};

const trimFinalNormalizeCache = (): void => {
  while (finalNormalizeCache.size > AI_MARKDOWN_FINAL_NORMALIZE_CACHE_LIMIT) {
    const firstKey = finalNormalizeCache.keys().next().value;

    if (typeof firstKey !== 'string') {
      break;
    }

    finalNormalizeCache.delete(firstKey);
  }
};

const normalizeMarkdownContent = (
  messageId: string,
  content: string,
  cacheable: boolean,
): string => {
  if (!cacheable) {
    return normalizeAiMath(content);
  }

  const key = buildFinalNormalizeCacheKey(messageId, content);
  const cached = finalNormalizeCache.get(key);

  if (cached?.content === content) {
    return cached.normalized;
  }

  const normalized = normalizeAiMath(content);

  finalNormalizeCache.delete(key);
  finalNormalizeCache.set(key, {
    content,
    normalized,
  });
  trimFinalNormalizeCache();

  return normalized;
};`,
  'add markdown normalize cache',
);

source = replaceOnce(
  source,
  `const normalizedContent = computed(() => normalizeAiMath(props.content));
const renderContent = ref(normalizeAiMath(props.content));
const isShellWindowResizing = ref(false);
const isFinal = computed(
  () => props.streamStatus !== 'streaming' && props.streamStatus !== 'waiting-confirmation',
);`,
  `const isShellWindowResizing = ref(false);
const isFinal = computed(
  () => props.streamStatus !== 'streaming' && props.streamStatus !== 'waiting-confirmation',
);
const normalizedContent = computed(() =>
  normalizeMarkdownContent(props.messageId, props.content, isFinal.value),
);
const renderContent = ref(normalizedContent.value);`,
  'replace normalized content setup',
);

source = replaceOnce(
  source,
  `let pendingRenderContent: string | null = null;
let resizeLifecycleCleanup: (() => void) | null = null;

const flushPendingRenderContent = (): void => {
  if (pendingRenderContent === null) {
    return;
  }

  renderContent.value = pendingRenderContent;
  pendingRenderContent = null;
};

watch(normalizedContent, (nextContent) => {
  if (isShellWindowResizing.value) {
    pendingRenderContent = nextContent;
    return;
  }

  renderContent.value = nextContent;
});`,
  `let pendingRenderContent: string | null = null;
let pendingRenderContentTimer: ReturnType<typeof window.setTimeout> | null = null;
let resizeLifecycleCleanup: (() => void) | null = null;

const clearPendingRenderContentTimer = (): void => {
  if (pendingRenderContentTimer === null) {
    return;
  }

  window.clearTimeout(pendingRenderContentTimer);
  pendingRenderContentTimer = null;
};

const flushPendingRenderContent = (): void => {
  clearPendingRenderContentTimer();

  if (pendingRenderContent === null) {
    return;
  }

  renderContent.value = pendingRenderContent;
  pendingRenderContent = null;
};

const scheduleStreamingRenderContent = (nextContent: string): void => {
  pendingRenderContent = nextContent;

  if (pendingRenderContentTimer !== null) {
    return;
  }

  pendingRenderContentTimer = window.setTimeout(() => {
    pendingRenderContentTimer = null;
    flushPendingRenderContent();
  }, AI_MARKDOWN_STREAM_UPDATE_INTERVAL_MS);
};

watch(
  normalizedContent,
  (nextContent) => {
    if (isShellWindowResizing.value) {
      pendingRenderContent = nextContent;
      return;
    }

    if (isFinal.value) {
      pendingRenderContent = nextContent;
      flushPendingRenderContent();
      return;
    }

    scheduleStreamingRenderContent(nextContent);
  },
  { flush: 'pre' },
);

watch(
  isFinal,
  (final) => {
    if (!final) {
      return;
    }

    pendingRenderContent = normalizedContent.value;
    flushPendingRenderContent();
  },
  { flush: 'pre' },
);`,
  'replace render content scheduling',
);

source = replaceOnce(
  source,
  `onBeforeUnmount(() => {
  resizeLifecycleCleanup?.();
  stopCodeBlockMapping();
  removeCustomComponents(rendererId.value);
});`,
  `onBeforeUnmount(() => {
  clearPendingRenderContentTimer();
  resizeLifecycleCleanup?.();
  stopCodeBlockMapping();
  removeCustomComponents(rendererId.value);
});`,
  'unmount clear timer',
);

fs.writeFileSync(markdownFile, source);

console.log('✅ Applied Round 28: AI Markdown streaming render budget + final normalize cache');
console.log(`📝 Updated: ${path.relative(repoRoot, markdownFile)}`);