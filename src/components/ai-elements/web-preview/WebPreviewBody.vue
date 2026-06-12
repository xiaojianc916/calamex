<script setup lang="ts">
import { computed, inject } from 'vue';
import { WebPreviewKey } from './context';

const props = withDefaults(
  defineProps<{
    src?: string;
    title?: string;
    appearance?: 'auto' | 'light';
  }>(),
  {
    src: undefined,
    title: 'Web preview',
    appearance: 'auto',
  },
);

const preview = inject(WebPreviewKey, null);
const resolvedSrc = computed(() => props.src ?? preview?.currentUrl.value ?? '');
const frameClass = computed(() => ({
  'ai-web-preview-body__frame--light': props.appearance === 'light',
}));
</script>

<template>
  <section class="ai-web-preview-body" data-slot="web-preview-body">
    <iframe
      v-if="resolvedSrc"
      :src="resolvedSrc"
      :title="props.title"
      :class="['ai-web-preview-body__frame', frameClass]"
    />
    <div v-else class="ai-web-preview-body__empty">输入地址后即可在这里预览页面</div>
  </section>
</template>

<style scoped>
.ai-web-preview-body {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  background: #ffffff;
}

.ai-web-preview-body__frame {
  width: 100%;
  min-width: 0;
  min-height: 0;
  flex: 1;
  border: 0;
  background: #ffffff;
}

.ai-web-preview-body__frame--light {
  color-scheme: light;
  filter: invert(1) hue-rotate(180deg);
}

.ai-web-preview-body__empty {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 12px;
  padding: 24px;
  text-align: center;
}
</style>
