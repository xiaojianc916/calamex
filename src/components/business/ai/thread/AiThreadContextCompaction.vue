<script setup lang="ts">
import { ThreadEntryDisclosure } from '@/components/ai-elements/thread-entry';
import type { IAiThreadContextCompactionEntry } from './projection';

defineProps<{
  entry: IAiThreadContextCompactionEntry;
}>();
</script>

<template>
  <ThreadEntryDisclosure class="ai-thread-context-compaction" :title="entry.text" disabled>
    <template #leading>
      <span class="icon-[lucide--archive] size-4 text-muted-foreground" aria-hidden="true" />
    </template>
  </ThreadEntryDisclosure>
</template>
