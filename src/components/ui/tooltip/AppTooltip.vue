<script setup lang="ts">
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

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
       content 
    </TooltipContent>
  </Tooltip>
  <slot v-else />
</template>
