<script setup lang="ts">
import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "vue";

const props = defineProps<{
    class?: HTMLAttributes["class"]
}>()
</script>

<template>
    <div data-slot="field-group" :class="cn('grid gap-6', props.class)">
        <slot />
    </div>
</template>