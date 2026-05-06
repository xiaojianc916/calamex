<template>
  <svg v-if="props.icon === 'branch'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="6" cy="5" r="2" />
    <circle cx="18" cy="7" r="2" />
    <circle cx="18" cy="19" r="2" />
    <path d="M6 7v4a4 4 0 0 0 4 4h4" />
    <path d="M16 7h-5a5 5 0 0 0-5 5v5" />
  </svg>

  <svg v-else-if="props.icon === 'check'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m5 12 4 4L19 6" />
  </svg>

  <svg v-else-if="props.icon === 'commit'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 12h6" />
    <path d="M14 12h6" />
    <circle cx="12" cy="12" r="3" />
  </svg>

  <svg v-else-if="props.icon === 'format'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 6h12" />
    <path d="M4 12h16" />
    <path d="M4 18h8" />
  </svg>

  <svg v-else-if="props.icon === 'refresh'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20 7v5h-5" />
    <path d="M4 17v-5h5" />
    <path d="M6.8 9a6 6 0 0 1 9.9-2.2L20 10" />
    <path d="M17.2 15a6 6 0 0 1-9.9 2.2L4 14" />
  </svg>

  <svg v-else-if="props.icon === 'search'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>

  <svg v-else-if="props.icon === 'command'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 6H6a3 3 0 1 1 3-3v3Zm6 0h3a3 3 0 1 0-3-3v3Zm0 12h3a3 3 0 1 1-3 3v-3Zm-6 0H6a3 3 0 1 0 3 3v-3Z" />
    <path d="M9 6h6v12H9Z" />
  </svg>

  <svg v-else-if="props.icon === 'comment'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 7V5h16v2" />
    <path d="M9 20h6" />
    <path d="M12 5v15" />
  </svg>

  <svg v-else-if="props.icon === 'cut'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="m20 4-12 12" />
    <path d="m8 12 12 8" />
  </svg>

  <svg v-else-if="props.icon === 'copy'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>

  <svg v-else-if="props.icon === 'paste'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="8" y="2" width="8" height="4" rx="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <path d="M9 13h6M9 17h4" />
  </svg>

  <svg v-else-if="props.icon === 'plus'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>

  <svg v-else-if="props.icon === 'minus'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5 12h14" />
  </svg>

  <svg v-else-if="props.icon === 'trash'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="m6 6 1 15h10l1-15" />
    <path d="M10 11v5" />
    <path d="M14 11v5" />
  </svg>

  <svg v-else-if="props.icon === 'select-all'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="6" width="18" height="12" rx="1.5" />
  </svg>

  <svg v-else-if="props.icon === 'undo'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h9a7 7 0 1 1 0 14h-1" />
  </svg>

  <svg v-else-if="props.icon === 'redo'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9h-9a7 7 0 1 0 0 14h1" />
  </svg>

  <svg v-else-if="props.icon === 'link'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
  </svg>

  <svg v-else-if="props.icon === 'open-external'" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <path d="M15 3h6v6" />
    <path d="m10 14 11-11" />
  </svg>

  <svg v-else-if="props.icon === 'rename'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>

  <svg v-else-if="props.icon === 'download'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>

  <svg v-else-if="props.icon === 'upload'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>

  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true">
    <path d="m7 9 5-5 5 5" />
    <path d="m7 15 5 5 5-5" />
  </svg>
</template>

<script setup lang="ts">
import type { TLinearContextMenuIcon } from '@/components/common/linear-context-menu.types';

const props = defineProps<{
  icon: TLinearContextMenuIcon;
}>();
</script>
