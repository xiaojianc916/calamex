<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { InputGroupAddon as InputGroupAddonComponent } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

interface IProps {
  class?: HTMLAttributes['class'];
}

const props = withDefaults(defineProps<IProps>(), {
  class: undefined,
});
</script>

<template>
  <InputGroupAddonComponent
    align="block-end"
    :class="cn('justify-between gap-1', props.class)"
    v-bind="props"
  >
    <slot />
  </InputGroupAddonComponent>
</template>
