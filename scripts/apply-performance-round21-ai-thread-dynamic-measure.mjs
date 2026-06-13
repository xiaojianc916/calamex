import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const file = path.join(repoRoot, 'src/components/business/ai/chat/AiChatThread.vue');

const fail = (message) => {
  throw new Error(message);
};

const read = () => fs.readFileSync(file, 'utf8');
const write = (content) => fs.writeFileSync(file, content);

const replaceOnce = (source, search, replacement, label) => {
  const count = source.split(search).length - 1;

  if (count !== 1) {
    fail(`[${label}] expected 1 match, got ${count}`);
  }

  return source.replace(search, replacement);
};

if (!fs.existsSync(file)) {
  fail(`[missing] ${file}`);
}

let source = read();

if (!source.includes('AI_THREAD_VIRTUAL_WINDOW_MAX_RENDERED_MESSAGES')) {
  fail('[guard] 请先成功应用 Round 20 AI Thread windowing，再运行 Round 21。');
}

if (source.includes('scheduleTimelineRemeasure')) {
  console.log('✅ Round 21 already applied');
  process.exit(0);
}

source = replaceOnce(
  source,
  "import { computed, nextTick, ref, watch } from 'vue';",
  "import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';",
  'vue import',
);

source = replaceOnce(
  source,
  'const AI_THREAD_BOTTOM_FOLLOW_THRESHOLD_PX = 48;',
  `const AI_THREAD_BOTTOM_FOLLOW_THRESHOLD_PX = 48;
const AI_THREAD_REMEASURE_THROTTLE_MS = 64;`,
  'remeasure constant',
);

source = replaceOnce(
  source,
  `const renderedTimelineRef = ref<HTMLElement | null>(null);

const loadedVisibleMessageCount = ref(HISTORY_MESSAGE_INITIAL_COUNT);`,
  `const renderedTimelineRef = ref<HTMLElement | null>(null);

let timelineResizeObserver: ResizeObserver | null = null;
let pendingTimelineRemeasure = false;
let lastTimelineRemeasureAt = 0;
let timelineRemeasureTimer: ReturnType<typeof window.setTimeout> | null = null;

const loadedVisibleMessageCount = ref(HISTORY_MESSAGE_INITIAL_COUNT);`,
  'observer state',
);

source = replaceOnce(
  source,
  `const measureRenderedWindowHeight = async (): Promise<void> => {
  await nextTick();

  const element = renderedTimelineRef.value;
  const count = renderedMessages.value.length;

  if (!element || count <= 0) {
    return;
  }

  const average = element.offsetHeight / count;

  if (!Number.isFinite(average) || average <= 0) {
    return;
  }

  estimatedMessageHeightPx.value = clamp(
    Math.round(estimatedMessageHeightPx.value * 0.82 + average * 0.18),
    AI_THREAD_MIN_ESTIMATED_MESSAGE_HEIGHT_PX,
    AI_THREAD_MAX_ESTIMATED_MESSAGE_HEIGHT_PX,
  );
};`,
  `const measureRenderedWindowHeight = async (): Promise<void> => {
  await nextTick();

  const element = renderedTimelineRef.value;
  const count = renderedMessages.value.length;

  if (!element || count <= 0) {
    return;
  }

  const average = element.offsetHeight / count;

  if (!Number.isFinite(average) || average <= 0) {
    return;
  }

  estimatedMessageHeightPx.value = clamp(
    Math.round(estimatedMessageHeightPx.value * 0.82 + average * 0.18),
    AI_THREAD_MIN_ESTIMATED_MESSAGE_HEIGHT_PX,
    AI_THREAD_MAX_ESTIMATED_MESSAGE_HEIGHT_PX,
  );
};

const isNearConversationBottom = (): boolean => {
  const scrollElement = getConversationScrollElement();

  if (!scrollElement) {
    return false;
  }

  return (
    scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight <=
    AI_THREAD_BOTTOM_FOLLOW_THRESHOLD_PX
  );
};

const scrollConversationToBottom = (): void => {
  const scrollElement = getConversationScrollElement();

  if (!scrollElement) {
    return;
  }

  scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
};

const clearTimelineRemeasureTimer = (): void => {
  if (timelineRemeasureTimer === null) {
    return;
  }

  window.clearTimeout(timelineRemeasureTimer);
  timelineRemeasureTimer = null;
};

const flushTimelineRemeasure = async (preserveTail = false): Promise<void> => {
  pendingTimelineRemeasure = false;
  clearTimelineRemeasureTimer();

  const shouldStickToBottom = preserveTail && isNearConversationBottom();

  await measureRenderedWindowHeight();

  if (shouldStickToBottom) {
    scrollConversationToBottom();
  }
};

const scheduleTimelineRemeasure = (preserveTail = false): void => {
  if (pendingTimelineRemeasure) {
    return;
  }

  pendingTimelineRemeasure = true;

  const now = performance.now();
  const elapsed = now - lastTimelineRemeasureAt;
  const delay = Math.max(0, AI_THREAD_REMEASURE_THROTTLE_MS - elapsed);

  timelineRemeasureTimer = window.setTimeout(() => {
    lastTimelineRemeasureAt = performance.now();
    void flushTimelineRemeasure(preserveTail);
  }, delay);
};

const stopObservingRenderedTimeline = (): void => {
  timelineResizeObserver?.disconnect();
  timelineResizeObserver = null;
};

const observeRenderedTimeline = (element: HTMLElement | null): void => {
  stopObservingRenderedTimeline();

  if (!element || typeof ResizeObserver === 'undefined') {
    return;
  }

  timelineResizeObserver = new ResizeObserver(() => {
    if (!shouldUseVirtualWindow.value) {
      return;
    }

    scheduleTimelineRemeasure(props.isTyping);
  });

  timelineResizeObserver.observe(element);
};`,
  'dynamic measurement helpers',
);

source = replaceOnce(
  source,
  `watch(
  renderedMessages,
  () => {
    void measureRenderedWindowHeight();
  },
  { flush: 'post' },
);`,
  `watch(
  renderedMessages,
  () => {
    scheduleTimelineRemeasure(props.isTyping);
  },
  { flush: 'post' },
);

watch(
  () => renderedTimelineRef.value,
  (element) => {
    observeRenderedTimeline(element);
    scheduleTimelineRemeasure(props.isTyping);
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  stopObservingRenderedTimeline();
  clearTimelineRemeasureTimer();
});`,
  'watch rendered timeline',
);

source = replaceOnce(
  source,
  `    await measureRenderedWindowHeight();
    scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    return;`,
  `    await flushTimelineRemeasure(true);
    scrollConversationToBottom();
    return;`,
  'fill viewport virtual measurement',
);

source = replaceOnce(
  source,
  `    await nextTick();
    await measureRenderedWindowHeight();

    if (scrollElement && previousScrollTop !== null) {`,
  `    await nextTick();
    await flushTimelineRemeasure(false);

    if (scrollElement && previousScrollTop !== null) {`,
  'load older measurement',
);

source = replaceOnce(
  source,
  `  await nextTick();
  await measureRenderedWindowHeight();

  const scrollElement = getConversationScrollElement();

  if (scrollElement) {
    scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  }`,
  `  await nextTick();
  await flushTimelineRemeasure(true);
  scrollConversationToBottom();`,
  'move tail measurement',
);

source = replaceOnce(
  source,
  `    syncLoadedCountFromVirtualWindow();
    void measureRenderedWindowHeight();`,
  `    syncLoadedCountFromVirtualWindow();
    scheduleTimelineRemeasure(props.isTyping);`,
  'length shrink measurement',
);

write(source);

console.log('✅ Applied Round 21 AI thread dynamic measurement');
console.log(`📝 Updated: ${path.relative(repoRoot, file)}`);