<script setup lang="ts">
import { ChevronRight } from '@lucide/vue';
import { reactiveOmit } from '@vueuse/core';
import type { ContextMenuSubTriggerProps } from 'reka-ui';
import { ContextMenuSubTrigger, useForwardProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

const props = defineProps<
  ContextMenuSubTriggerProps & { class?: HTMLAttributes['class']; inset?: boolean }
>();

const delegatedProps = reactiveOmit(props, 'class', 'inset');
const forwardedProps = useForwardProps(delegatedProps);
</script>

<template>
    <ContextMenuSubTrigger
data-slot="context-menu-sub-trigger" v-bind="forwardedProps"
        :data-inset="inset ? '' : undefined"
        :class="cn('focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-inset:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'text-\'])]:text-muted-foreground [&_svg:not([class*=\'size-\'])]:size-4 data-[variant=destructive]:*:[svg]:!text-destructive', props.class)">
        <slot />
        <ChevronRight class="ml-auto size-4" />
    </ContextMenuSubTrigger>
</template>