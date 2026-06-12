<script setup lang="ts">
import { inject, ref, watch } from 'vue';
import { WebPreviewKey } from './context';

const preview = inject(WebPreviewKey, null);
const draftUrl = ref(preview?.currentUrl.value ?? '');

watch(
  () => preview?.currentUrl.value,
  (nextUrl) => {
    draftUrl.value = nextUrl ?? '';
  },
);

const commitUrl = (): void => {
  const nextUrl = draftUrl.value.trim();

  if (!preview || !nextUrl) {
    return;
  }

  preview.setUrl(nextUrl);
};
</script>

<template>
  <form class="ai-web-preview-url" data-slot="web-preview-url" @submit.prevent="commitUrl">
    <input
      v-model="draftUrl"
      type="text"
      spellcheck="false"
      placeholder="输入预览地址"
      class="ai-web-preview-url__input"
      @blur="commitUrl"
    />
  </form>
</template>

<style scoped>
.ai-web-preview-url {
  min-width: 0;
  flex: 1;
}

.ai-web-preview-url__input {
  width: 100%;
  height: 32px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: #ffffff;
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.4;
  padding: 0 12px;
}

.ai-web-preview-url__input::placeholder {
  color: var(--text-quaternary);
}

.ai-web-preview-url__input:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong) 55%, transparent);
  outline-offset: 1px;
}
</style>
