<script setup lang="ts">
import type { CodeBlockNodeProps } from 'markstream-vue';
import type { ThemeRegistration } from 'shiki';
import { codeToHtml } from 'shiki';
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';

const COPY_RESET_DELAY_MS = 1600;
const MAX_SYNC_HIGHLIGHT_CHARS = 20_000;

const props = defineProps<Pick<CodeBlockNodeProps, 'isDark' | 'loading' | 'node'>>();

const isCopied = ref(false);
const isExpanded = ref(true);
const codeBlockBodyId = useId();
const highlightedHtml = ref('');

let copyResetTimer: number | undefined;
let highlightRequestId = 0;

const normalizedLanguage = computed(() => normalizeLanguageTag(props.node.language));
const codeLanguageLabel = computed(() => normalizedLanguage.value || 'text');

const canCopy = computed(
  () => typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function',
);

const isSingleLineCode = computed(() => {
  const code = String(props.node.code ?? '').trimEnd();
  return code.split(/\r\n|\r|\n/).length <= 1;
});

/**
 * Shiki 自定义主题：
 * 高亮引擎换成 Shiki，但颜色沿用你原来的 hljs 配色。
 */
const AI_CODE_SHIKI_THEME: ThemeRegistration = {
  name: 'ai-code-theme',
  type: 'dark',
  colors: {
    'editor.background': '#1a1b1e',
    'editor.foreground': '#e7edf4',
  },
  settings: [
    {
      settings: {
        foreground: '#e7edf4',
        background: '#1a1b1e',
      },
    },
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: {
        foreground: '#7c8797',
      },
    },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'constant.language',
        'keyword.control',
        'keyword.operator.expression',
      ],
      settings: {
        foreground: '#ff7ab2',
      },
    },
    {
      scope: ['string', 'string.quoted', 'constant.other.symbol', 'constant.other.key'],
      settings: {
        foreground: '#9ed072',
      },
    },
    {
      scope: ['constant.numeric', 'constant.character', 'variable.other.constant'],
      settings: {
        foreground: '#ffb86c',
      },
    },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call', 'variable.function'],
      settings: {
        foreground: '#82aaff',
      },
    },
    {
      scope: ['entity.name.type', 'entity.name.class', 'support.class', 'support.type', 'storage.type.class'],
      settings: {
        foreground: '#7dd3fc',
      },
    },
    {
      scope: ['entity.name.tag', 'entity.other.attribute-name', 'support.type.property-name', 'variable.other.property'],
      settings: {
        foreground: '#f8c555',
      },
    },
    {
      scope: ['meta', 'keyword.operator', 'punctuation.definition.template-expression'],
      settings: {
        foreground: '#c792ea',
      },
    },
    {
      scope: ['punctuation', 'punctuation.separator', 'punctuation.terminator'],
      settings: {
        foreground: '#c6d0dd',
      },
    },
    {
      scope: ['markup.inserted', 'diff.inserted'],
      settings: {
        foreground: '#9ed072',
      },
    },
    {
      scope: ['markup.deleted', 'diff.deleted'],
      settings: {
        foreground: '#ff8f8f',
      },
    },
  ],
};

watch(
  () => [props.node.code, normalizedLanguage.value, props.loading] as const,
  async ([code, language, isLoading]) => {
    const requestId = ++highlightRequestId;
    const sourceCode = String(code ?? '');
    const lang = toShikiLanguage(language);

    highlightedHtml.value = buildPlainCodeHtml(sourceCode);

    if (isLoading || Array.from(sourceCode).length > MAX_SYNC_HIGHLIGHT_CHARS) {
      return;
    }

    try {
      const html = await codeToHtml(sourceCode, {
        lang,
        theme: AI_CODE_SHIKI_THEME,
      });

      if (requestId === highlightRequestId) {
        highlightedHtml.value = html;
      }
    } catch {
      try {
        const html = await codeToHtml(sourceCode, {
          lang: 'plaintext',
          theme: AI_CODE_SHIKI_THEME,
        });

        if (requestId === highlightRequestId) {
          highlightedHtml.value = html;
        }
      } catch {
        if (requestId === highlightRequestId) {
          highlightedHtml.value = buildPlainCodeHtml(sourceCode);
        }
      }
    }
  },
  { immediate: true },
);

function normalizeLanguageTag(language: string): string {
  return String(language ?? '')
    .split(':')[0]
    .trim()
    .toLowerCase();
}

function toShikiLanguage(language: string): string {
  const normalized = normalizeLanguageTag(language);

  const languageMap: Record<string, string> = {
    '': 'plaintext',
    text: 'plaintext',
    txt: 'plaintext',
    plain: 'plaintext',
    plaintext: 'plaintext',

    shell: 'bash',
    sh: 'bash',
    zsh: 'bash',
    bash: 'bash',

    ps: 'powershell',
    pwsh: 'powershell',
    powershell: 'powershell',

    cmd: 'bat',
    batch: 'bat',
    bat: 'bat',

    c: 'c',
    h: 'c',
    cpp: 'cpp',
    'c++': 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',

    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    javascript: 'javascript',

    jsx: 'jsx',

    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    typescript: 'typescript',

    tsx: 'tsx',

    vue: 'vue',

    py: 'python',
    python: 'python',

    rb: 'ruby',
    ruby: 'ruby',

    rs: 'rust',
    rust: 'rust',

    go: 'go',

    java: 'java',

    yml: 'yaml',
    yaml: 'yaml',

    md: 'markdown',
    markdown: 'markdown',

    jsonc: 'jsonc',
    json: 'json',

    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',

    sql: 'sql',
    xml: 'xml',
    dockerfile: 'dockerfile',
  };

  return languageMap[normalized] ?? normalized;
}

function buildPlainCodeHtml(code: string): string {
  return `<pre class="shiki ai-code-block__plain"><code>${escapeHtml(code)}</code></pre>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clearCopyResetTimer(): void {
  if (copyResetTimer === undefined) {
    return;
  }

  window.clearTimeout(copyResetTimer);
  copyResetTimer = undefined;
}

function scheduleCopyReset(): void {
  clearCopyResetTimer();
  copyResetTimer = window.setTimeout(() => {
    isCopied.value = false;
    copyResetTimer = undefined;
  }, COPY_RESET_DELAY_MS);
}

async function handleCopy(): Promise<void> {
  if (!canCopy.value) {
    return;
  }

  await navigator.clipboard.writeText(props.node.code);
  isCopied.value = true;
  scheduleCopyReset();
}

function toggleExpanded(): void {
  isExpanded.value = !isExpanded.value;
}

onBeforeUnmount(() => {
  clearCopyResetTimer();
});
</script>

<template>
  <div
class="code-block-container ai-code-block" :class="{
    'is-loading': loading,
    'is-light-surface': !isDark,
    'is-collapsed': !isExpanded,
    'is-single-line': isSingleLineCode,
  }">
    <div class="code-block-header ai-code-block__header">
      <div class="code-header-main">
        <div class="code-header-copy">
          <span class="code-header-title">{{ codeLanguageLabel }}</span>
        </div>
      </div>

      <div class="code-header-actions ai-code-block__actions">
        <button
type="button" class="code-action-btn ai-code-block__icon-button ai-code-block__toggle"
          :aria-label="isExpanded ? '折叠代码块' : '展开代码块'" :title="isExpanded ? '折叠代码块' : '展开代码块'"
          :aria-expanded="isExpanded" :aria-controls="codeBlockBodyId" @click="toggleExpanded">
          <svg v-if="isExpanded" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M6 15l6-6 6 6" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        <button
type="button" class="code-action-btn ai-code-block__icon-button ai-code-block__copy"
          :aria-label="isCopied ? '已复制代码' : '复制代码'" :title="isCopied ? '已复制代码' : '复制代码'" :disabled="!canCopy"
          @click="handleCopy">
          <svg v-if="isCopied" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M5 12.5l4.2 4.2L19 7" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <rect x="9" y="9" width="10" height="10" rx="2" />
            <path d="M5 15V7a2 2 0 0 1 2-2h8" />
          </svg>
        </button>
      </div>
    </div>

    <div v-show="isExpanded" :id="codeBlockBodyId" class="ai-code-block__body">
      <div class="ai-code-block__highlight ai-markdown-design-body" v-html="highlightedHtml" />
    </div>
  </div>
</template>

<style scoped>
.ai-code-block {
  inline-size: 100%;
  min-inline-size: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
  border-radius: 8px;
  background: #1a1b1e;
  color: #e7edf4;
}

.ai-code-block__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid rgb(255 255 255 / 0.08);
}

.ai-code-block.is-collapsed .ai-code-block__header {
  border-bottom-color: transparent;
}

.ai-code-block__actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.ai-code-block__icon-button {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  border: 0;
  padding: 0;
  background: transparent;
  color: rgb(244 247 251 / 0.72);
  cursor: pointer;
}

.ai-code-block__icon-button:hover:enabled,
.ai-code-block__icon-button:focus-visible {
  color: #ffffff;
}

.ai-code-block__icon-button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong) 60%, transparent);
  outline-offset: 4px;
}

.ai-code-block__icon-button:disabled {
  opacity: 0.52;
  cursor: not-allowed;
}

.ai-code-block__icon-button svg {
  width: 15px;
  height: 15px;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ai-code-block__body {
  min-inline-size: 0;
}

.ai-code-block__highlight {
  min-inline-size: 0;
}

/* Shiki 输出结构：pre.shiki > code > span */
.ai-code-block :global(pre.shiki) {
  margin: 0;
  padding: 14px 16px 16px;
  overflow: auto;
  border: 0;
  border-radius: 0 0 8px 8px;
  background: #1a1b1e !important;
  color: #e7edf4;
  font-family: var(--font-mono);
  font-size: 0.92em;
  line-height: 1.65;

  /* Firefox 滚动条 */
  scrollbar-width: thin;
  scrollbar-color: rgb(255 255 255 / 0.18) transparent;
}

.ai-code-block :global(pre.shiki code) {
  display: block;
  min-inline-size: max-content;
  padding: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  white-space: pre;
}

.ai-code-block :global(pre.shiki span) {
  font-family: inherit;
}

/* Chrome / Edge / Safari：滚动条变小 */
.ai-code-block :global(pre.shiki)::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.ai-code-block :global(pre.shiki)::-webkit-scrollbar-track {
  background: transparent;
}

.ai-code-block :global(pre.shiki)::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgb(255 255 255 / 0.18);
}

.ai-code-block :global(pre.shiki)::-webkit-scrollbar-thumb:hover {
  background: rgb(255 255 255 / 0.28);
}

/* 去掉横向滚动条两侧像箭头一样的按钮 */
.ai-code-block :global(pre.shiki)::-webkit-scrollbar-button {
  display: none;
  width: 0;
  height: 0;
  background: transparent;
}

.ai-code-block :global(pre.shiki)::-webkit-scrollbar-button:single-button {
  display: none;
  width: 0;
  height: 0;
}

.ai-code-block :global(pre.shiki)::-webkit-scrollbar-corner {
  background: transparent;
}

/* 单行代码块：上下距离一致，稍微松一点 */
.ai-code-block.is-single-line .ai-code-block__header {
  padding: 7px 12px;
}

.ai-code-block.is-single-line :global(pre.shiki) {
  padding: 10px 16px;
  overflow-x: auto;
  overflow-y: hidden;
  line-height: 1.45;
}

.ai-code-block.is-single-line :global(pre.shiki code) {
  line-height: inherit;
}

@media (prefers-reduced-motion: reduce) {

  .ai-code-block,
  .ai-code-block * {
    transition-duration: 0ms;
  }
}
</style>
