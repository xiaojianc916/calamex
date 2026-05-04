<script setup lang="ts">
import 'katex/dist/katex.min.css';

import AiMarkdownCodeBlock from '@/components/business/ai/AiMarkdownCodeBlock.vue';
import type { IAiChatStreamRenderState } from '@/types/ai';
import { normalizeAiMath } from '@/utils/normalize-ai-math';
import type { CustomComponents } from 'markstream-vue';
import MarkdownRender, {
  enableKatex,
  isKatexEnabled,
  removeCustomComponents,
  setCustomComponents,
  setDefaultI18nMap,
} from 'markstream-vue';
import { computed, onBeforeUnmount, watch } from 'vue';

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
const isFinal = computed(() => props.streamStatus !== 'streaming');
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
:content="renderContent" :custom-id="rendererId" :final="isFinal" :defer-nodes-until-visible="false"
      :max-live-nodes="320" :live-node-buffer="80" :initial-render-batch-size="64" :render-batch-size="96"
      :render-batch-delay="0" :render-batch-budget-ms="8" :show-tooltips="false" :typewriter="false" />
  </div>
</template>

<style scoped>
.ai-markdown {
  min-width: 0;
}

.ai-markdown :global(.markstream-vue) {
  --ms-font-sans: var(--font-sans);
  --ms-font-mono: var(--font-mono);
  --ms-radius: var(--radius-sm);
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
  --markstream-code-font-family: var(--font-mono);
  --markstream-code-padding-x: var(--ms-space-3);
  --markstream-code-padding-y: var(--ms-space-2);
  --vscode-editor-font-size: 0.923em;
  --vscode-editor-line-height: 1.55;
  color: inherit;
  font-family: var(--font-sans);
  font-size: inherit;
  line-height: inherit;
}

.ai-markdown :global(.markdown-renderer) {
  min-width: 0;
  font-size: inherit;
  line-height: inherit;
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
  font-size: inherit;
  line-height: inherit;
}

.ai-markdown :global(.heading-node) {
  color: var(--text-primary);
  font-size: 1em;
  line-height: inherit;
  letter-spacing: 0;
}

.ai-markdown :global(.list-node),
.ai-markdown :global(.list-node li),
.ai-markdown :global(.blockquote),
.ai-markdown :global(.table-node) {
  font-size: inherit;
  line-height: inherit;
}

.ai-markdown :global(.inline-code) {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 80%, transparent);
  font-size: 0.92em;
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
  border-radius: var(--ms-radius);
}

.ai-markdown :global(.table-node) {
  border-color: var(--shell-divider);
  box-shadow: none;
}

.ai-markdown :global(.table-node th),
.ai-markdown :global(.table-node td) {
  border-color: var(--shell-divider);
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

.ai-markdown .text-node-stream-delta,
.ai-markdown .inline-code-stream-delta {
  animation: none !important;
  will-change: auto !important;
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
