<script setup lang="ts">
import { SelectScrollDownButton, SelectScrollUpButton } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { reactiveOmit } from '@vueuse/core';
import type { SelectContentEmits, SelectContentProps } from 'reka-ui';
import {
    SelectContent,
    SelectPortal,
    SelectViewport,
    useForwardPropsEmits,
} from 'reka-ui';
import type { HTMLAttributes } from 'vue';

defineOptions({
    inheritAttrs: false,
});

const props = withDefaults(
    defineProps<SelectContentProps & { class?: HTMLAttributes['class'] }>(),
    {
        position: 'popper',
    },
);

const emits = defineEmits<SelectContentEmits>();

const delegatedProps = reactiveOmit(props, 'class');
const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
    <SelectPortal>
        <SelectContent data-slot="model-selector-content" v-bind="{ ...$attrs, ...forwarded }" :class="cn(
            'relative z-50 min-w-[15rem] overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--shell-divider)_72%,transparent)] bg-[var(--panel-bg)] p-1 text-[var(--text-primary)] shadow-[0_18px_48px_rgba(15,23,42,0.12)] data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            position === 'popper'
                ? 'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1'
                : undefined,
            props.class,
        )">
            <SelectScrollUpButton />
            <SelectViewport :class="cn(
                'grid gap-1 p-1',
                position === 'popper'
                    ? 'max-h-[var(--reka-select-content-available-height)] w-full min-w-[var(--reka-select-trigger-width)]'
                    : undefined,
            )">
                <slot />
            </SelectViewport>
            <SelectScrollDownButton />
        </SelectContent>
    </SelectPortal>
</template>