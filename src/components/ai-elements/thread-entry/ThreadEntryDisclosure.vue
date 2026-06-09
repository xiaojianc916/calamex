<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/**
 * 平铺时间线中的可折叠“扁平行”。对齐 Zed `ThreadView` 把工具调用 / 思考块渲染为
 * 一行可展开条目的做法：行首字形 + 标题 + 右侧元信息 + 展开箭头，展开后在原地铺开
 * 内容，而不是弹出独立卡片 / 面板。
 *
 * `leadingChevron` 对齐 Zed 工具调用行：折叠箭头（▶ 展开转为 ▼）放在行首最左侧，
 * 位于工具图标之前；此时隐藏行尾箭头。默认（思考块等）仍为行尾箭头。
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
        <span
          v-if="props.leadingChevron && !props.disabled"
          class="thread-entry-disclosure__chevron thread-entry-disclosure__chevron--leading icon-[lucide--chevron-right] size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
        <span class="flex size-4 shrink-0 items-center justify-center">
          <slot name="leading" />
        </span>
        <span class="min-w-0 flex-1 truncate text-foreground">
          <slot name="title"><span v-text="props.title" /></slot>
        </span>
        <span class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <slot name="meta" />
        </span>
        <span
          v-if="!props.disabled && !props.leadingChevron"
          class="thread-entry-disclosure__chevron icon-[lucide--chevron-down] size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
      </button>
    </CollapsibleTrigger>
    <CollapsibleContent
      v-if="!props.disabled"
      :class="
        cn(
          'overflow-hidden outline-none',
          'data-[state=closed]:animate-out data-[state=open]:animate-in',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1',
        )
      "
    >
      <div class="thread-entry-disclosure__content mt-1 min-w-0 pl-6">
        <slot name="content" />
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>
