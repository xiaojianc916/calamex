<script setup lang="ts">
import { provide, ref, watch } from 'vue';
import { WebPreviewKey } from './context';

const props = withDefaults(
  defineProps<{
    defaultUrl?: string;
  }>(),
  {
    defaultUrl: '',
  },
);

const emit = defineEmits<{
  'url-change': [url: string];
}>();

const currentUrl = ref(props.defaultUrl);

watch(
  () => props.defaultUrl,
  (nextUrl) => {
    if (nextUrl !== currentUrl.value) {
      currentUrl.value = nextUrl;
    }
  },
);

const setUrl = (url: string): void => {
  const nextUrl = url.trim();

  if (!nextUrl || nextUrl === currentUrl.value) {
    return;
  }

  currentUrl.value = nextUrl;
  emit('url-change', nextUrl);
};

provide(WebPreviewKey, {
  currentUrl,
  setUrl,
});
</script>

<template>
  <section class="ai-web-preview" data-slot="web-preview">
    <slot />
  </section>
</template>

<style scoped>
.ai-web-preview {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-left: 0;
  background: #ffffff;
}
</style>
