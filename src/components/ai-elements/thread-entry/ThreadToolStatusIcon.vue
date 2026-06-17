<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { computed } from 'vue';
import type { TAiThreadToolViewStatus } from '@/components/business/ai/thread/projection/tool-view';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import { cn } from '@/lib/utils';

/**
 * Zed 风格工具调用状态：运行/等待/失败需要可见反馈；成功态保持克制，不再显示
 * 绿色大对勾，避免每个完成工具行都出现强提示色。
 *
 * 颜色收口：等待确认 / 失败 / 拒绝等强调态统一映射到设计 token(--warning / --danger),
 * 与 AiThreadToolCall 的 --success / --danger 家族保持一致,不再使用 Tailwind 调色板
 * 硬编码(text-amber-500 / text-red-500),以便随主题与 One Light 作用域联动。
 *
 * 状态取值收口到投影层 `TAiThreadToolViewStatus`(单一真源),本组件作为消费者反向
 * 引用该类型(type-only,跨层仅类型,编译期擦除),消除并存定义。
 */
const props = withDefaults(
  defineProps<{
    status?: TAiThreadToolViewStatus;
    class?: HTMLAttributes['class'];
  }>(),
  {
    status: 'pending',
    class: undefined,
  },
);

interface IStatusGlyph {
  icon: string | null;
  /** 非颜色工具类(如 animate-spin)与语义回退色(muted)。 */
  tone: string;
  /** 强调态颜色 token 名;存在时优先于 tone 的颜色,经内联 style 注入。 */
  colorVar?: string;
  label: string;
}

const STATUS_GLYPHS: Record<TAiThreadToolViewStatus, IStatusGlyph> = {
  pending: { icon: 'circle', tone: 'text-muted-foreground', label: '等待中' },
  running: {
    icon: 'loader-circle',
    tone: 'text-muted-foreground animate-spin',
    label: '进行中',
  },
  'awaiting-confirmation': {
    icon: 'circle-alert',
    tone: '',
    colorVar: '--warning',
    label: '等待确认',
  },
  succeeded: { icon: null, tone: 'text-muted-foreground', label: '已完成' },
  failed: { icon: 'circle-alert', tone: '', colorVar: '--danger', label: '失败' },
  denied: { icon: 'ban', tone: '', colorVar: '--danger', label: '已拒绝' },
  canceled: { icon: 'circle-slash', tone: 'text-muted-foreground', label: '已取消' },
};

const glyph = computed<IStatusGlyph>(() => STATUS_GLYPHS[props.status]);

const glyphStyle = computed(() =>
  glyph.value.colorVar ? { color: `var(${glyph.value.colorVar})` } : undefined,
);
</script>

<template>
  <span
    :class="cn('inline-flex size-4 shrink-0 items-center justify-center', props.class)"
    role="img"
    :aria-label="glyph.label"
    :data-status="props.status"
  >
    <LucideIcon
      v-if="glyph.icon"
      :name="glyph.icon"
      :class="cn('size-3.5', glyph.tone)"
      :style="glyphStyle"
      aria-hidden="true"
    />
  </span>
</template>
