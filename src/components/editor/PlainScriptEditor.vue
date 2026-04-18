<template>
  <div class="h-full min-h-0 bg-[var(--editor-bg)] px-0 py-0">
    <textarea
      ref="textareaRef"
      class="mono-text h-full w-full resize-none border-0 bg-transparent px-6 py-5 text-[13px] leading-6 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
      :value="modelValue"
      spellcheck="false"
      placeholder="# 在这里编写 shell 脚本。&#10;# 运行前请确认编码为 UTF-8（无 BOM）。"
      @input="handleInput"
      @click="handleCursorActivity"
      @focus="handleCursorActivity"
      @keyup="handleCursorActivity"
      @mouseup="handleCursorActivity"
      @select="handleCursorActivity"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

interface IEditorExpose {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
}

defineProps<{
  modelValue: string;
  theme?: 'dark' | 'light';
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  'cursor-position-change': [line: number, column: number];
}>();

const textareaRef = ref<HTMLTextAreaElement | null>(null);

const resolveCursorPosition = (
  content: string,
  selectionStart: number,
): { line: number; column: number } => {
  const safeIndex = Math.max(0, Math.min(selectionStart, content.length));
  const textBeforeCursor = content.slice(0, safeIndex);
  const lines = textBeforeCursor.split('\n');

  return {
    line: Math.max(1, lines.length),
    column: (lines.length > 0 ? (lines[lines.length - 1]?.length ?? 0) : 0) + 1,
  };
};

const syncCursorPosition = (element: HTMLTextAreaElement): void => {
  const { line, column } = resolveCursorPosition(
    element.value,
    element.selectionStart ?? element.value.length,
  );
  emit('cursor-position-change', line, column);
};

const handleInput = (event: Event): void => {
  const target = event.target as HTMLTextAreaElement;
  emit('update:modelValue', target.value);
  syncCursorPosition(target);
};

const handleCursorActivity = (event: Event): void => {
  const target = event.target as HTMLTextAreaElement;
  syncCursorPosition(target);
};

const focusEditor = (): void => {
  textareaRef.value?.focus();
};

const insertSnippet = (snippet: string): void => {
  const element = textareaRef.value;
  if (!element) {
    return;
  }

  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? element.value.length;
  const nextValue = `${element.value.slice(0, start)}${snippet}${element.value.slice(end)}`;
  emit('update:modelValue', nextValue);

  requestAnimationFrame(() => {
    element.focus();
    const caret = start + snippet.length;
    element.setSelectionRange(caret, caret);
    syncCursorPosition(element);
  });
};

onMounted(() => {
  if (textareaRef.value) {
    syncCursorPosition(textareaRef.value);
  }
});

defineExpose<IEditorExpose>({
  focusEditor,
  insertSnippet,
});
</script>
