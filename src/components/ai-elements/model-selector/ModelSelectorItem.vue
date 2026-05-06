<script setup lang="ts">
import { cn } from '@/lib/utils';
import { reactiveOmit } from '@vueuse/core';
import { Check } from 'lucide-vue-next';
import type { SelectItemProps } from 'reka-ui';
import {
    SelectItem,
    SelectItemIndicator,
    SelectItemText,
    useForwardProps,
} from 'reka-ui';
import type { HTMLAttributes } from 'vue';

const props = defineProps<SelectItemProps & { class?: HTMLAttributes['class'] }>();

const delegatedProps = reactiveOmit(props, 'class');
const forwardedProps = useForwardProps(delegatedProps);
</script>

<template>
    <SelectItem data-slot="model-selector-item" v-bind="forwardedProps" :class="cn(
        'relative flex w-full cursor-default items-start gap-3 rounded-xl px-3 py-2.5 pr-8 text-left outline-none select-none transition-colors focus:bg-[var(--surface-soft)] data-[state=checked]:bg-[var(--surface-soft)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        props.class,
    )">
        <span class="absolute right-3 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center">
            <SelectItemIndicator>
                <Check class="size-4 text-[var(--accent-strong)]" />
            </SelectItemIndicator>
        </span>

        <SelectItemText class="min-w-0 flex-1">
            <slot />
        </SelectItemText>
    </SelectItem>
</template>