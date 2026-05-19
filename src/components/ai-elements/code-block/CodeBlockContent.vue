<script setup lang="ts">
import { cn } from '@/lib/utils';
import type { BundledLanguage, ThemedToken } from 'shiki';
import { computed, ref, watch } from 'vue';
import { createRawTokens, highlightCode, type ITokenizedCode, isBold, isItalic, isUnderline } from './utils';

const props = withDefaults(
  defineProps<{
    code: string;
    language: BundledLanguage;
    showLineNumbers?: boolean;
  }>(),
  {
    showLineNumbers: false,
  },
);

interface IKeyedToken {
  token: ThemedToken;
  key: string;
}

interface IKeyedLine {
  tokens: IKeyedToken[];
  key: string;
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
    tokens: line.map((token, tokenIndex) => ({
      token,
      key: `line-${lineIndex}-${tokenIndex}`,
    })),
  })),
);

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
  <div class="relative overflow-auto">
    <pre
      :class="cn(
        'm-0 p-4 text-sm',
      )"
      :style="preStyle"
    ><code
      :class="cn(
        'font-mono text-sm',
        showLineNumbers && '[counter-increment:line_0] [counter-reset:line]',
      )"
    ><template v-for="line in keyedLines" :key="line.key"><span :class="showLineNumbers ? lineNumberClasses : 'block'"><template v-if="line.tokens.length === 0">{{ '\n' }}</template><template v-else><span
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
    >{{ tokenObj.token.content }}</span></template></span></template></code></pre>
  </div>
</template>
