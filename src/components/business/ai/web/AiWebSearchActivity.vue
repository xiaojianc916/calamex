<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';
import { computed } from 'vue';
import type { IAiWebActivity } from '@/types/ai';

const props = defineProps<{
  activity: IAiWebActivity | null;
}>();

const shouldAnimate = computed(() => {
  switch (props.activity?.state) {
    case 'searching':
    case 'fetching':
    case 'summarizing':
      return true;
    default:
      return false;
  }
});
</script>

<template>
  <div
    v-if="activity"
    class="ai-web-activity"
    :class="`is-${activity.state}`"
    role="status"
    aria-live="polite"
  >
    <span class="ai-web-activity-rail" aria-hidden="true">
      <LoaderCircle class="ai-web-activity-spinner" v-if="shouldAnimate" aria-hidden="true" />
      <span v-else class="ai-web-activity-dot"></span>
    </span>
    <span class="ai-web-activity-copy">
      <span>{{ activity.label }}</span>
      <span v-if="activity.queryPreview" class="ai-web-activity-query">
        {{ activity.queryPreview }}
      </span>
    </span>
  </div>
</template>

<style scoped>
.ai-web-activity {
  position: relative;
  display: grid;
  min-width: 0;
  grid-template-columns: 24px minmax(0, 1fr);
  column-gap: 4px;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.ai-web-activity::before {
  position: absolute;
  top: 9px;
  bottom: 0;
  left: 5px;
  width: 1px;
  background: color-mix(in srgb, var(--shell-divider) 76%, transparent);
  content: '';
}

.ai-web-activity-rail {
  position: relative;
  z-index: 1;
  display: flex;
  width: 11px;
  min-height: 28px;
  align-items: flex-start;
  justify-content: center;
  padding-top: 7px;
}

.ai-web-activity-dot {
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: var(--text-tertiary);
}

.ai-web-activity-spinner {
  width: 13px;
  height: 13px;
  animation: ai-web-spinner-rotate 900ms linear infinite;
  color: var(--text-tertiary);
  stroke-width: 2;
}

.ai-web-activity-dot {
  width: 7px;
  height: 7px;
  background: color-mix(in srgb, var(--text-quaternary) 54%, transparent);
}

.ai-web-activity-copy {
  display: inline-flex;
  min-width: 0;
  gap: 5px;
  padding: 2px 0 10px;
  overflow-wrap: anywhere;
}

.ai-web-activity-query {
  color: var(--text-quaternary);
}

.ai-web-activity.is-failed {
  color: var(--danger);
}

@keyframes ai-web-spinner-rotate {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-web-activity-spinner {
    animation: none;
  }
}
</style>
