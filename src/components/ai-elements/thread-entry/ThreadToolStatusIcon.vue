<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { computed } from 'vue';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import { cn } from '@/lib/utils';

/**
 * Zed 风格工具调用状态：运行/等待/失败需要可见反馈；成功态保持克制，不再显示
 * 绿色大对勾，避免每个完成工具行都出现强提示色。
 */
type ThreadToolStatus =
  | 'pending'
  | 'running'
  | 'awaiting-confirmation'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'canceled';

const props = withDefaults(
  defineProps<{
    status?: ThreadToolStatus;
    class?: HTMLAttributes['class'];
  }>(),
  {
    status: 'pending',
    class: undefined,
  },
);

interface IStatusGlyph {
  icon: string | null;
  tone: string;
  label: string;
}

const STATUS_GLYPHS: Record<ThreadToolStatus, IStatusGlyph> = {
  pending: { icon: 'circle', tone: 'text-muted-foreground', label: '等待中' },
  running: {
    icon: 'loader-circle',
    tone: 'text-muted-foreground animate-spin',
    label: '进行中',
  },
  'awaiting-confirmation': {
    icon: 'circle-alert',
    tone: 'text-amber-500',
    label: '等待确认',
  },
  succeeded: { icon: null, tone: 'text-muted-foreground', label: '已完成' },
  failed: { icon: 'circle-alert', tone: 'text-red-500', label: '失败' },
  denied: { icon: 'ban', tone: 'text-red-500', label: '已拒绝' },
  canceled: { icon: 'circle-slash', tone: 'text-muted-foreground', label: '已取消' },
};

const glyph = computed<IStatusGlyph>(() => STATUS_GLYPHS[props.status]);
</script>

<template>
  <span
    :class="cn('inline-flex size-4 shrink-0 items-center justify-center', props.class)"
    role="img"
    :aria-label="glyph.label"
    :data-status="props.status"
  >
    <LucideIcon v-if="glyph.icon" :name="glyph.icon" :class="cn('size-3.5', glyph.tone)" aria-hidden="true" />
  </span>
</template>
