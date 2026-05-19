<script setup lang="ts">
import {
    CodeBlock,
    CodeBlockActions,
    CodeBlockCopyButton,
    CodeBlockFilename,
    CodeBlockHeader,
    CodeBlockTitle,
} from '@/components/ai-elements/code-block';
import { normalizeLanguageTag, resolveShikiLanguage, SHIKI_LANGUAGE_LABELS } from '@/utils/shiki-language';
import ChevronDown from '~icons/lucide/chevron-down';
import ChevronUp from '~icons/lucide/chevron-up';
import FileIcon from '~icons/lucide/file';
import { computed, ref } from 'vue';

const props = withDefaults(defineProps<{
    code: string;
    language?: string;
    fenceInfo?: string;
}>(), {
    language: '',
    fenceInfo: '',
});

const isExpanded = ref(true);

const normalizedLanguage = computed(() => normalizeLanguageTag(props.language || props.fenceInfo));
const shikiLanguage = computed(() => resolveShikiLanguage(normalizedLanguage.value));
const languageLabel = computed(() => SHIKI_LANGUAGE_LABELS[shikiLanguage.value] ?? shikiLanguage.value);
const filename = computed(() => resolveCodeBlockFilename(props.fenceInfo, languageLabel.value));

function resolveCodeBlockFilename(info: string, fallback: string): string {
    const infoParts = info.trim().split(/\s+/u).filter(Boolean);
    const filename = infoParts
        .map((part) => part.includes(':') ? part.slice(part.indexOf(':') + 1) : part)
        .find((part) => /[./\\-]/u.test(part));

    return filename || fallback;
}

function toggleExpanded(): void {
    isExpanded.value = !isExpanded.value;
}

function handleCopy(): void {
    // 复制状态由 CodeBlockCopyButton 自己管理。
}

function handleError(error: Error): void {
    console.error('复制代码失败', error);
}
</script>

<template>
    <CodeBlock class="ai-reasoning-code-block" :class="{ 'is-collapsed': !isExpanded }" :code="props.code"
        :language="shikiLanguage">
        <CodeBlockHeader class="ai-reasoning-code-block__header">
            <CodeBlockTitle class="ai-reasoning-code-block__title">
                <FileIcon :size="15" aria-hidden="true" />
                <CodeBlockFilename class="ai-reasoning-code-block__filename">
                    {{ filename }}
                </CodeBlockFilename>
            </CodeBlockTitle>

            <CodeBlockActions class="ai-reasoning-code-block__actions">
                <span class="ai-reasoning-code-block__language">{{ languageLabel }}</span>
                <button type="button" class="ai-reasoning-code-block__icon-button"
                    :aria-label="isExpanded ? '折叠代码块' : '展开代码块'" :title="isExpanded ? '折叠代码块' : '展开代码块'"
                    :aria-expanded="isExpanded" @click="toggleExpanded">
                    <ChevronUp v-if="isExpanded" :size="15" aria-hidden="true" />
                    <ChevronDown v-else :size="15" aria-hidden="true" />
                </button>
                <CodeBlockCopyButton class="ai-reasoning-code-block__copy" aria-label="复制代码" title="复制代码"
                    @copy="handleCopy" @error="handleError" />
            </CodeBlockActions>
        </CodeBlockHeader>
    </CodeBlock>
</template>

<style scoped>
.ai-reasoning-code-block {
    width: 100%;
    min-width: 0;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--shell-divider) 76%, transparent);
    border-radius: 8px;
    background: #ffffff;
    color: var(--text-primary);
}

.ai-reasoning-code-block__header {
    min-height: 44px;
    border-bottom: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
    background: #f6f6f7;
    color: var(--text-secondary);
    padding: 0 14px;
}

.ai-reasoning-code-block.is-collapsed .ai-reasoning-code-block__header {
    border-bottom-color: transparent;
}

.ai-reasoning-code-block__title {
    min-width: 0;
    gap: 10px;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 20px;
}

.ai-reasoning-code-block__filename {
    min-width: 0;
    overflow: hidden;
    color: inherit;
    font-family: var(--font-mono);
    font-size: inherit;
    line-height: inherit;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ai-reasoning-code-block__actions {
    flex: 0 0 auto;
    gap: 8px;
}

.ai-reasoning-code-block__language {
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 20px;
    white-space: nowrap;
}

.ai-reasoning-code-block__icon-button,
.ai-reasoning-code-block__copy {
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

.ai-reasoning-code-block__icon-button:hover,
.ai-reasoning-code-block__icon-button:focus-visible,
.ai-reasoning-code-block__copy:hover,
.ai-reasoning-code-block__copy:focus-visible {
    background: color-mix(in srgb, var(--surface-soft) 84%, transparent);
    color: var(--text-primary);
}

.ai-reasoning-code-block__icon-button:focus-visible,
.ai-reasoning-code-block__copy:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent-strong) 44%, transparent);
    outline-offset: 2px;
}

.ai-reasoning-code-block :deep(> .relative) {
    background: #ffffff;
}

.ai-reasoning-code-block :deep(pre) {
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

.ai-reasoning-code-block :deep(code) {
    display: block;
    min-width: max-content;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
    white-space: pre;
}

.ai-reasoning-code-block :deep(pre::-webkit-scrollbar) {
    width: 6px;
    height: 6px;
}

.ai-reasoning-code-block :deep(pre::-webkit-scrollbar-track) {
    background: transparent;
}

.ai-reasoning-code-block :deep(pre::-webkit-scrollbar-thumb) {
    border-radius: 999px;
    background: color-mix(in srgb, var(--text-quaternary) 56%, transparent);
}

.ai-reasoning-code-block :deep(pre::-webkit-scrollbar-button) {
    display: none;
    width: 0;
    height: 0;
}

.ai-reasoning-code-block.is-collapsed :deep(> .relative) {
    display: none;
}

@media (prefers-reduced-motion: reduce) {

    .ai-reasoning-code-block,
    .ai-reasoning-code-block * {
        transition-duration: 0ms;
    }
}
</style>
