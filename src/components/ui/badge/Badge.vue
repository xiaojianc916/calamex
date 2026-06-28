<script setup lang="ts">
import { tv, type VariantProps } from 'tailwind-variants';
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

const badgeVariants = tv({
  base: 'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
  variants: {
    variant: {
      default: 'border-(--border) bg-white/[0.04] text-(--text-secondary)',
      secondary: 'border-(--border) bg-white/[0.03] text-(--text-tertiary)',
      destructive:
        'border-[color-mix(in_srgb,var(--danger)_28%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[color-mix(in_srgb,var(--danger)_78%,white)]',
      warning:
        'border-[color-mix(in_srgb,var(--warning)_28%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[color-mix(in_srgb,var(--warning)_88%,white)]',
      success:
        'border-[color-mix(in_srgb,var(--success)_30%,transparent)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[color-mix(in_srgb,var(--success)_72%,white)]',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

type TBadgeVariants = VariantProps<typeof badgeVariants>;

const props = withDefaults(
  defineProps<{
    variant?: TBadgeVariants['variant'];
    class?: HTMLAttributes['class'];
  }>(),
  {
    variant: 'default',
    class: undefined,
  },
);
</script>

<template>
    <span :class="cn(badgeVariants({ variant: props.variant }), props.class)">
        <slot />
    </span>
</template>