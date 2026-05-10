<script setup lang="ts">
import { cn } from '@/lib/utils'
import type { HTMLAttributes } from 'vue'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <nav
    data-slot="breadcrumb"
    aria-label="breadcrumb"
    :class="cn(props.class)"
  >
    <slot />
  </nav>
</template>
