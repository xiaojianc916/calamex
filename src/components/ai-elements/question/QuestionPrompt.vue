<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import { InputGroup } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

import type {
  IAskUserQuestion,
  IAskUserResult,
  IQuestionAnswer,
  IQuestionOption,
} from './types';

/**
 * AI 反向提问浮层（纯展示 + 键鼠交互，无取数 / 业务逻辑）。
 *
 * 形态对齐设计稿：主输入框「生长」为问卷 —— 故容器复用 InputGroup，
 * 边框 / 圆角 / 阴影 / 聚焦环与项目主输入框（PromptInput → InputGroup）完全一致。
 * 多题分页（1/N，翻的是题不是选项）；每题 3-4 个选项，单选(radio) 或 多选(checkbox)；
 * 最后一个 kind:'free-text' 选项就在该选项长条上直接填写，不额外新增输入框；
 * 决策通过 submit / cancel 事件上抛，由上层 composable 走 /resume 恢复挂起的工具。
 */
const props = withDefaults(
  defineProps<{
    questions: IAskUserQuestion[];
    disabled?: boolean;
    autofocus?: boolean;
  }>(),
  {
    disabled: false,
    autofocus: true,
  },
);

const emit = defineEmits<{
  submit: [result: IAskUserResult];
  cancel: [];
}>();

interface IDraft {
  optionIds: Set<string>;
  text: string;
}

const drafts = new Map<string, IDraft>();
const pageIndex = ref(0);
const activeIndex = ref(0);
const rootEl = ref<HTMLElement | null>(null);
const freeInputEl = ref<HTMLInputElement | null>(null);

const total = computed((): number => props.questions.length);
const current = computed((): IAskUserQuestion | undefined => props.questions[pageIndex.value]);
const isLast = computed((): boolean => pageIndex.value >= total.value - 1);

const draftFor = (questionId: string): IDraft => {
  const existing = drafts.get(questionId);
  if (existing) {
    return existing;
  }
  const created: IDraft = { optionIds: new Set<string>(), text: '' };
  drafts.set(questionId, created);
  return created;
};

const isSelected = (question: IAskUserQuestion, option: IQuestionOption): boolean => {
  const draft = draftFor(question.id);
  if (option.kind === 'free-text') {
    return draft.text.trim().length > 0;
  }
  return draft.optionIds.has(option.id);
};

const clampIndex = (index: number): number => {
  const count = current.value?.options.length ?? 0;
  if (count === 0) {
    return 0;
  }
  return ((index % count) + count) % count;
};

const focusActiveFreeText = async (): Promise<void> => {
  await nextTick();
  const option = current.value?.options[activeIndex.value];
  if (option?.kind === 'free-text') {
    freeInputEl.value?.focus();
  }
};

const moveActive = (delta: number): void => {
  activeIndex.value = clampIndex(activeIndex.value + delta);
  void focusActiveFreeText();
};

const toggleOption = (question: IAskUserQuestion, option: IQuestionOption): void => {
  if (props.disabled) {
    return;
  }
  const draft = draftFor(question.id);
  if (option.kind === 'free-text') {
    freeInputEl.value?.focus();
    return;
  }
  if (question.multiple) {
    if (draft.optionIds.has(option.id)) {
      draft.optionIds.delete(option.id);
    } else {
      draft.optionIds.add(option.id);
    }
    return;
  }
  draft.optionIds.clear();
  draft.optionIds.add(option.id);
  draft.text = '';
};

const onFreeInput = (event: Event): void => {
  const question = current.value;
  if (!question) {
    return;
  }
  const draft = draftFor(question.id);
  draft.text = (event.target as HTMLInputElement).value;
  if (!question.multiple && draft.text.trim().length > 0) {
    draft.optionIds.clear();
  }
};

const buildAnswers = (): IQuestionAnswer[] =>
  props.questions.map((question) => {
    const draft = draftFor(question.id);
    const answer: IQuestionAnswer = {
      questionId: question.id,
      optionIds: [...draft.optionIds],
    };
    const text = draft.text.trim();
    if (text.length > 0) {
      answer.text = text;
    }
    return answer;
  });

const goNext = (): void => {
  if (props.disabled) {
    return;
  }
  if (!isLast.value) {
    pageIndex.value += 1;
    return;
  }
  emit('submit', { answers: buildAnswers() });
};

const skipCurrent = (): void => {
  const question = current.value;
  if (!question) {
    return;
  }
  const draft = draftFor(question.id);
  draft.optionIds.clear();
  draft.text = '';
  goNext();
};

const handleKeydown = (event: KeyboardEvent): void => {
  if (props.disabled || !current.value) {
    return;
  }
  const inFreeText =
    document.activeElement instanceof HTMLInputElement &&
    document.activeElement === freeInputEl.value;

  switch (event.key) {
    case 'ArrowDown': {
      event.preventDefault();
      moveActive(1);
      return;
    }
    case 'Tab': {
      event.preventDefault();
      moveActive(event.shiftKey ? -1 : 1);
      return;
    }
    case 'ArrowUp': {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    case 'Enter': {
      event.preventDefault();
      goNext();
      return;
    }
    case ' ': {
      if (inFreeText) {
        return;
      }
      event.preventDefault();
      const option = current.value.options[activeIndex.value];
      if (option) {
        toggleOption(current.value, option);
      }
      return;
    }
    case 'Escape': {
      event.preventDefault();
      emit('cancel');
      return;
    }
    default:
      break;
  }

  if (!inFreeText && /^[1-9]$/.test(event.key)) {
    const index = Number.parseInt(event.key, 10) - 1;
    const option = current.value.options[index];
    if (option) {
      event.preventDefault();
      activeIndex.value = index;
      toggleOption(current.value, option);
      void focusActiveFreeText();
    }
  }
};

watch(pageIndex, () => {
  activeIndex.value = 0;
});

onMounted(() => {
  if (props.autofocus && !props.disabled) {
    rootEl.value?.focus();
  }
});
</script>

<template>
  <section
    ref="rootEl"
    class="question-prompt"
    role="group"
    :aria-label="current?.prompt"
    :tabindex="disabled ? -1 : 0"
    @keydown="handleKeydown"
  >
    <InputGroup class="question-prompt__box !h-auto flex-col items-stretch gap-2 p-3">
      <header class="question-prompt__head">
        <span class="question-prompt__kind">需要你确认</span>
        <span v-if="total > 1" class="question-prompt__page"> pageIndex + 1 / total </span>
      </header>

      <p v-if="current" class="question-prompt__title" v-text="current.prompt" />
      <span v-if="current?.multiple" class="question-prompt__multi">可多选</span>

      <ul v-if="current" class="question-prompt__options" role="listbox">
        <li
          v-for="(option, index) in current.options"
          :key="option.id"
          :class="
            cn(
              'question-prompt__option',
              index === activeIndex && 'is-active',
              isSelected(current, option) && 'is-selected',
              option.kind === 'free-text' && 'is-free',
            )
          "
          role="option"
          :aria-selected="isSelected(current, option)"
          @mouseenter="activeIndex = index"
          @click="toggleOption(current, option)"
        >
          <span
            :class="cn('question-prompt__marker', current.multiple ? 'is-checkbox' : 'is-radio')"
            aria-hidden="true"
          />
          <span class="question-prompt__num" aria-hidden="true" v-text="index + 1" />
          <input
            v-if="option.kind === 'free-text'"
            ref="freeInputEl"
            class="question-prompt__free"
            type="text"
            :placeholder="option.label"
            :value="draftFor(current.id).text"
            :disabled="disabled"
            @input="onFreeInput"
            @focus="activeIndex = index"
          />
          <template v-else>
            <span class="question-prompt__label" v-text="option.label" />
            <span
              v-if="option.description"
              class="question-prompt__tag"
              v-text="option.description"
            />
          </template>
        </li>
      </ul>

      <footer class="question-prompt__foot">
        <span class="question-prompt__hint">Tab / ↑↓ 选择 · Enter 继续 · Esc 取消</span>
        <div class="question-prompt__actions">
          <button
            type="button"
            class="question-prompt__btn"
            :disabled="disabled"
            @click="skipCurrent"
          >
            忽略
          </button>
          <button
            type="button"
            class="question-prompt__btn is-primary"
            :disabled="disabled"
            @click="goNext"
          >
             isLast ? '提交' : '继续' 
          </button>
        </div>
      </footer>
    </InputGroup>
  </section>
</template>

<style scoped>
/* 边框 / 圆角 / 阴影 / 聚焦环统一由 InputGroup 提供，确保与主输入框完全一致。 */
.question-prompt {
  outline: none;
}

.question-prompt__box {
  background: var(--surface, transparent);
}

.question-prompt__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.question-prompt__kind {
  color: var(--accent-strong);
  font-size: 12px;
  font-weight: 500;
}

.question-prompt__page {
  color: var(--text-tertiary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.question-prompt__title {
  margin: 0;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}

.question-prompt__multi {
  align-self: flex-start;
  color: var(--accent-strong);
  font-size: 11px;
}

.question-prompt__options {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
}

.question-prompt__option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
}

.question-prompt__option.is-active {
  border-color: color-mix(in srgb, var(--accent-strong) 55%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-strong) 18%, transparent);
}

.question-prompt__option.is-selected {
  border-color: var(--accent-strong);
  background: color-mix(in srgb, var(--accent-strong) 12%, transparent);
}

.question-prompt__option.is-free {
  cursor: text;
}

.question-prompt__marker {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  border: 1.5px solid var(--text-tertiary);
  display: grid;
  place-items: center;
}

.question-prompt__marker.is-radio {
  border-radius: 50%;
}

.question-prompt__marker.is-checkbox {
  border-radius: 4px;
}

.question-prompt__option.is-selected .question-prompt__marker {
  border-color: var(--accent-strong);
  background: var(--accent-strong);
}

.question-prompt__num {
  flex: 0 0 auto;
  min-width: 14px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 10px;
  text-align: center;
}

.question-prompt__label {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
}

.question-prompt__tag {
  flex: 0 0 auto;
  color: var(--accent-strong);
  font-size: 11px;
}

.question-prompt__free {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
  outline: none;
}

.question-prompt__free::placeholder {
  color: var(--text-tertiary);
}

.question-prompt__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 2px;
}

.question-prompt__hint {
  color: var(--text-tertiary);
  font-size: 11px;
}

.question-prompt__actions {
  display: flex;
  gap: 6px;
}

.question-prompt__btn {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.question-prompt__btn.is-primary {
  border-color: var(--accent-strong);
  background: var(--accent-strong);
  color: var(--accent-on, #fff);
}

.question-prompt__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
