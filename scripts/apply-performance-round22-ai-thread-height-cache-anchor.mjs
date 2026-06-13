import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const file = path.join(repoRoot, 'src/components/business/ai/chat/AiChatThread.vue');

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

if (!fs.existsSync(file)) {
  fail(`[missing] ${file}`);
}

let source = fs.readFileSync(file, 'utf8');

if (!source.includes('scheduleTimelineRemeasure')) {
  fail('[guard] 请先成功应用 Round 21，再运行 Round 22。');
}

if (source.includes('messageHeightCacheVersion')) {
  console.log('✅ Round 22 already applied');
  process.exit(0);
}

source = replaceOnce(
  source,
  `const AI_THREAD_REMEASURE_THROTTLE_MS = 64;`,
  `const AI_THREAD_REMEASURE_THROTTLE_MS = 64;
const AI_THREAD_MESSAGE_HEIGHT_CACHE_LIMIT = 2000;`,
  'height cache limit constant',
);

source = replaceOnce(
  source,
  `let timelineResizeObserver: ResizeObserver | null = null;
let pendingTimelineRemeasure = false;
let lastTimelineRemeasureAt = 0;
let timelineRemeasureTimer: ReturnType<typeof window.setTimeout> | null = null;`,
  `let timelineResizeObserver: ResizeObserver | null = null;
let pendingTimelineRemeasure = false;
let lastTimelineRemeasureAt = 0;
let timelineRemeasureTimer: ReturnType<typeof window.setTimeout> | null = null;

const messageElementById = new Map<string, HTMLElement>();
const messageResizeObserverById = new Map<string, ResizeObserver>();
const messageHeightCache = new Map<string, number>();
const messageHeightCacheVersion = ref(0);`,
  'message height cache state',
);

source = replaceOnce(
  source,
  `const virtualTopSpacerHeight = computed(() => {
  if (!shouldUseVirtualWindow.value) {
    return 0;
  }

  return Math.max(0, virtualWindowStart.value * estimatedMessageHeightPx.value);
});

const virtualBottomSpacerHeight = computed(() => {
  if (!shouldUseVirtualWindow.value) {
    return 0;
  }

  const hiddenAfter = Math.max(0, visibleMessages.value.length - virtualWindowEnd.value);
  return hiddenAfter * estimatedMessageHeightPx.value;
});`,
  `const estimateMessagesHeight = (messages: IAiChatMessage[]): number => {
  messageHeightCacheVersion.value;

  let total = 0;

  for (const message of messages) {
    total += messageHeightCache.get(message.id) ?? estimatedMessageHeightPx.value;
  }

  return Math.max(0, Math.round(total));
};

const virtualTopSpacerHeight = computed(() => {
  if (!shouldUseVirtualWindow.value) {
    return 0;
  }

  return estimateMessagesHeight(visibleMessages.value.slice(0, virtualWindowStart.value));
});

const virtualBottomSpacerHeight = computed(() => {
  if (!shouldUseVirtualWindow.value) {
    return 0;
  }

  return estimateMessagesHeight(visibleMessages.value.slice(virtualWindowEnd.value));
});`,
  'height-cache spacer calculation',
);

source = replaceOnce(
  source,
  `const stopObservingRenderedTimeline = (): void => {
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
  `const trimMessageHeightCache = (): void => {
  if (messageHeightCache.size <= AI_THREAD_MESSAGE_HEIGHT_CACHE_LIMIT) {
    return;
  }

  const visibleIds = new Set(visibleMessages.value.map((message) => message.id));

  for (const key of messageHeightCache.keys()) {
    if (messageHeightCache.size <= AI_THREAD_MESSAGE_HEIGHT_CACHE_LIMIT) {
      break;
    }

    if (visibleIds.has(key)) {
      continue;
    }

    messageHeightCache.delete(key);
  }

  while (messageHeightCache.size > AI_THREAD_MESSAGE_HEIGHT_CACHE_LIMIT) {
    const firstKey = messageHeightCache.keys().next().value;

    if (typeof firstKey !== 'string') {
      break;
    }

    messageHeightCache.delete(firstKey);
  }
};

const updateMessageHeight = (messageId: string, element: HTMLElement): void => {
  const height = Math.round(element.offsetHeight);

  if (!Number.isFinite(height) || height <= 0) {
    return;
  }

  const previous = messageHeightCache.get(messageId);

  if (previous === height) {
    return;
  }

  messageHeightCache.set(messageId, height);
  trimMessageHeightCache();
  messageHeightCacheVersion.value += 1;
};

const stopObservingMessageElement = (messageId: string): void => {
  messageResizeObserverById.get(messageId)?.disconnect();
  messageResizeObserverById.delete(messageId);
  messageElementById.delete(messageId);
};

const stopObservingMessageElements = (): void => {
  for (const observer of messageResizeObserverById.values()) {
    observer.disconnect();
  }

  messageResizeObserverById.clear();
  messageElementById.clear();
};

const pruneMessageElementObservers = (): void => {
  const renderedIds = new Set(renderedMessages.value.map((message) => message.id));

  for (const messageId of messageElementById.keys()) {
    if (renderedIds.has(messageId)) {
      continue;
    }

    stopObservingMessageElement(messageId);
  }
};

const setMessageElementRef = (messageId: string, element: unknown): void => {
  if (!(element instanceof HTMLElement)) {
    stopObservingMessageElement(messageId);
    return;
  }

  if (messageElementById.get(messageId) === element) {
    updateMessageHeight(messageId, element);
    return;
  }

  stopObservingMessageElement(messageId);
  messageElementById.set(messageId, element);
  updateMessageHeight(messageId, element);

  if (typeof ResizeObserver === 'undefined') {
    return;
  }

  const observer = new ResizeObserver(() => {
    updateMessageHeight(messageId, element);

    if (shouldUseVirtualWindow.value) {
      scheduleTimelineRemeasure(props.isTyping);
    }
  });

  observer.observe(element);
  messageResizeObserverById.set(messageId, observer);
};

const getMessageElementTop = (messageId: string | null | undefined): number | null => {
  if (!messageId) {
    return null;
  }

  const element = messageElementById.get(messageId);

  if (!element) {
    return null;
  }

  return element.offsetTop;
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
  'message element measurement helpers',
);

source = replaceOnce(
  source,
  `    const scrollElement = getConversationScrollElement();
    const previousScrollTop = scrollElement?.scrollTop ?? null;

    const previousStart = virtualWindowStart.value;
    const nextStart = Math.max(0, previousStart - HISTORY_MESSAGE_LOAD_STEP);
    const addedCount = previousStart - nextStart;`,
  `    const scrollElement = getConversationScrollElement();
    const previousScrollTop = scrollElement?.scrollTop ?? null;
    const anchorMessageId = renderedMessages.value[0]?.id ?? null;
    const previousAnchorTop = getMessageElementTop(anchorMessageId);

    const previousStart = virtualWindowStart.value;
    const nextStart = Math.max(0, previousStart - HISTORY_MESSAGE_LOAD_STEP);
    const addedCount = previousStart - nextStart;`,
  'anchor capture before loading older',
);

source = replaceOnce(
  source,
  `    if (scrollElement && previousScrollTop !== null) {
      scrollElement.scrollTop = previousScrollTop;
    }

    return;`,
  `    if (scrollElement && previousScrollTop !== null) {
      const nextAnchorTop = getMessageElementTop(anchorMessageId);

      if (previousAnchorTop !== null && nextAnchorTop !== null) {
        scrollElement.scrollTop = previousScrollTop + (nextAnchorTop - previousAnchorTop);
      } else {
        scrollElement.scrollTop = previousScrollTop;
      }
    }

    return;`,
  'anchor restore after loading older',
);

source = replaceOnce(
  source,
  `watch(
  renderedMessages,
  () => {
    scheduleTimelineRemeasure(props.isTyping);
  },
  { flush: 'post' },
);`,
  `watch(
  renderedMessages,
  () => {
    pruneMessageElementObservers();
    scheduleTimelineRemeasure(props.isTyping);
  },
  { flush: 'post' },
);`,
  'rendered messages prune observer watch',
);

source = replaceOnce(
  source,
  `onBeforeUnmount(() => {
  stopObservingRenderedTimeline();
  clearTimelineRemeasureTimer();
});`,
  `onBeforeUnmount(() => {
  stopObservingRenderedTimeline();
  stopObservingMessageElements();
  clearTimelineRemeasureTimer();
});`,
  'unmount cleanup message observers',
);

source = replaceOnce(
  source,
  `          <div ref="renderedTimelineRef" class="ai-chat-list__virtual-window">
            <AiThreadTimeline
              :messages="renderedMessages"
              :workspace-root-path="workspaceRootPath"
              :plan-details="planDetails"
              :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
              :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
              @changed-files-rollback="handleChangedFilesRollback"
              @changed-files-pin="handleChangedFilesPin"
              @plan-approve="emit('planApprove')"
              @plan-reject="emit('planReject')"
              @plan-regenerate="emit('planRegenerate')"
              @plan-update-step-title="(stepId: string, title: string) => emit('planUpdateStepTitle', stepId, title)"
              @plan-remove-step="emit('planRemoveStep', $event)"
            >
              <template #after-message="{ message }">
                <slot name="after-message" :message="message" />
              </template>
            </AiThreadTimeline>
          </div>`,
  `          <div ref="renderedTimelineRef" class="ai-chat-list__virtual-window">
            <div
              v-for="message in renderedMessages"
              :key="message.id"
              class="ai-chat-list__message-measure"
              :ref="(element) => setMessageElementRef(message.id, element)"
            >
              <AiThreadTimeline
                :messages="[message]"
                :workspace-root-path="workspaceRootPath"
                :plan-details="planDetails"
                :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
                :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
                @changed-files-rollback="handleChangedFilesRollback"
                @changed-files-pin="handleChangedFilesPin"
                @plan-approve="emit('planApprove')"
                @plan-reject="emit('planReject')"
                @plan-regenerate="emit('planRegenerate')"
                @plan-update-step-title="(stepId: string, title: string) => emit('planUpdateStepTitle', stepId, title)"
                @plan-remove-step="emit('planRemoveStep', $event)"
              >
                <template #after-message="{ message: slotMessage }">
                  <slot name="after-message" :message="slotMessage" />
                </template>
              </AiThreadTimeline>
            </div>
          </div>`,
  'render per-message measurable wrappers',
);

source = replaceOnce(
  source,
  `.ai-chat-list__virtual-window {
  width: 100%;
  min-width: 0;
}

.ai-chat-list__virtual-spacer {`,
  `.ai-chat-list__virtual-window {
  width: 100%;
  min-width: 0;
}

.ai-chat-list__message-measure {
  width: 100%;
  min-width: 0;
  contain: layout style;
}

.ai-chat-list__virtual-spacer {`,
  'message measure css',
);

fs.writeFileSync(file, source);

console.log('✅ Applied Round 22 AI thread height cache + scroll anchor');
console.log(`📝 Updated: ${path.relative(repoRoot, file)}`);