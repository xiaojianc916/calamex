<script setup lang="ts">
import { ChevronDown, ChevronUp, File } from '@lucide/vue';
import type { CodeBlockNodeProps } from 'markstream-vue';
import { computed, ref, watch } from 'vue';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ai-elements/code-block';
import {
  CODEMIRROR_LANGUAGE_LABELS,
  normalizeCodeMirrorLanguageTag,
  resolveCodeMirrorLanguageId,
} from '@/services/editor/codemirror-language';

const props = defineProps<Pick<CodeBlockNodeProps, 'node'>>();

const isExpanded = ref(true);
const renderedSourceCode = ref(getCurrentSourceCode());

const normalizedLanguage = computed(() => normalizeCodeMirrorLanguageTag(props.node.language));
const codeMirrorLanguage = computed(() => resolveCodeMirrorLanguageId(normalizedLanguage.value));
const languageLabel = computed(
  () => CODEMIRROR_LANGUAGE_LABELS[codeMirrorLanguage.value] ?? codeMirrorLanguage.value,
);
const filename = computed(() =>
  resolveCodeBlockFilename(String(props.node.raw ?? ''), languageLabel.value),
);

watch(
  () => [props.node, props.node.code] as const,
  () => {
    syncSourceCodeFromNode();
  },
  { immediate: true },
);

function getCurrentSourceCode(): string {
  return String(props.node.code ?? '');
}

function syncSourceCodeFromNode(): boolean {
  const sourceCode = getCurrentSourceCode();

  if (renderedSourceCode.value === sourceCode) {
    return false;
  }

  renderedSourceCode.value = sourceCode;
  return true;
}

function resolveCodeBlockFilename(raw: string, fallback: string): string {
  const firstLine = raw.split(/\r?\n/u, 1)[0]?.trim() ?? '';

  if (!firstLine.startsWith('```') && !firstLine.startsWith('~~~')) {
    return fallback;
  }

  const info = firstLine.slice(3).trim();
  const infoParts = info.split(/\s+/u).filter(Boolean);
  const filename = infoParts
    .map((part) => (part.includes(':') ? part.slice(part.indexOf(':') + 1) : part))
    .find((part) => /[./\\-]/u.test(part));

  return filename || fallback;
}

function toggleExpanded(): void {
  const didRecoverStaleCode = syncSourceCodeFromNode();

  if (isExpanded.value && didRecoverStaleCode && renderedSourceCode.value.trim()) {
    return;
  }

  isExpanded.value = !isExpanded.value;
}

function handleCopy(): void {
  // 复制状态由 CodeBlockCopyButton 自己管理，这里保留事件出口便于调试。
}

function handleError(error: Error): void {
  console.error('复制代码失败', error);
}
</script>

<template>
  <CodeBlock
    class="ai-markdown-code-block"
    :class="{ 'is-collapsed': !isExpanded }"
    :code="renderedSourceCode"
    :language="codeMirrorLanguage"
  >
    <CodeBlockHeader class="ai-markdown-code-block__header">
      <CodeBlockTitle class="ai-markdown-code-block__title">
        <File :size="15" aria-hidden="true" />
        <CodeBlockFilename class="ai-markdown-code-block__filename">
          {{ filename }}
        </CodeBlockFilename>
      </CodeBlockTitle>

      <CodeBlockActions class="ai-markdown-code-block__actions">
        <span class="ai-markdown-code-block__language">{{ languageLabel }}</span>
        <button
          type="button"
          class="ai-markdown-code-block__icon-button"
          :aria-label="isExpanded ? '折叠代码块' : '展开代码块'"
          :title="isExpanded ? '折叠代码块' : '展开代码块'"
          :aria-expanded="isExpanded"
          @click="toggleExpanded"
        >
          <ChevronUp v-if="isExpanded" :size="15" aria-hidden="true" />
          <ChevronDown v-else :size="15" aria-hidden="true" />
        </button>
        <CodeBlockCopyButton
          class="ai-markdown-code-block__copy"
          aria-label="复制代码"
          title="复制代码"
          @copy="handleCopy"
          @error="handleError"
        />
      </CodeBlockActions>
    </CodeBlockHeader>
  </CodeBlock>
</template>

<style scoped>
.ai-markdown-code-block {
  width: 100%;
  min-width: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 76%, transparent);
  border-radius: 8px;
  background: #ffffff;
  color: var(--text-primary);
}

.ai-markdown-code-block__header {
  min-height: 44px;
  border-bottom: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
  background: #f6f6f7;
  color: var(--text-secondary);
  padding: 0 14px;
}

.ai-markdown-code-block.is-collapsed .ai-markdown-code-block__header {
  border-bottom-color: transparent;
}

.ai-markdown-code-block__title {
  min-width: 0;
  gap: 10px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 20px;
}

.ai-markdown-code-block__filename {
  min-width: 0;
  overflow: hidden;
  color: inherit;
  font-family: var(--font-mono);
  font-size: inherit;
  line-height: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-markdown-code-block__actions {
  flex: 0 0 auto;
  gap: 8px;
}

.ai-markdown-code-block__language {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
}

.ai-markdown-code-block__icon-button,
.ai-markdown-code-block__copy {
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}

.ai-markdown-code-block__icon-button:hover,
.ai-markdown-code-block__icon-button:focus-visible,
.ai-markdown-code-block__copy:hover,
.ai-markdown-code-block__copy:focus-visible {
  background: color-mix(in srgb, var(--surface-soft) 84%, transparent);
  color: var(--text-primary);
}

.ai-markdown-code-block__icon-button:focus-visible,
.ai-markdown-code-block__copy:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong) 44%, transparent);
  outline-offset: 2px;
}

.ai-markdown-code-block :deep(> .relative) {
  background: #ffffff;
}

.ai-markdown-code-block :deep(pre) {
  margin: 0;
  overflow: auto;
  background: #ffffff !important;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--ai-chat-font-size-code, 13px);
  line-height: var(--ai-chat-line-height-code, 20px);
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--text-quaternary) 56%, transparent) transparent;
}

.ai-markdown-code-block :deep(code) {
  display: block;
  min-width: max-content;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  white-space: pre;
}

.ai-markdown-code-block :deep(pre::-webkit-scrollbar) {
  width: 6px;
  height: 6px;
}

.ai-markdown-code-block :deep(pre::-webkit-scrollbar-track) {
  background: transparent;
}

.ai-markdown-code-block :deep(pre::-webkit-scrollbar-thumb) {
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-quaternary) 56%, transparent);
}

.ai-markdown-code-block :deep(pre::-webkit-scrollbar-button) {
  display: none;
  width: 0;
  height: 0;
}

.ai-markdown-code-block.is-collapsed :deep(> .relative) {
  display: none;
}

@media (prefers-reduced-motion: reduce) {

  .ai-markdown-code-block,
  .ai-markdown-code-block * {
    transition-duration: 0ms;
  }
}
</style>
