<script setup lang="ts">
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'vue';

const props = defineProps<{
    class?: HTMLAttributes['class'];
}>();
</script>

<template>
    <div data-slot="empty-media"
        :class="cn('flex h-20 w-20 items-center justify-center rounded-2xl border border-[var(--border-subtle)] bg-[var(--panel-muted)] text-[var(--text-tertiary)] shadow-sm', props.class)">
        <slot />
    </div>
</template>