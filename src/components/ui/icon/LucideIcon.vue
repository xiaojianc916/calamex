<script setup lang="ts">
import { computed } from 'vue';
import { lucideIconRegistry, type TLucideIconName } from './lucide-icon-registry';

const props = defineProps<{ name: TLucideIconName }>();
const component = computed(() => lucideIconRegistry[props.name] ?? null);
</script>

<template>
  <component :is="component" v-if="component" />
</template>
