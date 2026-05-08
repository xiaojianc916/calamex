<script setup lang="ts">
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'vue';

const props = defineProps<{
    class?: HTMLAttributes['class'];
}>();
</script>

<template>
    <div data-slot="empty-description" :class="cn('text-sm leading-6 text-[var(--text-secondary)]', props.class)">
        <slot />
    </div>
</template>