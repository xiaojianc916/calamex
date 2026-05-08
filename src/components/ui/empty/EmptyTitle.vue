<script setup lang="ts">
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'vue';

const props = defineProps<{
    class?: HTMLAttributes['class'];
}>();
</script>

<template>
    <h3 data-slot="empty-title" :class="cn('text-lg font-semibold text-[var(--text-primary)]', props.class)">
        <slot />
    </h3>
</template>