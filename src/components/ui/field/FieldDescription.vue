<script setup lang="ts">
import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "vue";

const props = defineProps<{
    class?: HTMLAttributes["class"]
}>()
</script>

<template>
    <p data-slot="field-description" :class="cn('text-muted-foreground text-sm leading-6', props.class)">
        <slot />
    </p>
</template>