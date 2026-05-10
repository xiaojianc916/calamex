<script setup lang="ts">
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import type { IErrorPresentationAction, TErrorSeverity } from '@/types/app-error';
import { FileWarning, Info, OctagonX, TriangleAlert } from 'lucide-vue-next';

const props = withDefaults(
  defineProps<{
    title: string;
    message: string;
    severity?: TErrorSeverity;
    code?: string;
    traceId?: string;
    technicalDetails?: string;
    actions?: IErrorPresentationAction[];
  }>(),
  {
    severity: 'error',
    code: undefined,
    traceId: undefined,
    technicalDetails: undefined,
    actions: () => [],
  },
);
</script>

<template>
  <Empty class="bg-[var(--editor-bg)]">
    <EmptyHeader>
      <EmptyMedia
        class="mx-auto flex size-11 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-soft)]"
      >
        <Info v-if="props.severity === 'info'" class="size-5 text-[var(--statusbar-accent)]" />
        <TriangleAlert
          v-else-if="props.severity === 'warning'"
          class="size-5 text-[var(--warning)]"
        />
        <OctagonX v-else-if="props.severity === 'fatal'" class="size-5 text-[var(--danger)]" />
        <FileWarning v-else class="size-5 text-[var(--danger)]" />
      </EmptyMedia>
      <EmptyTitle class="mt-4 text-[15px]">{{ props.title }}</EmptyTitle>
      <EmptyDescription class="mt-2 max-w-md text-[12px] leading-6">
        {{ props.message }}
      </EmptyDescription>
    </EmptyHeader>
    <div
      v-if="props.code || props.traceId"
      class="flex flex-wrap justify-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--text-tertiary)]"
    >
      <span v-if="props.code">code={{ props.code }}</span>
      <span v-if="props.traceId">traceId={{ props.traceId }}</span>
    </div>
    <div v-if="props.actions.length" class="flex flex-wrap justify-center gap-2">
      <Button
        v-for="action in props.actions"
        :key="action.id"
        :variant="action.variant ?? 'outline'"
        size="sm"
        class="h-8 px-3 text-[12px]"
        @click="action.onSelect"
      >
        {{ action.label }}
      </Button>
    </div>
    <ErrorDetails
      v-if="props.technicalDetails"
      class="w-full max-w-md"
      :details="props.technicalDetails"
    />
  </Empty>
</template>
