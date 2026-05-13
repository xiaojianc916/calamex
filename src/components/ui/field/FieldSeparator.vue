<script setup lang="ts">
import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "vue";

const props = defineProps<{
    class?: HTMLAttributes["class"]
}>()
</script>

<template>
    <div data-slot="field-separator" role="separator" :class="cn('bg-border h-px w-full', props.class)" />
</template>