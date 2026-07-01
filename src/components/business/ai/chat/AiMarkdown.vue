<script setup lang="ts">
// markdown 节点样式仅 AI 面板需要：随本组件（懒加载）按需加载，不再进首屏 styles.css。
import 'markstream-vue/index.css';
import 'katex/dist/katex.min.css';

import type {
  CustomComponents,
  MarkstreamVirtualMetrics,
  MarkstreamVirtualScrollOptions,
  MarkstreamVirtualState,
} from 'markstream-vue';
import MarkdownRender, {
  enableKatex,
  isKatexEnabled,
  removeCustomComponents,
  setCustomComponents,
  setDefaultI18nMap,
} from 'markstream-vue';
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import AiMarkdownCodeBlock from '@/components/business/ai/chat/AiMarkdownCodeBlock.vue';
import AiMarkdownTable from '@/components/business/ai/chat/AiMarkdownTable.vue';
import { AI_MARKDOWN_VIRTUAL_SCROLL_KEY } from '@/components/business/ai/chat/markstream-virtual-scroll';
import { normalizeAiMath } from '@/components/business/ai/chat/normalize-math';
import type { IAiChatStreamRenderState } from '@/types/ai';

type TI18nMap = Parameters<typeof setDefaultI18nMap>[0];

const AI_MARKDOWN_I18N_MAP = {
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.decrease': '减小字号',
  'common.reset': '重置字号',
  'common.increase': '增大字号',
  'common.expand': '展开',
  'common.collapse': '收起',
  'common.preview': '预览',
  'common.source': '源码',
  'common.export': '导出',
  'common.open': '打开',
  'common.minimize': '最小化',
  'common.zoomIn': '放大',
  'common.zoomOut': '缩小',
  'common.resetZoom': '重置缩放',
  'common.more': '更多',
  'common.fontSmaller': '减小字号',
  'common.fontReset': '重置字号',
  'common.fontLarger': '增大字号',
  'artifacts.htmlPreviewTitle': 'HTML 预览',
  'artifacts.svgPreviewTitle': 'SVG 预览',
  'image.loadError': '图片加载失败',
  'image.loading': '图片加载中...',
} satisfies TI18nMap;

const AI_MARKDOWN_COMPONENTS = {
  code_block: AiMarkdownCodeBlock,
  table: AiMarkdownTable,
} satisfies Partial<CustomComponents>;

const AI_MARKDOWN_STREAM_UPDATE_INTERVAL_MS = 16;
const AI_MARKDOWN_FINAL_NORMALIZE_CACHE_LIMIT = 500;
const AI_MARKDOWN_LONG_CONTENT_HEAD_SIGNATURE = 96;
const AI_MARKDOWN_LONG_CONTENT_TAIL_SIGNATURE = 512;
const AI_MARKDOWN_PARSE_COALESCE_MS = 0;
const AI_MARKDOWN_HISTORY_MAX_LIVE_NODES = 320;
const AI_MARKDOWN_LIVE_NODE_BUFFER = 60;
const AI_MARKDOWN_VIRTUAL_EMIT_INTERVAL_MS = 96;
const AI_MARKDOWN_VIRTUAL_HEIGHT_DIFF_THRESHOLD_PX = 4;

interface IAiMarkdownNormalizeCacheRecord {
  content: string;
  normalized: string;
}

const finalNormalizeCache = new Map<string, IAiMarkdownNormalizeCacheRecord>();

const buildFinalNormalizeCacheKey = (messageId: string, content: string): string => {
  if (content.length <= AI_MARKDOWN_LONG_CONTENT_TAIL_SIGNATURE) {
    return `${messageId}:${content.length}:${content}`;
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
};

if (!isKatexEnabled()) {
  enableKatex();
}

setDefaultI18nMap(AI_MARKDOWN_I18N_MAP);

const props = defineProps<{
  messageId: string;
  content: string;
  streamStatus?: IAiChatStreamRenderState['status'];
}>();

const emit = defineEmits<{
  heightChange: [metrics: MarkstreamVirtualMetrics];
  virtualStateChange: [state: MarkstreamVirtualState];
}>();

const virtualScrollContext = inject(AI_MARKDOWN_VIRTUAL_SCROLL_KEY, null);
const virtualState = ref<MarkstreamVirtualState | null>(null);
const isLiveStream = computed(
  () => props.streamStatus === 'streaming' || props.streamStatus === 'waiting-confirmation',
);
const isFinal = computed(() => !isLiveStream.value);
const hasSeenLiveStream = ref(isLiveStream.value);
const normalizedContent = computed(() =>
  normalizeMarkdownContent(props.messageId, props.content, isFinal.value),
);
const renderContent = ref(normalizedContent.value);

// markstream-vue 1.x 的 `smooth-streaming="auto"` 会在首次客户端渲染时避免 pacing 静态内容；
// 这对历史消息是对的，但对正在流式输出、且可能被虚拟列表重新挂载的消息会把当前 backlog 一次性渲染出来。
// 官方源码里只有 `smooth-streaming=true` 会强制首屏也进入 smooth stream controller，因此：
//  - 当前组件只要见过 live stream，就保持 smooth-streaming=true，直到组件卸载；final 只触发 finish。
//  - 历史/恢复消息没有见过 live stream，smooth-streaming=false，完整内容立即渲染，不慢放旧消息。
//  - typewriter=false 只关闭光标；平滑揭示由 smooth streaming + max-live-nodes=0 负责。
//  - smooth-streaming-options 固定 { startDelayMs: 0, flushOnFinish: false }：首屏即开始揭示，
//    final 不立即 flush，等 visible 追上 source 再定型，避免一块一块的 catch-up 突发。
const smoothStreaming = computed(() => hasSeenLiveStream.value);
const typewriter = false as const;
// 流式 pacing 选项：startDelayMs=0 让首屏即开始揭示；flushOnFinish=false 让 final 阶段等
// visible 追上 source 再定型（与 smooth-streaming=true 的 catch-up 行为配套）。
const smoothStreamingOptions = { startDelayMs: 0, flushOnFinish: false } as const;
const maxLiveNodes = computed(() =>
  hasSeenLiveStream.value ? 0 : AI_MARKDOWN_HISTORY_MAX_LIVE_NODES,
);
const rendererId = computed(() => `ai-message-${props.messageId}`);
const virtualSessionKey = computed(
  () => `${virtualScrollContext?.threadKey.value ?? 'active'}:${props.messageId}`,
);
const virtualScroll = computed<MarkstreamVirtualScrollOptions>(() => {
  const sessionKey = virtualSessionKey.value;
  const state = virtualState.value?.sessionKey === sessionKey ? virtualState.value : null;

  return {
    enabled: Boolean(virtualScrollContext),
    sessionKey,
    threadKey: virtualScrollContext?.threadKey.value,
    scrollRoot: () => virtualScrollContext?.scrollRoot.value ?? null,
    restoreState: state,
    restoreAnchor: false,
    measurementKey: virtualScrollContext?.measurementKey.value,
    settleMode: 'manual',
    settledToken: isFinal.value,
    emitIntervalMs: AI_MARKDOWN_VIRTUAL_EMIT_INTERVAL_MS,
    heightDiffThresholdPx: AI_MARKDOWN_VIRTUAL_HEIGHT_DIFF_THRESHOLD_PX,
  };
});
let pendingRenderContent: string | null = null;
let pendingRenderContentTimer: ReturnType<typeof window.setTimeout> | null = null;

watch(
  isLiveStream,
  (live) => {
    if (live) {
      hasSeenLiveStream.value = true;
    }
  },
  { immediate: true },
);

watch(virtualSessionKey, (sessionKey) => {
  if (virtualState.value?.sessionKey !== sessionKey) {
    virtualState.value = null;
  }
});

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
);

const handleVirtualHeightChange = (metrics: MarkstreamVirtualMetrics): void => {
  if (metrics.sessionKey !== virtualSessionKey.value) {
    return;
  }

  emit('heightChange', metrics);
  virtualScrollContext?.onHeightChange(metrics);
};

const handleVirtualStateChange = (state: MarkstreamVirtualState): void => {
  if (state.sessionKey !== virtualSessionKey.value) {
    return;
  }

  virtualState.value = state;
  emit('virtualStateChange', state);
};

const stopCodeBlockMapping = watch(
  rendererId,
  (customId, previousCustomId) => {
    if (previousCustomId) {
      removeCustomComponents(previousCustomId);
    }

    setCustomComponents(customId, AI_MARKDOWN_COMPONENTS);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  clearPendingRenderContentTimer();
  stopCodeBlockMapping();
  removeCustomComponents(rendererId.value);
});
</script>

<template>
  <div class="ai-markdown">
    <MarkdownRender
      :content="renderContent"
      :custom-id="rendererId"
      :final="isFinal"
      mode="chat"
      :defer-nodes-until-visible="false"
      :smooth-streaming="smoothStreaming"
      :smooth-streaming-options="smoothStreamingOptions"
      :parse-coalesce-ms="AI_MARKDOWN_PARSE_COALESCE_MS"
      :fade="false"
      :max-live-nodes="maxLiveNodes"
      :live-node-buffer="AI_MARKDOWN_LIVE_NODE_BUFFER"
      :virtual-scroll="virtualScroll"
      :batch-rendering="true"
      :initial-render-batch-size="24"
      :render-batch-size="16"
      :render-batch-delay="8"
      :render-batch-budget-ms="4"
      :show-tooltips="false"
      :typewriter="typewriter"
      @height-change="handleVirtualHeightChange"
      @virtual-state-change="handleVirtualStateChange"
    />
  </div>
</template>

<style scoped>
.ai-markdown {
  min-width: 0;
  font-size: var(--ai-chat-font-size-body, 14px);
  line-height: var(--ai-chat-line-height-body, 22px);
}

.ai-markdown :global(.markstream-vue) {
  --ms-font-sans: var(--font-sans);
  --ms-font-mono: var(--font-mono);
  --ms-radius: var(--radius-sm);
  --ms-text-body: var(--ai-chat-font-size-body, 14px);
  --ms-leading-body: var(--ai-chat-line-height-body-ratio, 1.5714285714);
  --ms-text-h1: var(--ai-chat-font-size-h1, 16px);
  --ms-text-h2: var(--ai-chat-font-size-h2, 14px);
  --ms-text-h3: var(--ai-chat-font-size-h3, 13px);
  --ms-text-h4: var(--ai-chat-font-size-h3, 13px);
  --ms-text-h5: var(--ai-chat-font-size-h3, 13px);
  --ms-text-h6: var(--ai-chat-font-size-h3, 13px);
  --ms-leading-h1: var(--ai-chat-line-height-h1-ratio, 1.5);
  --ms-leading-h2: var(--ai-chat-line-height-h2-ratio, 1.5714285714);
  --ms-leading-h3: var(--ai-chat-line-height-h3-ratio, 1.5384615385);
  --ms-weight-h1: var(--ai-chat-font-weight-strong, 600);
  --ms-weight-h2: var(--ai-chat-font-weight-strong, 600);
  --ms-weight-h3: var(--ai-chat-font-weight-strong, 600);
  --ms-weight-h4: var(--ai-chat-font-weight-strong, 600);
  --ms-flow-heading-1-mt: var(--ai-chat-space-section, 20px);
  --ms-flow-heading-1-mb: var(--ai-chat-space-paragraph, 12px);
  --ms-flow-heading-2-mt: var(--ai-chat-space-subsection, 14px);
  --ms-flow-heading-2-mb: 8px;
  --ms-flow-heading-3-mt: var(--ai-chat-space-subheading, 12px);
  --ms-flow-heading-3-mb: 6px;
  --ms-flow-heading-4-mt: var(--ai-chat-space-subheading, 12px);
  --ms-flow-heading-4-mb: 6px;
  --ms-flow-heading-5-mt: var(--ai-chat-space-subheading, 12px);
  --ms-flow-heading-6-mb: 6px;
  --ms-flow-heading-6-mt: var(--ai-chat-space-subheading, 12px);
  --ms-flow-codeblock-y: var(--ms-space-3);
  --ms-flow-table-y: var(--ai-chat-space-paragraph, 12px);
  --link-color: var(--accent-strong);
  --inline-code-bg: color-mix(in srgb, var(--panel-bg) 72%, transparent);
  --inline-code-fg: var(--text-primary);
  --code-bg: color-mix(in srgb, var(--editor-bg) 92%, transparent);
  --code-border: color-mix(in srgb, var(--shell-divider) 90%, transparent);
  --code-fg: var(--text-secondary);
  --code-action-fg: var(--text-tertiary);
  --code-action-hover-bg: var(--surface-soft);
  --code-action-hover-fg: var(--text-primary);
  --code-line-number: var(--text-quaternary);
  --table-border: var(--shell-divider);
  --table-header-bg: var(--surface-soft);
  --blockquote-border: color-mix(in srgb, var(--accent-strong) 46%, transparent);
  --blockquote-fg: var(--text-tertiary);
  --hr-border: var(--shell-divider);
  --focus-ring: color-mix(in srgb, var(--accent-strong) 60%, transparent);
  --stream-update-fade-duration: var(--motion-duration-slow);
  --stream-update-fade-ease: var(--motion-easing-standard);
  --markstream-code-font-family: var(--font-mono);
  --markstream-code-padding-x: var(--ms-space-3);
  --markstream-code-padding-y: var(--ms-space-2);
  --vscode-editor-font-size: var(--ai-chat-font-size-code, 13px);
  --vscode-editor-line-height: var(--ai-chat-line-height-code-ratio, 1.5384615385);
  color: inherit;
  font-family: var(--font-sans);
  font-size: var(--ai-chat-font-size-body, 14px);
  line-height: var(--ai-chat-line-height-body, 22px);
}

.ai-markdown :global(.markdown-renderer) {
  min-width: 0;
  font-size: var(--ai-chat-font-size-body, 14px);
  line-height: var(--ai-chat-line-height-body, 22px);
}

.ai-markdown :global(.paragraph-node:first-child),
.ai-markdown :global(.heading-node:first-child),
.ai-markdown :global(.list-node:first-child),
.ai-markdown :global(.blockquote:first-child),
.ai-markdown :global(.code-block-container:first-child) {
  margin-top: 0;
}

.ai-markdown :global(.paragraph-node:last-child),
.ai-markdown :global(.heading-node:last-child),
.ai-markdown :global(.list-node:last-child),
.ai-markdown :global(.blockquote:last-child),
.ai-markdown :global(.code-block-container:last-child) {
  margin-bottom: 0;
}

.ai-markdown :global(.paragraph-node) {
  color: inherit;
  margin: 0 0 var(--ai-chat-space-paragraph, 12px);
  font-size: var(--ai-chat-font-size-body, 14px);
  line-height: var(--ai-chat-line-height-body, 22px);
}

.ai-markdown :global(.heading-node) {
  color: var(--text-primary);
  font-size: inherit;
  line-height: inherit;
  letter-spacing: 0;
}

.ai-markdown :global(.heading-1),
.ai-markdown :global(.heading-2),
.ai-markdown :global(.heading-3),
.ai-markdown :global(.heading-4),
.ai-markdown :global(.heading-5),
.ai-markdown :global(.heading-6) {
  color: var(--text-primary);
  letter-spacing: 0;
  text-wrap: balance;
}

.ai-markdown :global(.heading-1) {
  font-size: var(--ai-chat-font-size-h1, 16px);
  line-height: var(--ai-chat-line-height-h1, 24px);
  font-weight: var(--ai-chat-font-weight-strong, 600);
}

.ai-markdown :global(.heading-2) {
  font-size: var(--ai-chat-font-size-h2, 14px);
  line-height: var(--ai-chat-line-height-h2, 22px);
  font-weight: var(--ai-chat-font-weight-strong, 600);
}

.ai-markdown :global(.heading-3),
.ai-markdown :global(.heading-4),
.ai-markdown :global(.heading-5),
.ai-markdown :global(.heading-6) {
  font-size: var(--ai-chat-font-size-h3, 13px);
  line-height: var(--ai-chat-line-height-h3, 20px);
  font-weight: var(--ai-chat-font-weight-strong, 600);
}

.ai-markdown :global(.list-node),
.ai-markdown :global(.list-node li),
.ai-markdown :global(.blockquote) {
  font-size: var(--ai-chat-font-size-body, 14px);
  line-height: var(--ai-chat-line-height-body, 22px);
}

.ai-markdown :global(.list-node),
.ai-markdown :global(.blockquote),
.ai-markdown :global(.code-block-container),
.ai-markdown :global(.table-node-wrapper) {
  margin: 0 0 var(--ai-chat-space-paragraph, 12px);
}

.ai-markdown :global(.inline-code) {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 80%, transparent);
  font-size: var(--ai-chat-font-size-code, 13px);
  line-height: var(--ai-chat-line-height-code, 20px);
  font-weight: 500;
}

.ai-markdown :global(.table-node),
.ai-markdown :global(.table-node th),
.ai-markdown :global(.table-node td),
.ai-markdown :global(.table-node .text-node),
.ai-markdown :global(.table-node code) {
  font-size: var(--ai-chat-font-size-table, 13px);
  line-height: var(--ai-chat-line-height-table, 20px);
}

.ai-markdown :global(.table-node thead th) {
  font-weight: var(--ai-chat-font-weight-strong, 600);
}

.ai-markdown :global(.emoji-node) {
  font-size: 1em;
  line-height: 1;
  vertical-align: -0.1em;
}

.ai-markdown :global(.link-node) {
  text-decoration: none;
}

.ai-markdown :global(.link-node:hover) {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.ai-markdown :global(.blockquote) {
  color: var(--blockquote-fg);
}

.ai-markdown :global(.table-node-wrapper) {
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  -ms-overflow-style: none;
  border-radius: var(--ms-radius);
  scrollbar-width: none;
}

.ai-markdown :global(.table-node-wrapper::-webkit-scrollbar) {
  height: 0;
}

@media (prefers-reduced-motion: reduce) {
  .ai-markdown :global(.markstream-vue *) {
    animation: none;
    transition-duration: 0ms;
  }
}
</style>

<style>
.ai-markdown .stretchy.fbox,
.ai-markdown .stretchy.fcolorbox {
  display: none;
}

.ai-markdown .boxpad {
  padding: 0;
}

.ai-markdown .table-node--loading tbody td>* {
  visibility: visible !important;
}

.ai-markdown .table-node--loading tbody td::after,
.ai-markdown .table-node__loading,
.ai-markdown .html-block-node__placeholder,
.ai-markdown .code-loading-placeholder,
.ai-markdown .loading-skeleton,
.ai-markdown .skeleton-line,
.ai-markdown .code-height-placeholder {
  display: none !important;
  animation: none !important;
  background: transparent !important;
}

/* 兜底：中和流式渲染期间任何骨架/占位块的深色背景与高度，避免黑块一闪而过 */
.ai-markdown [class*="skeleton"],
.ai-markdown [class*="placeholder"],
.ai-markdown [class*="--loading"] {
  background: transparent !important;
  background-color: transparent !important;
  box-shadow: none !important;
  animation: none !important;
  min-height: 0 !important;
}

</style>