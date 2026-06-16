<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import { InputGroup } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

import type { IAskUserQuestion, IAskUserResult, IQuestionAnswer, IQuestionOption } from './types';

/**
 * AI 反向提问浮层（纯展示 + 键鼠交互，无取数 / 业务逻辑）。
 *
 * 取长补短，同时对齐两套成熟实现（契约见 ./types.ts）：
 * - 形态：主输入框「生长」为问卷 —— 容器复用 InputGroup，边框 / 圆角 / 阴影 / 聚焦环
 *   与项目主输入框（PromptInput → InputGroup）完全一致。
 * - 问题结构对齐 Gemini CLI ask_user：多题分页(1/N，翻的是题不是选项)；
 *   choice 型 2-4 个 radio/checkbox 选项，yesno 型渲染 是/否，text 型仅一个输入框；
 *   自由填写不是数组里的假选项，而是每题底部恒在的「Other」输入框（由 placeholder 提示）。
 * - 结果形态对齐 ACP request_permission：submit => outcome:'selected'；cancel => outcome:'cancelled'。
 *
 * 注：动态文案均走 v-text 绑定 computed，不使用 Vue mustache 插值 ——
 * 双花括号会与作者管道的压缩 URL 占位符语法冲突。
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

/** yesno 型在 UI 层合成的两个固定选项（answer 仍走 optionId 模型，对齐 ACP）。 */
const YESNO_OPTIONS: readonly IQuestionOption[] = Object.freeze([
  { optionId: 'yes', label: '是' },
  { optionId: 'no', label: '否' },
]);

const drafts = new Map<string, IDraft>();
const pageIndex = ref(0);
const activeIndex = ref(0);
const rootEl = ref<HTMLElement | null>(null);
const freeInputEl = ref<HTMLInputElement | null>(null);

const total = computed((): number => props.questions.length);
const current = computed((): IAskUserQuestion | undefined => props.questions[pageIndex.value]);
const isLast = computed((): boolean => pageIndex.value >= total.value - 1);

/** 页码指示：N / M。 */
const pageLabel = computed((): string => `${pageIndex.value + 1} / ${total.value}`);

/** 主按钮文案：最后一题提交，否则继续。 */
const primaryLabel = computed((): string => (isLast.value ? '提交' : '继续'));

/** 底部键位提示。 */
const hintText = computed((): string => `Tab / ↑↓ 选择 · Enter ${primaryLabel.value} · Esc 取消`);

/** choice => 配置选项；yesno => 合成是/否；text => 无选项（仅自由填写）。 */
const optionsFor = (question: IAskUserQuestion): readonly IQuestionOption[] => {
  if (question.type === 'yesno') {
    return YESNO_OPTIONS;
  }
  if (question.type === 'choice') {
    return question.options ?? [];
  }
  return [];
};

const currentOptions = computed((): readonly IQuestionOption[] =>
  current.value ? optionsFor(current.value) : [],
);

/** 仅 choice 且 multiSelect 时为多选(checkbox)，其余为单选(radio)。 */
const isMultiSelect = (question: IAskUserQuestion): boolean =>
  question.type === 'choice' && question.multiSelect === true;

/** 自由填写行恒为最后一行；text 型只有这一行。 */
const freeRowIndex = computed((): number => currentOptions.value.length);
const rowCount = computed((): number => currentOptions.value.length + 1);
const isFreeRow = (index: number): boolean => index === freeRowIndex.value;

const freePlaceholder = computed((): string => {
  const question = current.value;
  if (!question) {
    return '';
  }
  if (question.placeholder && question.placeholder.length > 0) {
    return question.placeholder;
  }
  return question.type === 'text' ? '输入你的回答…' : '其他（自由填写）…';
});

const draftFor = (questionId: string): IDraft => {
  const existing = drafts.get(questionId);
  if (existing) {
    return existing;
  }
  const created: IDraft = { optionIds: new Set<string>(), text: '' };
  drafts.set(questionId, created);
  return created;
};

const isOptionSelected = (question: IAskUserQuestion, option: IQuestionOption): boolean =>
  draftFor(question.questionId).optionIds.has(option.optionId);

const isFreeFilled = (question: IAskUserQuestion): boolean =>
  draftFor(question.questionId).text.trim().length > 0;

const clampIndex = (index: number): number => {
  const count = rowCount.value;
  if (count === 0) {
    return 0;
  }
  return ((index % count) + count) % count;
};

const focusActiveFreeText = async (): Promise<void> => {
  await nextTick();
  if (isFreeRow(activeIndex.value)) {
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
  const draft = draftFor(question.questionId);
  if (isMultiSelect(question)) {
    if (draft.optionIds.has(option.optionId)) {
      draft.optionIds.delete(option.optionId);
    } else {
      draft.optionIds.add(option.optionId);
    }
    return;
  }
  // 单选 / yesno：选项与自由填写互斥。
  draft.optionIds.clear();
  draft.optionIds.add(option.optionId);
  draft.text = '';
};

const onFreeInput = (event: Event): void => {
  const question = current.value;
  if (!question) {
    return;
  }
  const draft = draftFor(question.questionId);
  draft.text = (event.target as HTMLInputElement).value;
  // 单选 / yesno：填了自由文本即清空已选项（多选则与选项共存）。
  if (!isMultiSelect(question) && draft.text.trim().length > 0) {
    draft.optionIds.clear();
  }
};

const activateRow = (question: IAskUserQuestion, index: number): void => {
  activeIndex.value = index;
  if (isFreeRow(index)) {
    freeInputEl.value?.focus();
    return;
  }
  const option = currentOptions.value[index];
  if (option) {
    toggleOption(question, option);
  }
};

const buildAnswers = (): IQuestionAnswer[] =>
  props.questions.map((question) => {
    const draft = draftFor(question.questionId);
    const answer: IQuestionAnswer = {
      questionId: question.questionId,
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
  emit('submit', { outcome: 'selected', answers: buildAnswers() });
};

const skipCurrent = (): void => {
  const question = current.value;
  if (!question) {
    return;
  }
  const draft = draftFor(question.questionId);
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
      activateRow(current.value, activeIndex.value);
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
    if (index < rowCount.value) {
      event.preventDefault();
      activateRow(current.value, index);
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
    :aria-label="current?.question"
    :tabindex="disabled ? -1 : 0"
    @keydown="handleKeydown"
  >
    <InputGroup class="question-prompt__box !h-auto flex-col items-stretch gap-2 p-3">
      <header class="question-prompt__head">
        <span v-if="current" class="question-prompt__kind" v-text="current.header" />
        <span v-if="total > 1" class="question-prompt__page" v-text="pageLabel" />
      </header>

      <p v-if="current" class="question-prompt__title" v-text="current.question" />
      <span v-if="current && isMultiSelect(current)" class="question-prompt__multi">可多选</span>

      <ul v-if="current" class="question-prompt__options" role="listbox">
        <li
          v-for="(option, index) in currentOptions"
          :key="option.optionId"
          :class="
            cn(
              'question-prompt__option',
              index === activeIndex && 'is-active',
              isOptionSelected(current, option) && 'is-selected',
            )
          "
          role="option"
          :aria-selected="isOptionSelected(current, option)"
          @mouseenter="activeIndex = index"
          @click="toggleOption(current, option)"
        >
          <span
            :class="cn('question-prompt__marker', isMultiSelect(current) ? 'is-checkbox' : 'is-radio')"
            aria-hidden="true"
          />
          <span class="question-prompt__num" aria-hidden="true" v-text="index + 1" />
          <span class="question-prompt__label" v-text="option.label" />
          <span
            v-if="option.description"
            class="question-prompt__tag"
            v-text="option.description"
          />
        </li>

        <li
          :class="
            cn(
              'question-prompt__option is-free',
              freeRowIndex === activeIndex && 'is-active',
              isFreeFilled(current) && 'is-selected',
            )
          "
          role="option"
          :aria-selected="isFreeFilled(current)"
          @mouseenter="activeIndex = freeRowIndex"
          @click="freeInputEl?.focus()"
        >
          <span
            v-if="current.type !== 'text'"
            :class="cn('question-prompt__marker', isMultiSelect(current) ? 'is-checkbox' : 'is-radio')"
            aria-hidden="true"
          />
          <span
            v-if="current.type !== 'text'"
            class="question-prompt__num"
            aria-hidden="true"
            v-text="freeRowIndex + 1"
          />
          <input
            ref="freeInputEl"
            class="question-prompt__free"
            type="text"
            :placeholder="freePlaceholder"
            :value="draftFor(current.questionId).text"
            :disabled="disabled"
            @input="onFreeInput"
            @focus="activeIndex = freeRowIndex"
          />
        </li>
      </ul>

      <footer class="question-prompt__foot">
        <span class="question-prompt__hint" v-text="hintText" />
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
            v-text="primaryLabel"
          />
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
