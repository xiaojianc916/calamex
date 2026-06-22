// 12.mjs —— 自定义(空白)选项改为可点击真勾选：空白也能选中并发送；打字自动选中；单选互斥
import { readFileSync, writeFileSync } from 'node:fs';

const PROMPT = 'src/components/business/ai/chat/AiPromptInput.vue';

function patch(file, edits) {
  const raw = readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');
  let changed = 0;
  for (const { name, find, replace, done } of edits) {
    if (text.includes(done)) {
      console.log(`· ${name}: 已存在，跳过`);
      continue;
    }
    const n = text.split(find).length - 1;
    if (n !== 1) {
      throw new Error(`✗ ${name}: 锚点命中 ${n} 次（应为 1），已中止，未写入`);
    }
    text = text.replace(find, replace);
    changed++;
    console.log(`✓ ${name}: 已替换`);
  }
  if (changed > 0) {
    writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
    console.log(`→ 写回 ${file}（${changed} 处）`);
  }
}

patch(PROMPT, [
  {
    name: 'draft-type',
    done: 'text: string; freeSelected: boolean }>>(',
    find: `const questionDrafts = ref<Record<string, { optionIds: string[]; text: string }>>({});`,
    replace: `const questionDrafts = ref<Record<string, { optionIds: string[]; text: string; freeSelected: boolean }>>(
  {},
);`,
  },
  {
    name: 'ensure-draft-sig',
    done: '): { optionIds: string[]; text: string; freeSelected: boolean } => {',
    find: `const ensureQuestionDraft = (questionId: string): { optionIds: string[]; text: string } => {`,
    replace: `const ensureQuestionDraft = (
  questionId: string,
): { optionIds: string[]; text: string; freeSelected: boolean } => {`,
  },
  {
    name: 'ensure-draft-created',
    done: `const created = { optionIds: [] as string[], text: '', freeSelected: false };`,
    find: `  const created = { optionIds: [] as string[], text: '' };`,
    replace: `  const created = { optionIds: [] as string[], text: '', freeSelected: false };`,
  },
  {
    name: 'current-draft',
    done: `: { optionIds: [], text: '', freeSelected: false },`,
    find: `const currentDraft = computed(() =>
  currentQuestion.value
    ? (questionDrafts.value[currentQuestion.value.questionId] ?? { optionIds: [], text: '' })
    : { optionIds: [], text: '' },
);`,
    replace: `const currentDraft = computed(() =>
  currentQuestion.value
    ? (questionDrafts.value[currentQuestion.value.questionId] ?? {
        optionIds: [],
        text: '',
        freeSelected: false,
      })
    : { optionIds: [], text: '', freeSelected: false },
);`,
  },
  {
    name: 'toggle-option-clear-free',
    done: 'freeSelected: multi ? draft.freeSelected : false,',
    find: `  questionDrafts.value = {
    ...questionDrafts.value,
    [question.questionId]: { ...draft, optionIds: nextIds },
  };
};`,
    replace: `  questionDrafts.value = {
    ...questionDrafts.value,
    [question.questionId]: {
      ...draft,
      optionIds: nextIds,
      freeSelected: multi ? draft.freeSelected : false,
    },
  };
};`,
  },
  {
    name: 'update-text',
    done: 'const freeSelected = value.trim().length > 0 ? true : draft.freeSelected;',
    find: `  const draft = ensureQuestionDraft(question.questionId);
  questionDrafts.value = {
    ...questionDrafts.value,
    [question.questionId]: { ...draft, text: value },
  };
};`,
    replace: `  const draft = ensureQuestionDraft(question.questionId);
  const multi = question.multiSelect === true;
  const freeSelected = value.trim().length > 0 ? true : draft.freeSelected;
  questionDrafts.value = {
    ...questionDrafts.value,
    [question.questionId]: {
      ...draft,
      text: value,
      freeSelected,
      optionIds: !multi && freeSelected ? [] : draft.optionIds,
    },
  };
};`,
  },
  {
    name: 'toggle-free-and-computed',
    done: 'const toggleFreeOption = (): void => {',
    find: `const onQuestionTextInput = (event: Event): void => {
  updateQuestionText((event.target as HTMLTextAreaElement | null)?.value ?? '');
};`,
    replace: `const onQuestionTextInput = (event: Event): void => {
  updateQuestionText((event.target as HTMLTextAreaElement | null)?.value ?? '');
};

const isFreeSelected = computed(() => currentDraft.value.freeSelected === true);

const toggleFreeOption = (): void => {
  const question = currentQuestion.value;
  if (!question) {
    return;
  }
  const draft = ensureQuestionDraft(question.questionId);
  const multi = question.multiSelect === true;
  const nextFree = !draft.freeSelected;
  questionDrafts.value = {
    ...questionDrafts.value,
    [question.questionId]: {
      ...draft,
      freeSelected: nextFree,
      optionIds: !multi && nextFree ? [] : draft.optionIds,
    },
  };
};`,
  },
  {
    name: 'draft-answered',
    done: '|| draft.freeSelected === true;',
    find: `  return draft.optionIds.length > 0 || draft.text.trim().length > 0;`,
    replace: `  return draft.optionIds.length > 0 || draft.text.trim().length > 0 || draft.freeSelected === true;`,
  },
  {
    name: 'build-answers-default',
    done: `questionDrafts.value[question.questionId] ?? { optionIds: [], text: '', freeSelected: false };`,
    find: `    const draft = questionDrafts.value[question.questionId] ?? { optionIds: [], text: '' };`,
    replace: `    const draft = questionDrafts.value[question.questionId] ?? { optionIds: [], text: '', freeSelected: false };`,
  },
  {
    name: 'template-free-row',
    done: `:class="{ 'is-selected': isFreeSelected }"`,
    find: `              <div
                class="ai-question-option ai-question-free-row"
                :class="{ 'is-selected': currentDraft.text.trim().length > 0 }"
              >
                <span class="ai-question-checkbox" aria-hidden="true">
                  <Check
                    v-if="currentDraft.text.trim().length > 0"
                    class="ai-question-check"
                  />
                </span>
                <textarea
                  class="ai-question-free"
                  rows="1"
                  :placeholder="currentQuestion?.placeholder || '或者，请描述你的要求……'"
                  :value="currentDraft.text"
                  @input="onQuestionTextInput"
                ></textarea>
              </div>`,
    replace: `              <div
                class="ai-question-option ai-question-free-row"
                :class="{ 'is-selected': isFreeSelected }"
              >
                <button
                  type="button"
                  class="ai-question-free-check"
                  aria-label="选择自定义回答"
                  @click="toggleFreeOption"
                >
                  <span class="ai-question-checkbox" aria-hidden="true">
                    <Check v-if="isFreeSelected" class="ai-question-check" />
                  </span>
                </button>
                <textarea
                  class="ai-question-free"
                  rows="1"
                  :placeholder="currentQuestion?.placeholder || '或者，请描述你的要求……'"
                  :value="currentDraft.text"
                  @input="onQuestionTextInput"
                ></textarea>
              </div>`,
  },
  {
    name: 'css-free-check',
    done: '.ai-question-free-check {',
    find: `.ai-question-free-row {
  cursor: text;
}`,
    replace: `.ai-question-free-row {
  cursor: text;
}

.ai-question-free-check {
  display: inline-flex;
  align-items: flex-start;
  border: 0;
  background: transparent;
  padding: 0;
  margin: 0;
  cursor: pointer;
}`,
  },
]);

console.log('完成。');