<script setup lang="ts">
import { cn } from '@/lib/utils'
import { Ellipsis } from 'lucide-vue-next'
import type { HTMLAttributes } from 'vue'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <span
    data-slot="breadcrumb-ellipsis"
    role="presentation"
    aria-hidden="true"
    :class="cn('flex size-9 items-center justify-center', props.class)"
  >
    <Ellipsis class="size-4" />
    <span class="sr-only">更多</span>
  </span>
</template>
