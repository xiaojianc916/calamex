<script setup lang="ts">
import { cn } from '@/lib/utils';
import { reactiveOmit } from '@vueuse/core';
import { ChevronsUpDown } from 'lucide-vue-next';
import type { SelectTriggerProps } from 'reka-ui';
import { SelectIcon, SelectTrigger, useForwardProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';

const props = defineProps<SelectTriggerProps & { class?: HTMLAttributes['class'] }>();

const delegatedProps = reactiveOmit(props, 'class');
const forwardedProps = useForwardProps(delegatedProps);
</script>

<template>
    <SelectTrigger data-slot="model-selector-trigger" v-bind="forwardedProps" :class="cn(
        'flex min-h-10 min-w-[11rem] items-center justify-between gap-3 rounded-xl border border-[color-mix(in_srgb,var(--shell-divider)_72%,transparent)] bg-[var(--panel-bg)] px-3 py-2 text-left text-[var(--text-primary)] shadow-none outline-none transition-[border-color,background-color] hover:border-[color-mix(in_srgb,var(--accent-strong)_26%,var(--shell-divider))] focus-visible:border-[color-mix(in_srgb,var(--accent-strong)_32%,var(--shell-divider))] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_18%,transparent)] data-[placeholder]:text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-60',
        props.class,
    )">
        <slot />
        <SelectIcon as-child>
            <ChevronsUpDown class="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
        </SelectIcon>
    </SelectTrigger>
</template>