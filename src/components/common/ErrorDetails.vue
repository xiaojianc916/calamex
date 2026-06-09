<script setup lang="ts">
import { ChevronDown } from '@lucide/vue';
import { ref } from 'vue';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

const props = withDefaults(
  defineProps<{
    details: string;
    label?: string;
  }>(),
  {
    label: '查看诊断信息',
  },
);

const isOpen = ref(false);
</script>

<template>
  <Collapsible v-model:open="isOpen" class="min-w-0">
    <CollapsibleTrigger as-child>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-[12px] text-[var(--text-tertiary)]">
        {{ props.label }}
        <ChevronDown class="size-3 transition-transform duration-[var(--motion-duration-fast)]" :class="isOpen ? 'rotate-180' : ''" />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <pre
        class="mt-2 max-h-52 overflow-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-code)] p-3 font-mono text-[11px] leading-5 text-[var(--text-secondary)] whitespace-pre-wrap break-words"
        >{{ props.details }}</pre
      >
    </CollapsibleContent>
  </Collapsible>
</template>
