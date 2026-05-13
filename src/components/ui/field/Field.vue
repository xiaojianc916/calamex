<script setup lang="ts">
import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "vue";

const props = withDefaults(
    defineProps<{
        class?: HTMLAttributes["class"]
        orientation?: "vertical" | "horizontal"
    }>(),
    {
        class: undefined,
        orientation: "vertical",
    },
)
</script>

<template>
    <div data-slot="field" :data-orientation="props.orientation" :class="cn(
        'grid gap-2',
        props.orientation === 'horizontal' && 'grid-cols-[auto_1fr] items-center gap-3',
        props.class,
    )">
        <slot />
    </div>
</template>