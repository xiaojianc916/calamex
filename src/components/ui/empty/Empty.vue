<script setup lang="ts">
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'vue';

const props = defineProps<{
    class?: HTMLAttributes['class'];
}>();
</script>

<template>
    <div data-slot="empty"
        :class="cn('flex min-h-full w-full items-center justify-center px-6 py-10 text-center', props.class)">
        <div class="flex w-full max-w-sm flex-col items-center gap-4">
            <slot />
        </div>
    </div>
</template>