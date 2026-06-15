<script setup lang="ts">
import Tooltip from './Tooltip.vue';
import TooltipContent from './TooltipContent.vue';
import TooltipTrigger from './TooltipTrigger.vue';

type TTooltipSide = 'top' | 'right' | 'bottom' | 'left';

withDefaults(
  defineProps<{
    content?: string | null;
    side?: TTooltipSide;
    delayDuration?: number;
    sideOffset?: number;
  }>(),
  {
    content: null,
    side: 'top',
    delayDuration: 700,
    sideOffset: 10,
  },
);
</script>

<template>
  <Tooltip v-if="content" :delay-duration="delayDuration">
    <TooltipTrigger as-child>
      <slot />
    </TooltipTrigger>
    <TooltipContent
      :side="side"
      align="center"
      :side-offset="sideOffset"
      class="app-tooltip-content"
    >
      <span v-text="content" />
    </TooltipContent>
  </Tooltip>
  <slot v-else />
</template>
