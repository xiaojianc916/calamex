<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual';
import { computed, ref, watch } from 'vue';
import { cn } from '@/lib/utils';
import {
  createRawTokens,
  highlightCode,
  type ICodeMirrorHighlightToken,
  type ITokenizedCode,
  isBold,
  isItalic,
  isUnderline,
} from './utils';

const props = withDefaults(
  defineProps<{
    code: string;
    language: string;
    showLineNumbers?: boolean;
  }>(),
  {
    showLineNumbers: false,
  },
);

interface IKeyedToken {
  token: ICodeMirrorHighlightToken;
  key: string;
}

interface IKeyedLine {
  tokens: IKeyedToken[];
  key: string;
  lineIndex: number;
}

const rawTokens = computed(() => createRawTokens(props.code));
const tokenized = ref<ITokenizedCode>(highlightCode(props.code, props.language) ?? rawTokens.value);

watch(
  () => [props.code, props.language] as const,
  ([code, language]) => {
    tokenized.value = highlightCode(code, language) ?? createRawTokens(code);
    highlightCode(code, language, (result) => {
      tokenized.value = result;
    });
  },
  { immediate: true },
);

const preStyle = computed(() => ({
  backgroundColor: tokenized.value.bg,
  color: tokenized.value.fg,
}));

const keyedLines = computed<IKeyedLine[]>(() =>
  tokenized.value.tokens.map((line, lineIndex) => ({
    key: `line-${lineIndex}`,
    lineIndex,
    tokens: line.map((token, tokenIndex) => ({
      token,
      key: `line-${lineIndex}-${tokenIndex}`,
    })),
  })),
);

// —— 大代码块虚拟化（复用 @tanstack/vue-virtual）——
// 仅当「不显示行号」且行数超过阈值时启用；否则保持原生整体渲染（含 CSS 行号计数器），零风险。
const CODE_VIRTUALIZE_THRESHOLD = 300;
const CODE_LINE_HEIGHT = 20; // text-sm 等高行的估算行高
const scrollRef = ref<HTMLElement | null>(null);

const shouldVirtualize = computed(
  () => !props.showLineNumbers && keyedLines.value.length > CODE_VIRTUALIZE_THRESHOLD,
);

const virtualizerOptions = computed(() => ({
  count: keyedLines.value.length,
  getScrollElement: (): HTMLElement | null => (shouldVirtualize.value ? scrollRef.value : null),
  estimateSize: () => CODE_LINE_HEIGHT,
  overscan: 24,
  getItemKey: (index: number): string => keyedLines.value[index]?.key ?? String(index),
}));
const codeVirtualizer = useVirtualizer<HTMLElement, HTMLElement>(virtualizerOptions);
const totalSize = computed(() => codeVirtualizer.value.getTotalSize());

const windowedLines = computed<IKeyedLine[]>(() => {
  if (!shouldVirtualize.value) {
    return keyedLines.value;
  }

  const lines = keyedLines.value;
  const result: IKeyedLine[] = [];
  for (const item of codeVirtualizer.value.getVirtualItems()) {
    const line = lines[item.index];
    if (line) {
      result.push(line);
    }
  }
  return result;
});

const paddingTop = computed(() => {
  if (!shouldVirtualize.value) {
    return 0;
  }
  const items = codeVirtualizer.value.getVirtualItems();
  return items.length > 0 ? (items[0]?.start ?? 0) : 0;
});

const paddingBottom = computed(() => {
  if (!shouldVirtualize.value) {
    return 0;
  }
  const items = codeVirtualizer.value.getVirtualItems();
  if (items.length === 0) {
    return 0;
  }
  const lastItem = items[items.length - 1];
  const lastEnd = (lastItem?.start ?? 0) + (lastItem?.size ?? 0);
  return Math.max(0, totalSize.value - lastEnd);
});

const lineNumberClasses = cn(
  'block',
  'before:content-[counter(line)]',
  'before:inline-block',
  'before:[counter-increment:line]',
  'before:w-8',
  'before:mr-4',
  'before:text-right',
  'before:text-muted-foreground/50',
  'before:font-mono',
  'before:select-none',
);
</script>

<template>
  <div ref="scrollRef" class="relative overflow-auto">
    <pre :class="cn(
      'm-0 p-4 text-sm',
    )" :style="preStyle"><code
      :class="cn(
        'font-mono text-sm',
        showLineNumbers && '[counter-increment:line_0] [counter-reset:line]',
      )"
    ><span v-if="shouldVirtualize" aria-hidden="true" :style="{ display: 'block', height: `${paddingTop}px` }"></span><template v-for="line in windowedLines" :key="line.key"><span :class="showLineNumbers ? lineNumberClasses : 'block'"><template v-if="line.tokens.length === 0">{{ '\n' }}</template><template
  v-else><span
      v-for="tokenObj in line.tokens"
      :key="tokenObj.key"
      :style="{
        color: tokenObj.token.color,
        backgroundColor: tokenObj.token.bgColor,
        ...tokenObj.token.htmlStyle,
        fontStyle: isItalic(tokenObj.token.fontStyle) ? 'italic' : undefined,
        fontWeight: isBold(tokenObj.token.fontStyle) ? 'bold' : undefined,
        textDecoration: isUnderline(tokenObj.token.fontStyle) ? 'underline' : undefined,
      }"
    >{{ tokenObj.token.content }}</span></template></span></template><span v-if="shouldVirtualize" aria-hidden="true"
  :style="{ display: 'block', height: `${paddingBottom}px` }"></span></code></pre>
  </div>
</template>
