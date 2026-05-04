<script setup lang="ts">
import svgRaw from '@/assets/svg/welcome-isometric.svg?raw';
import { onBeforeUnmount, onMounted, ref } from 'vue';

const svgWrapRef = ref<HTMLElement | null>(null);

const getSvgElement = (): SVGSVGElement | null => {
  const element = svgWrapRef.value?.querySelector('svg') ?? null;
  if (!element) {
    return null;
  }

  if (typeof SVGSVGElement !== 'undefined' && element instanceof SVGSVGElement) {
    return element;
  }

  return element as SVGSVGElement;
};

const pauseWelcomeAnimations = (): void => {
  getSvgElement()?.pauseAnimations();
};

onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    pauseWelcomeAnimations();
  }
});

onBeforeUnmount(() => {
  pauseWelcomeAnimations();
});
</script>

<template>
  <div class="welcome-root" tabindex="-1" role="presentation" data-testid="welcome-window">
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div ref="svgWrapRef" class="welcome-svg-wrap" v-html="svgRaw" />
  </div>
</template>

<style scoped>
.welcome-root {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #08090a;
  color: #f7f8f8;
  outline: none;
  user-select: none;
  -webkit-app-region: drag;
}

.welcome-svg-wrap {
  width: 100%;
  height: 100%;
  contain: strict;
  pointer-events: none;
  will-change: transform, opacity;
}

.welcome-svg-wrap :global(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.welcome-svg-wrap :global(text) {
  text-rendering: geometricPrecision;
}

@media (prefers-reduced-motion: reduce) {

  .welcome-svg-wrap :global(animate),
  .welcome-svg-wrap :global(animateTransform),
  .welcome-svg-wrap :global(animateMotion) {
    display: none;
  }
}
</style>
