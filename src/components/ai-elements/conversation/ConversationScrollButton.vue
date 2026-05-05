<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ArrowDownIcon } from 'lucide-vue-next';
import { computed } from 'vue';
import { useStickToBottomContext } from 'vue-stick-to-bottom';

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class'];
}>(), {
  class: undefined,
});

const { isAtBottom, scrollToBottom } = useStickToBottomContext();
const shouldShow = computed(() => !isAtBottom.value);

const handleClick = (): void => {
  void scrollToBottom('smooth');
};
</script>

<template>
  <Button
    v-if="shouldShow"
    :class="cn('rounded-full bg-background/92 shadow-sm backdrop-blur-sm hover:bg-muted', props.class)"
    aria-label="滚动到底部"
    size="icon"
    type="button"
    variant="outline"
    @click="handleClick"
  >
    <ArrowDownIcon class="size-4" />
  </Button>
</template>
