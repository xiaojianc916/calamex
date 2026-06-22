// 8.mjs —— 在仓库根目录运行: node 8.mjs
// 把 AiPromptInput 内嵌提问 UI 接进 ACP / plan 提问流; 移除外置 QuestionPrompt 兄弟块; 放开提问态工具栏。
import { readFile, writeFile } from 'node:fs/promises';

const PANEL = 'src/components/business/ai/shell/AiAssistantPanel.vue';

const detectEol = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
function replaceOnce(text, oldStr, newStr) {
  const i = text.indexOf(oldStr);
  if (i === -1) throw new Error('锚点未找到:\n---\n' + oldStr.slice(0, 140) + '\n---');
  if (text.indexOf(oldStr, i + 1) !== -1)
    throw new Error('锚点不唯一:\n---\n' + oldStr.slice(0, 140) + '\n---');
  return text.slice(0, i) + newStr + text.slice(i + oldStr.length);
}

const WRAPPERS = `
// 组合器内联提问：AiPromptInput 内嵌提问框的答案 / 取消，路由到既有 ACP / plan 提问处理器。
const handleComposerQuestionSubmit = (
  answers: NonNullable<IAskUserResult['answers']>,
): void => {
  const result: IAskUserResult = { outcome: 'selected', answers };
  if (acpApprovalQuestions.value) {
    void handleResolveAcpUserQuestion(result);
    return;
  }
  if (visibleUserQuestion.value) {
    void handleResolveUserQuestion(result);
  }
};
const handleComposerQuestionCancel = (): void => {
  if (acpApprovalQuestions.value) {
    void handleCancelAcpUserQuestion();
    return;
  }
  if (visibleUserQuestion.value) {
    void handleCancelUserQuestion();
  }
};`;

async function main() {
  const raw = await readFile(PANEL, 'utf8');
  const eol = detectEol(raw);
  let text = raw.split('\r\n').join('\n');

  if (text.includes('handleComposerQuestionSubmit')) {
    console.log('[8.mjs] AiAssistantPanel.vue 已接线，跳过。');
    return;
  }

  // 1) 移除已无用的 QuestionPrompt 导入
  text = replaceOnce(
    text,
    "import QuestionPrompt from '@/components/ai-elements/question/QuestionPrompt.vue';\n",
    '',
  );

  // 2) 插入路由包装器（紧随 isResolvingUserQuestion 定义；引用的处理器在运行期才调用，前向引用安全）
  text = replaceOnce(
    text,
    'const isResolvingUserQuestion = ref(false);',
    'const isResolvingUserQuestion = ref(false);' + WRAPPERS,
  );

  // 3) 收窄 composerDisabled：提问态（plan / ACP 问题）不再禁用组合器
  text = replaceOnce(
    text,
    '    Boolean(visibleDirectToolConfirmation.value) ||\n' +
      '    Boolean(visibleUserQuestion.value) ||\n' +
      '    acpApproval.hasPending.value,',
    '    Boolean(visibleDirectToolConfirmation.value) ||\n' +
      '    (acpApproval.hasPending.value && !acpApprovalQuestions.value),',
  );

  // 4) 给 <AiPromptInput> 加入参 + 提问事件
  text = replaceOnce(
    text,
    '@prewarm="handlePromptPrewarm" />',
    '@prewarm="handlePromptPrewarm"\n' +
      '          :user-questions="acpApprovalQuestions ?? visibleUserQuestion?.questions ?? null"\n' +
      '          @question-submit="handleComposerQuestionSubmit"\n' +
      '          @question-cancel="handleComposerQuestionCancel" />',
  );

  // 5) 删除两个外置 ai-question-surface 块（按结构搜索，避免依赖行号/缩进）
  const lines = text.split('\n');
  const startIdx = lines.findIndex(
    (l) => l.includes('v-if="acpApprovalQuestions"') && l.includes('ai-question-surface'),
  );
  const apiIdx = lines.findIndex((l) => /<AiPromptInput\b/.test(l));
  if (startIdx === -1 || apiIdx === -1 || startIdx >= apiIdx) {
    throw new Error('未能定位提问 surface 区块或 <AiPromptInput>，已中止。');
  }
  const removed = lines.slice(startIdx, apiIdx).join('\n');
  if (!removed.includes('visibleUserQuestion') || !removed.includes('QuestionPrompt')) {
    throw new Error('待删区块结构与预期不符，已中止（请把该区域发我）。');
  }
  lines.splice(startIdx, apiIdx - startIdx);
  text = lines.join('\n');

  await writeFile(PANEL, text.split('\n').join(eol), 'utf8');
  console.log('[8.mjs] ✅ AiAssistantPanel.vue 已接线（内嵌提问已接通 ACP / plan，外置块已删除）。');
}

await main();