<script setup lang="ts">
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

type TCheckpointButtonVariant = 'default' | 'outline' | 'ghost';
type TCheckpointButtonSize = 'default' | 'sm' | 'icon' | 'lg';

const props = withDefaults(defineProps<{
  tooltip?: string;
  variant?: TCheckpointButtonVariant;
  size?: TCheckpointButtonSize;
}>(), {
  tooltip: undefined,
  variant: 'ghost',
  size: 'sm',
});
</script>

<template>
  <TooltipProvider v-if="props.tooltip">
    <Tooltip>
      <TooltipTrigger as-child>
        <Button :variant="props.variant" :size="props.size" type="button" v-bind="$attrs">
          <slot />
        </Button>
      </TooltipTrigger>
      <TooltipContent align="start" side="bottom">
        <p>{{ props.tooltip }}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>

  <Button v-else :variant="props.variant" :size="props.size" type="button" v-bind="$attrs">
    <slot />
  </Button>
</template>
