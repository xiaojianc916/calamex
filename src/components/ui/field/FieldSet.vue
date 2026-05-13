<script setup lang="ts">
import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "vue";

const props = defineProps<{
    class?: HTMLAttributes["class"]
}>()
</script>

<template>
    <fieldset data-slot="field-set" :class="cn('m-0 min-w-0 border-0 p-0', props.class)">
        <slot />
    </fieldset>
</template>