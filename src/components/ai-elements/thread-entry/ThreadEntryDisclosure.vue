<script setup lang="ts">
import { ChevronDown, ChevronRight } from '@lucide/vue';
import { AnimatePresence, motion } from 'motion-v';
import type { HTMLAttributes } from 'vue';
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/**
 * 平铺时间线中的可折叠“扁平行”。对齐 Zed `ThreadView` 把工具调用 / 思考块渲染为
 * 一行可展开条目的做法：行首字形 + 标题 + 右侧元信息 + 展开箭头，展开后在原地铺开
 * 内容，而不是弹出独立卡片 / 面板。
 *
 * `leadingChevron` 对齐 Zed 工具调用行：折叠箭头（▶ 展开转为 ▼）放在行首最左侧，
 * 位于工具图标之前；此时隐藏行尾箭头。默认（思考块等）仍为行尾箭头。
 *
 * 展开 / 折叠过渡由 motion-v 驱动：高度做弹簧(spring)插值、配合透明度淑入淑出，
 * 形成更自然的开合动画（替代原 tw-animate 的线性 slide/fade）。由 AnimatePresence
 * 管理进 / 出场，故折叠时内容在退场动画结束后才卸载。
 *
 * 纯展示：展开状态由上层受控（`open` + `update:open`），组件自身不持有长期状态，
 * 也不感知任何业务含义；所有内容通过插槽注入。
 */
const props = withDefaults(
  defineProps<{
    /** 受控展开状态。 */
    open?: boolean;
    /** 标题文本（也可用 `title` 插槽覆盖）。 */
    title?: string;
    /** 无可展开内容时禁用：仅作为静态行展示，不渲染箭头与折叠区。 */
    disabled?: boolean;
    /** 折叠箭头渲染在行首（Zed 工具调用风格），并隐藏行尾箭头。 */
    leadingChevron?: boolean;
    class?: HTMLAttributes['class'];
  }>(),
  {
    open: false,
    title: '',
    disabled: false,
    leadingChevron: false,
    class: undefined,
  },
);

const emit = defineEmits<{
  'update:open': [value: boolean];
}>();

const handleUpdateOpen = (value: boolean): void => {
  if (props.disabled) {
    return;
  }

  emit('update:open', value);
};
</script>

<template>
  <Collapsible
    :open="props.disabled ? false : props.open"
    :class="cn('thread-entry-disclosure w-full min-w-0', props.class)"
    @update:open="handleUpdateOpen"
  >
    <CollapsibleTrigger as-child :disabled="props.disabled">
      <button
        type="button"
        class="group flex w-full min-w-0 items-center gap-2 py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
      >
        <ChevronRight class="thread-entry-disclosure__chevron thread-entry-disclosure__chevron--leading size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" v-if="props.leadingChevron && !props.disabled" aria-hidden="true" />
        <span class="flex size-4 shrink-0 items-center justify-center">
          <slot name="leading" />
        </span>
        <span class="min-w-0 flex-1 truncate text-foreground">
          <slot name="title"><span v-text="props.title" /></slot>
        </span>
        <span class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <slot name="meta" />
        </span>
        <ChevronDown class="thread-entry-disclosure__chevron size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" v-if="!props.disabled && !props.leadingChevron" aria-hidden="true" />
      </button>
    </CollapsibleTrigger>
    <AnimatePresence :initial="false">
      <motion.div
        v-if="!props.disabled && props.open"
        key="thread-entry-disclosure-content"
        class="thread-entry-disclosure__panel overflow-hidden outline-none"
        :initial="{ height: 0, opacity: 0 }"
        :animate="{ height: 'auto', opacity: 1 }"
        :exit="{ height: 0, opacity: 0 }"
        :transition="{
          height: { type: 'spring', stiffness: 320, damping: 34, mass: 0.9 },
          opacity: { duration: 0.2, ease: 'easeOut' },
        }"
      >
        <div class="thread-entry-disclosure__content mt-1 min-w-0 pl-6">
          <slot name="content" />
        </div>
      </motion.div>
    </AnimatePresence>
  </Collapsible>
</template>
