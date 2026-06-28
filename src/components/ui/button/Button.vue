<script setup lang="ts">
import { tv, type VariantProps } from 'tailwind-variants';
import type { ButtonHTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

const buttonVariants = tv({
  base: 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-strong)]/40 disabled:pointer-events-auto disabled:cursor-default disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 active:scale-[0.985] disabled:active:scale-100',
  variants: {
    variant: {
      default:
        'border border-transparent bg-[var(--accent-strong)] text-white shadow-sm hover:brightness-110 disabled:hover:brightness-100',
      outline:
        'border border-[var(--border-subtle)] bg-white/[0.03] text-[var(--text-secondary)] hover:bg-white/[0.06] hover:text-[var(--text-primary)] disabled:hover:bg-white/[0.03] disabled:hover:text-[var(--text-secondary)]',
      ghost:
        'border border-transparent bg-transparent text-[var(--text-tertiary)] hover:bg-white/[0.06] hover:text-[var(--text-primary)] disabled:hover:bg-transparent disabled:hover:text-[var(--text-tertiary)]',
    },
    size: {
      default: 'h-9 px-4 py-2',
      sm: 'h-8 px-3 text-[12px]',
      icon: 'h-8 w-8',
      'icon-sm': 'h-8 w-8',
      lg: 'h-10 px-5',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
});

type TButtonVariants = VariantProps<typeof buttonVariants>;

const props = withDefaults(
  defineProps<{
    variant?: TButtonVariants['variant'];
    size?: TButtonVariants['size'];
    class?: ButtonHTMLAttributes['class'];
    type?: ButtonHTMLAttributes['type'];
    disabled?: boolean;
  }>(),
  {
    variant: 'default',
    size: 'default',
    class: undefined,
    type: 'button',
    disabled: false,
  },
);
</script>

<template>
  <button
    :type="props.type"
    :disabled="props.disabled"
    :class="cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)"
  >
    <slot />
  </button>
</template>
