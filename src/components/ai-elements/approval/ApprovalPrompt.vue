<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';

import { cn } from '@/lib/utils';

import type { IApprovalPromptOption } from './types';

/**
 * Codex 风格审批浮层(纯展示)。
 *
 * 忠实移植自 Codex TUI `bottom_pane/approval_overlay.rs` +
 * `selection_popup_common.rs` 的结构:
 *   加粗问句标题 → 可选 Reason(斜体) → 可选上下文(命令/补丁,走 #context 插槽)
 *   → 竖排可选项列表(每项含单键快捷键,↑↓ 移动、Enter 选中、Esc 取消、
 *     选中行用强调色)→ 底部暗色提示行。
 *
 * 本组件不含任何业务/取数逻辑,仅负责呈现与键鼠交互,决策通过事件上抛。
 */
const props = withDefaults(
  defineProps<{
    title: string;
    reason?: string | null;
    options: IApprovalPromptOption[];
    footerHint?: string;
    disabled?: boolean;
    autofocus?: boolean;
  }>(),
  {
    reason: null,
    footerHint: 'Enter 确认 · Esc 取消',
    disabled: false,
    autofocus: false,
  },
);

const emit = defineEmits<{
  select: [id: string];
  cancel: [];
}>();

const rootEl = ref<HTMLElement | null>(null);
const activeIndex = ref(0);

watch(
  () => props.options.map((option) => option.id).join('|'),
  () => {
    activeIndex.value = 0;
  },
);

const clampIndex = (index: number): number => {
  const count = props.options.length;
  if (count === 0) {
    return 0;
  }
  return ((index % count) + count) % count;
};

const moveActive = (delta: number): void => {
  if (props.options.length === 0) {
    return;
  }
  activeIndex.value = clampIndex(activeIndex.value + delta);
};

const selectOption = (option: IApprovalPromptOption | undefined): void => {
  if (!option || props.disabled) {
    return;
  }
  emit('select', option.id);
};

const handleKeydown = (event: KeyboardEvent): void => {
  if (props.disabled) {
    return;
  }

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      moveActive(1);
      return;
    case 'ArrowUp':
      event.preventDefault();
      moveActive(-1);
      return;
    case 'Enter':
      event.preventDefault();
      selectOption(props.options[activeIndex.value]);
      return;
    case 'Escape':
      event.preventDefault();
      emit('cancel');
      return;
    default:
      break;
  }

  const shortcutMatch = props.options.find(
    (option) =>
      typeof option.shortcut === 'string' &&
      option.shortcut.toLowerCase() === event.key.toLowerCase(),
  );
  if (shortcutMatch) {
    event.preventDefault();
    selectOption(shortcutMatch);
  }
};

onMounted(() => {
  if (props.autofocus && !props.disabled) {
    rootEl.value?.focus();
  }
});
</script>

<template>
  <section
    ref="rootEl"
    class="approval-prompt"
    role="group"
    :aria-label="title"
    :tabindex="disabled ? -1 : 0"
    @keydown="handleKeydown"
  >
    <p class="approval-prompt__title" v-text="title" />

    <p v-if="reason" class="approval-prompt__reason">
      <span class="approval-prompt__reason-label">Reason</span>
      <span class="approval-prompt__reason-text" v-text="reason" />
    </p>

    <div v-if="$slots.context" class="approval-prompt__context">
      <slot name="context" />
    </div>

    <ul class="approval-prompt__options" role="listbox">
      <li
        v-for="(option, index) in options"
        :key="option.id"
        :class="
          cn(
            'approval-prompt__option',
            index === activeIndex && 'is-active',
            option.tone === 'danger' && 'is-danger',
          )
        "
        role="option"
        :aria-selected="index === activeIndex"
        @mouseenter="activeIndex = index"
        @click="selectOption(option)"
      >
        <span class="approval-prompt__caret" aria-hidden="true">›</span>
        <span class="approval-prompt__label" v-text="option.label" />
        <kbd v-if="option.shortcut" class="approval-prompt__kbd" v-text="option.shortcut" />
      </li>
    </ul>

    <p class="approval-prompt__hint" v-text="footerHint" />
  </section>
</template>

<style scoped>
.approval-prompt {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface-soft);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 18px;
  outline: none;
}

.approval-prompt:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-strong) 35%, transparent);
}

.approval-prompt__title {
  margin: 0;
  color: var(--text-primary);
  font-weight: 500;
  letter-spacing: -0.01em;
}

.approval-prompt__reason {
  display: flex;
  gap: 6px;
  margin: 0;
  min-width: 0;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 16px;
}

.approval-prompt__reason-label {
  flex: 0 0 auto;
  font-weight: 450;
}

.approval-prompt__reason-text {
  min-width: 0;
  font-style: italic;
  word-break: break-word;
}

.approval-prompt__context {
  margin: 2px 0;
  min-width: 0;
}

.approval-prompt__options {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
}

.approval-prompt__option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
}

.approval-prompt__option.is-active {
  background: color-mix(in srgb, var(--accent-strong) 12%, transparent);
  color: var(--accent-strong);
  font-weight: 450;
}

.approval-prompt__option.is-danger.is-active {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}

.approval-prompt__caret {
  flex: 0 0 auto;
  width: 8px;
  opacity: 0;
}

.approval-prompt__option.is-active .approval-prompt__caret {
  opacity: 1;
}

.approval-prompt__label {
  flex: 1 1 auto;
  min-width: 0;
}

.approval-prompt__kbd {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--surface-hover);
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 16px;
}

.approval-prompt__hint {
  margin: 4px 0 0;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 16px;
}
</style>
