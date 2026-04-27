<template>
  <aside class="flex h-full flex-col items-center gap-1 pt-1.5 pb-1.5">
    <button
type="button" class="activity-button app-tooltip-target" :class="{ 'is-active': activeView === 'explorer' }"
      data-tooltip="资源管理器" data-tooltip-placement="right" data-tooltip-lock-placement="true" aria-label="资源管理器"
      :aria-pressed="activeView === 'explorer'" @click="emit('select-view', 'explorer')">
      <svg
viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7"
        stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
    </button>
    <button
type="button" class="activity-button app-tooltip-target" :class="{ 'is-active': activeView === 'search' }"
      data-tooltip="搜索" data-tooltip-placement="right" data-tooltip-lock-placement="true" aria-label="搜索"
      :aria-pressed="activeView === 'search'" @click="emit('select-view', 'search')">
      <svg
viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7"
        stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="6.5" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
    </button>
    <button
type="button" class="activity-button app-tooltip-target"
      :class="{ 'is-active': activeView === 'source-control' }" data-tooltip="源代码管理" data-tooltip-placement="right"
      data-tooltip-lock-placement="true" aria-label="源代码管理" :aria-pressed="activeView === 'source-control'"
      @click="emit('select-view', 'source-control')">
      <svg
viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7"
        stroke-linecap="round" stroke-linejoin="round">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="4" r="2.5" />
        <circle cx="18" cy="18" r="2.5" />
        <path d="M8.5 6h3a4 4 0 0 1 4 4v5.5" />
        <path d="M15.5 6.5V9" />
      </svg>
    </button>
    <button
type="button" class="activity-button app-tooltip-target" :class="{ 'is-active': activeView === 'run' }"
      data-tooltip="运行" data-tooltip-placement="right" data-tooltip-lock-placement="true" aria-label="运行"
      :aria-pressed="activeView === 'run'" @click="emit('select-view', 'run')">
      <svg
viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7"
        stroke-linecap="round" stroke-linejoin="round">
        <rect x="3.5" y="5" width="17" height="14" rx="2" />
        <path d="M7 9l3 3-3 3" />
        <path d="M12.5 15h4.5" />
      </svg>
    </button>
    <button
type="button" class="activity-button app-tooltip-target"
      :class="{ 'is-active': activeView === 'extensions' }" data-tooltip="SSH 连接" data-tooltip-placement="right"
      data-tooltip-lock-placement="true" aria-label="SSH 连接" :aria-pressed="activeView === 'extensions'"
      @click="emit('select-view', 'extensions')">
      <svg
viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7"
        stroke-linecap="round" stroke-linejoin="round">
        <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
        <path d="M8 9l4 4-4 4" />
        <path d="M13.5 17h2.5" />
      </svg>
    </button>

    <button
type="button" class="activity-settings-trigger app-tooltip-target" :class="{ 'is-active': settingsActive }"
      data-tooltip="设置" data-tooltip-placement="right" data-tooltip-lock-placement="true" aria-label="设置"
      :aria-pressed="settingsActive" @mouseenter="handleSettingsMouseEnter" @click="emit('toggle-settings')">
      <svg
viewBox="0 0 16 16" class="activity-settings-icon h-4.5 w-4.5" fill="currentColor" aria-hidden="true"
        :style="settingsIconStyle">
        <path
          d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.47 1.47 0 0 1-2.105.872l-.31-.18c-1.27-.736-2.672.666-1.936 1.936l.18.31a1.47 1.47 0 0 1-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.47 1.47 0 0 1 .872 2.105l-.18.31c-.736 1.27.666 2.672 1.936 1.936l.31-.18a1.47 1.47 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.47 1.47 0 0 1 2.105-.872l.31.18c1.27.736 2.672-.666 1.936-1.936l-.18-.31a1.47 1.47 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.47 1.47 0 0 1-.872-2.105l.18-.31c.736-1.27-.666-2.672-1.936-1.936l-.31.18a1.47 1.47 0 0 1-2.105-.872zm-1.405 4a2.95 2.95 0 1 1 0 5.9 2.95 2.95 0 0 1 0-5.9" />
      </svg>
    </button>
  </aside>
</template>

<script setup lang="ts">
import type { TWorkbenchSidebarView } from '@/types/app';
import { computed, ref } from 'vue';

defineProps<{
  activeView: TWorkbenchSidebarView;
  settingsActive: boolean;
}>();

const emit = defineEmits<{
  'select-view': [view: TWorkbenchSidebarView];
  'toggle-settings': [];
}>();

const settingsIconRotation = ref(0);

const settingsIconStyle = computed(() => ({
  transform: `translateY(-2.5px) rotate(${settingsIconRotation.value}deg)`,
}));

const handleSettingsMouseEnter = (): void => {
  settingsIconRotation.value += 360;
};
</script>
