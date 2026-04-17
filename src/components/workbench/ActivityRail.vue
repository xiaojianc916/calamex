<template>
  <aside class="flex h-full flex-col items-center gap-1 py-2">
    <button
      type="button"
      class="activity-button is-active app-tooltip-target"
      data-tooltip="资源管理器"
      data-tooltip-placement="right"
      data-tooltip-lock-placement="true"
      aria-label="资源管理器"
    >
      <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
    </button>
    <button
      type="button"
      class="activity-button app-tooltip-target"
      data-tooltip="搜索"
      data-tooltip-placement="right"
      data-tooltip-lock-placement="true"
      aria-label="搜索"
    >
      <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="6.5" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
    </button>
    <button
      type="button"
      class="activity-button app-tooltip-target"
      data-tooltip="源代码管理"
      data-tooltip-placement="right"
      data-tooltip-lock-placement="true"
      aria-label="源代码管理"
    >
      <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="4" r="2.5" />
        <circle cx="18" cy="18" r="2.5" />
        <path d="M8.5 6h3a4 4 0 0 1 4 4v5.5" />
        <path d="M15.5 6.5V9" />
      </svg>
    </button>
    <button
      type="button"
      class="activity-button app-tooltip-target"
      data-tooltip="运行"
      data-tooltip-placement="right"
      data-tooltip-lock-placement="true"
      aria-label="运行"
    >
      <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3.5" y="5" width="17" height="14" rx="2" />
        <path d="M7 9l3 3-3 3" />
        <path d="M12.5 15h4.5" />
      </svg>
    </button>
    <button
      type="button"
      class="activity-button app-tooltip-target"
      data-tooltip="扩展"
      data-tooltip-placement="right"
      data-tooltip-lock-placement="true"
      aria-label="扩展"
    >
      <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3l7 4v10l-7 4-7-4V7z" />
        <path d="M12 12l7-4" />
        <path d="M12 12L5 8" />
        <path d="M12 12v9" />
      </svg>
    </button>

    <button
      type="button"
      class="activity-button is-bottom app-tooltip-target"
      data-tooltip="设置"
      data-tooltip-placement="right"
      data-tooltip-lock-placement="true"
      aria-label="设置"
    >
      <svg viewBox="0 0 16 16" class="h-[18px] w-[18px]" fill="currentColor" aria-hidden="true">
        <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.47 1.47 0 0 1-2.105.872l-.31-.18c-1.27-.736-2.672.666-1.936 1.936l.18.31a1.47 1.47 0 0 1-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.47 1.47 0 0 1 .872 2.105l-.18.31c-.736 1.27.666 2.672 1.936 1.936l.31-.18a1.47 1.47 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.47 1.47 0 0 1 2.105-.872l.31.18c1.27.736 2.672-.666 1.936-1.936l-.18-.31a1.47 1.47 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.47 1.47 0 0 1-.872-2.105l.18-.31c.736-1.27-.666-2.672-1.936-1.936l-.31.18a1.47 1.47 0 0 1-2.105-.872zm-1.405 4a2.95 2.95 0 1 1 0 5.9 2.95 2.95 0 0 1 0-5.9" />
      </svg>
    </button>
  </aside>
</template>

<script setup lang="ts"></script>
