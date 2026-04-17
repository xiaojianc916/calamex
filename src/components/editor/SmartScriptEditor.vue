<template>
  <component
    :is="currentComponent"
    ref="innerEditorRef"
    :model-value="modelValue"
    :theme="theme"
    @update:model-value="handleModelValueChange"
    @cursor-position-change="handleCursorPositionChange"
  />
</template>

<script setup lang="ts">
import PlainScriptEditor from '@/components/editor/PlainScriptEditor.vue';
import type { TThemeMode } from '@/types/app';
import type { Component } from 'vue';
import { computed, markRaw, onMounted, ref, shallowRef } from 'vue';

interface IEditorExpose {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
}

withDefaults(
  defineProps<{
    modelValue: string;
    theme: TThemeMode;
  }>(),
  {
    modelValue: '',
    theme: 'dark',
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  'cursor-position-change': [line: number, column: number];
}>();

const innerEditorRef = ref<IEditorExpose | null>(null);
const resolvedComponent = shallowRef<Component>(markRaw(PlainScriptEditor));
const scriptEditorModulePromise = import('@/components/editor/ScriptEditor.vue');

const currentComponent = computed(() => resolvedComponent.value);

onMounted(async () => {
  try {
    const module = await scriptEditorModulePromise;
    resolvedComponent.value = markRaw(module.default);
  } catch (error) {
    console.error('Monaco editor failed to initialize, fallback to plain editor.', error);
  }
});

const focusEditor = (): void => {
  innerEditorRef.value?.focusEditor();
};

const insertSnippet = (snippet: string): void => {
  innerEditorRef.value?.insertSnippet(snippet);
};

const handleModelValueChange = (value: string): void => {
  emit('update:modelValue', value);
};

const handleCursorPositionChange = (line: number, column: number): void => {
  emit('cursor-position-change', line, column);
};

defineExpose<IEditorExpose>({
  focusEditor,
  insertSnippet,
});
</script>
