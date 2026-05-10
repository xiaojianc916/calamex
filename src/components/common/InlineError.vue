<script setup lang="ts">
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { IErrorPresentationAction, TErrorSeverity } from '@/types/app-error';
import { CircleAlert, Info, OctagonX, TriangleAlert } from 'lucide-vue-next';
import { computed } from 'vue';

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

const alertVariant = computed(() =>
  props.severity === 'error' || props.severity === 'fatal' ? 'destructive' : 'default',
);
</script>

<template>
  <Alert
    :variant="alertVariant"
    class="border-[var(--border-subtle)] bg-[var(--surface-soft)] text-[var(--text-primary)]"
  >
    <Info v-if="props.severity === 'info'" class="text-[var(--statusbar-accent)]" />
    <TriangleAlert v-else-if="props.severity === 'warning'" class="text-[var(--warning)]" />
    <OctagonX v-else-if="props.severity === 'fatal'" class="text-[var(--danger)]" />
    <CircleAlert v-else class="text-[var(--danger)]" />
    <div class="min-w-0">
      <AlertTitle class="text-[13px] text-[var(--text-primary)]">
        {{ props.title }}
      </AlertTitle>
      <AlertDescription class="mt-1 text-[12px] leading-5 text-[var(--text-secondary)]">
        {{ props.message }}
      </AlertDescription>
      <div
        v-if="props.code || props.traceId"
        class="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--text-tertiary)]"
      >
        <span v-if="props.code">code={{ props.code }}</span>
        <span v-if="props.traceId">traceId={{ props.traceId }}</span>
      </div>
      <div v-if="props.actions.length" class="mt-3 flex flex-wrap gap-2">
        <Button
          v-for="action in props.actions"
          :key="action.id"
          :variant="action.variant ?? 'outline'"
          size="sm"
          class="h-7 px-2.5 text-[12px]"
          @click="action.onSelect"
        >
          {{ action.label }}
        </Button>
      </div>
      <ErrorDetails v-if="props.technicalDetails" class="mt-2" :details="props.technicalDetails" />
    </div>
  </Alert>
</template>
