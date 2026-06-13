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
  fail(`[missing] ${path.relative(repoRoot, file)}`);
}

let source = fs.readFileSync(file, 'utf8');

if (!source.includes("from 'vue-virtual-scroller'")) {
  fail('[guard] 请先成功应用 Round 23：vue-virtual-scroller 版本。');
}

if (source.includes('handleDynamicItemResize')) {
  console.log('✅ Round 24 already applied');
  process.exit(0);
}

source = replaceOnce(
  source,
  `let pendingBottomScrollFrame: number | null = null;
let scrollbarTimer: ReturnType<typeof window.setTimeout> | null = null;
let lastScrollStateEmitAt = 0;`,
  `let pendingBottomScrollFrame: number | null = null;
let scrollbarTimer: ReturnType<typeof window.setTimeout> | null = null;
let lastScrollStateEmitAt = 0;
let shouldFollowBottomAfterResize = true;
let lastKnownDistanceFromBottom = 0;`,
  'scroll state vars',
);

source = replaceOnce(
  source,
  `const isNearBottom = (): boolean => {
  const element = getScrollerElement();

  if (!element) {
    return true;
  }

  return getDistanceFromBottom(element) <= BOTTOM_FOLLOW_THRESHOLD_PX;
};`,
  `const isNearBottom = (): boolean => {
  const element = getScrollerElement();

  if (!element) {
    return true;
  }

  return getDistanceFromBottom(element) <= BOTTOM_FOLLOW_THRESHOLD_PX;
};

const rememberBottomFollowState = (): void => {
  const element = getScrollerElement();

  if (!element) {
    shouldFollowBottomAfterResize = true;
    lastKnownDistanceFromBottom = 0;
    return;
  }

  lastKnownDistanceFromBottom = getDistanceFromBottom(element);
  shouldFollowBottomAfterResize = lastKnownDistanceFromBottom <= BOTTOM_FOLLOW_THRESHOLD_PX;
};`,
  'bottom follow memory',
);

source = replaceOnce(
  source,
  `const handleScrollerScroll = (event: Event): void => {
  const element = event.currentTarget;

  if (!(element instanceof HTMLElement)) {
    return;
  }

  activateScrollbar();

  const distanceFromBottom = getDistanceFromBottom(element);
  showScrollButton.value = distanceFromBottom > BOTTOM_FOLLOW_THRESHOLD_PX;

  emitScrollState(element);
};`,
  `const handleScrollerScroll = (event: Event): void => {
  const element = event.currentTarget;

  if (!(element instanceof HTMLElement)) {
    return;
  }

  activateScrollbar();

  const distanceFromBottom = getDistanceFromBottom(element);
  lastKnownDistanceFromBottom = distanceFromBottom;
  shouldFollowBottomAfterResize = distanceFromBottom <= BOTTOM_FOLLOW_THRESHOLD_PX;
  showScrollButton.value = distanceFromBottom > BOTTOM_FOLLOW_THRESHOLD_PX;

  emitScrollState(element);
};`,
  'scroll updates follow state',
);

source = replaceOnce(
  source,
  `const getMessageSizeDependencies = (message: IAiChatMessage): unknown[] => [
  message.content,
  message.stream?.status,
  message.toolCalls?.length ?? 0,
  message.actions?.length ?? 0,
  message.attachments?.length ?? 0,
  props.planDetails?.status,
  props.revertingChangedFilesSummaryId,
  props.pinningChangedFilesSummaryId,
];`,
  `const getMessageSizeDependencies = (message: IAiChatMessage): unknown[] => [
  message.content,
  message.stream?.status,
  message.toolCalls?.length ?? 0,
  message.toolCalls?.map((toolCall) => toolCall.status).join('|') ?? '',
  message.actions?.length ?? 0,
  message.attachments?.length ?? 0,
  props.planDetails?.status,
  props.planDetails?.steps?.length ?? 0,
  props.planDetails?.steps?.map((step) => \`\${step.id}:\${step.status}:\${step.title}\`).join('|') ?? '',
  props.revertingChangedFilesSummaryId,
  props.pinningChangedFilesSummaryId,
];

const handleDynamicItemResize = (): void => {
  if (!shouldFollowBottomAfterResize) {
    return;
  }

  void scrollToBottom('auto');
};`,
  'official resize handler',
);

source = replaceOnce(
  source,
  `watch(
  bottomFollowSignature,
  async () => {
    const shouldStickToBottom = isNearBottom();

    await nextTick();

    if (shouldStickToBottom) {
      await scrollToBottom('auto');
    }
  },
  { flush: 'pre' },
);`,
  `watch(
  bottomFollowSignature,
  async () => {
    rememberBottomFollowState();

    await nextTick();

    if (shouldFollowBottomAfterResize) {
      await scrollToBottom('auto');
    }
  },
  { flush: 'pre' },
);`,
  'bottom signature follow',
);

source = replaceOnce(
  source,
  `        <DynamicScrollerItem
          :item="item"
          :active="active"
          :data-index="index"
          :size-dependencies="
            item.type === 'message' ? getMessageSizeDependencies(item.message) : [props.isTyping]
          "
        >`,
  `        <DynamicScrollerItem
          :item="item"
          :active="active"
          :data-index="index"
          :size-dependencies="
            item.type === 'message' ? getMessageSizeDependencies(item.message) : [props.isTyping]
          "
          emit-resize
          @resize="handleDynamicItemResize"
        >`,
  'dynamic item emit resize',
);

fs.writeFileSync(file, source);

console.log('✅ Applied Round 24: official DynamicScrollerItem resize + bottom follow');
console.log(`📝 Updated: ${path.relative(repoRoot, file)}`);