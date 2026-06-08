<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { computed } from 'vue';
import { cn } from '@/lib/utils';

/**
 * 工具调用状态的展示词汇。刻意保持服务中立：仅描述“呈现什么状态”，
 * 不内置任何业务 / 服务商知识，状态由上层（投影层）算好后传入。
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
  icon: string;
  tone: string;
  label: string;
}

const STATUS_GLYPHS: Record<ThreadToolStatus, IStatusGlyph> = {
  pending: { icon: 'icon-[lucide--circle-dashed]', tone: 'text-muted-foreground', label: '等待中' },
  running: {
    icon: 'icon-[lucide--loader-circle] animate-spin',
    tone: 'text-blue-500',
    label: '进行中',
  },
  'awaiting-confirmation': {
    icon: 'icon-[lucide--circle-pause]',
    tone: 'text-amber-500',
    label: '等待确认',
  },
  succeeded: { icon: 'icon-[lucide--circle-check]', tone: 'text-emerald-500', label: '已完成' },
  failed: { icon: 'icon-[lucide--circle-x]', tone: 'text-red-500', label: '失败' },
  denied: { icon: 'icon-[lucide--ban]', tone: 'text-red-500', label: '已拒绝' },
  canceled: { icon: 'icon-[lucide--circle-slash]', tone: 'text-muted-foreground', label: '已取消' },
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
    <span :class="cn('size-4', glyph.icon, glyph.tone)" aria-hidden="true" />
  </span>
</template>
