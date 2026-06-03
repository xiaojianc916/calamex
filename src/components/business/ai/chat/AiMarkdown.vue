<script setup lang="ts">
import 'katex/dist/katex.min.css';

import type { CustomComponents } from 'markstream-vue';
import MarkdownRender, {
  enableKatex,
  isKatexEnabled,
  removeCustomComponents,
  setCustomComponents,
  setDefaultI18nMap,
} from 'markstream-vue';
import { computed, onBeforeUnmount, watch } from 'vue';
import AiMarkdownCodeBlock from '@/components/business/ai/chat/AiMarkdownCodeBlock.vue';
import AiMarkdownTable from '@/components/business/ai/chat/AiMarkdownTable.vue';
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

if (!isKatexEnabled()) {
  enableKatex();
}

setDefaultI18nMap(AI_MARKDOWN_I18N_MAP);

const props = defineProps<{
  messageId: string;
  content: string;
  streamStatus?: IAiChatStreamRenderState['status'];
}>();

const renderContent = computed(() => normalizeAiMath(props.content));
const isFinal = computed(
  () => props.streamStatus !== 'streaming' && props.streamStatus !== 'waiting-confirmation',
);

// 保留 markstream-vue 的平滑流式（smooth-streaming），但按用户要求关闭打字机光标效果。
//
//  - smooth-streaming 用 "auto"：backlog-aware 平滑分发，待显示文本堆积时自动加速追平。
//    注意：当 max-live-nodes<=0 时，"auto" 依旧启用平滑分发，因此关闭 typewriter 不会影响
//    “文本连续平滑揭示”，只是去掉逐字蹦出的打字光标。
//  - max-live-nodes 始终为 0：启用增量/批量渲染，且不在 final 时跳变。
//  - typewriter 关闭：不再显示一个字一个字蹦出的打字光标；平滑输出仍由 smooth-streaming +
//    max-live-nodes=0 提供。final 只负责让未闭合的 Markdown 结构（如未闭合代码块/公式）定型。
const smoothStreaming = 'auto' as const;
const typewriter = false as const;
// 始终关闭虚拟化(max-live-nodes=0)：既启用增量/批量渲染，也保证 final 收尾时平滑分发不被中断。
const maxLiveNodes = 0;
const rendererId = computed(() => `ai-message-${props.messageId}`);

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
      :defer-nodes-until-visible="false"
      :smooth-streaming="smoothStreaming"
      :fade="false"
      :max-live-nodes="maxLiveNodes"
      :batch-rendering="true"
      :initial-render-batch-size="24"
      :render-batch-size="16"
      :render-batch-delay="8"
      :render-batch-budget-ms="4"
      :show-tooltips="false"
      :typewriter="typewriter"
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
  --ms-flow-heading-5-mb: 6px;
  --ms-flow-heading-6-mt: var(--ai-chat-space-subheading, 12px);
  --ms-flow-heading-6-mb: 6px;
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
  --ms-flow-codeblock-y: var(--ms-space-3);
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
</style>
