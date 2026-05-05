<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

const props = defineProps<{
    title: string;
    rightLabel?: string | null;
    showBackToEditor?: boolean;
}>();

const emit = defineEmits<{
    'back-to-editor': [];
}>();
</script>

<template>
    <header class="flex h-14 shrink-0 items-center gap-2 border-b border-(--shell-divider) bg-(--editor-bg)">
        <div class="flex w-full items-center gap-1 px-4 lg:px-6">
            <span
                class="inline-flex h-4 w-4 rounded-sm border border-(--shell-divider) bg-[color-mix(in_srgb,var(--panel-bg)_96%,transparent)]"></span>
            <Separator orientation="vertical" class="mx-2 data-[orientation=vertical]:h-4" />
            <h1 class="text-base font-medium text-(--text-primary)">{{ title }}</h1>
            <div class="ml-auto flex items-center gap-2">
                <span v-if="props.rightLabel" class="hidden text-sm text-(--text-secondary) sm:inline">{{
                    props.rightLabel }}</span>
                <Button v-if="props.showBackToEditor" variant="ghost" size="sm" @click="emit('back-to-editor')">
                    返回编辑器
                </Button>
            </div>
        </div>
    </header>
</template>