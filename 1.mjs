// 13.mjs —— 让 calamex 正确读取 Kimi AskUserQuestion 的真实问句（来自 toolCall.content），并清理临时日志
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/components/ai-elements/approval/from-acp-ask-user.ts';

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
    console.log(`→ 写回（${changed} 处）`);
  }
}

// 容错移除 11.mjs 的临时诊断日志（按 marker 定位整条 console 语句，带自校验）
function stripDiag(file) {
  const raw = readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');
  const marker = '[acp-askuser] toolCall=';
  const mIdx = text.indexOf(marker);
  if (mIdx === -1) {
    console.log('· diag: 未发现，跳过');
    return;
  }
  const startConsole = text.lastIndexOf('console', mIdx);
  const endParen = text.indexOf(');', mIdx);
  if (startConsole === -1 || endParen === -1) {
    console.log('· diag: 结构不符，跳过');
    return;
  }
  const lineStart = text.lastIndexOf('\n', startConsole) + 1;
  let cut = endParen + 2;
  if (text[cut] === '\n') cut += 1;
  const removed = text.slice(lineStart, cut);
  if (!/acp-askuser/.test(removed) || /=>|export|const resolve/.test(removed)) {
    console.log('· diag: 安全校验未通过，跳过（请手动检查）');
    return;
  }
  text = text.slice(0, lineStart) + text.slice(cut);
  writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  console.log('✓ diag: 已移除临时日志');
}

patch(FILE, [
  {
    name: 'drop-default-header-const',
    done: "const DEFAULT_QUESTION_TEXT = '请选择一个选项';\nconst MAX_HEADER_LENGTH = 16;",
    find: "const DEFAULT_QUESTION_TEXT = '请选择一个选项';\nconst DEFAULT_HEADER = '提问';\nconst MAX_HEADER_LENGTH = 16;",
    replace: "const DEFAULT_QUESTION_TEXT = '请选择一个选项';\nconst MAX_HEADER_LENGTH = 16;",
  },
  {
    name: 'add-content-text-reader',
    done: 'const readToolCallContentText =',
    find: `const readRawInput = (toolCall: unknown): TUnknownRecord | null => {
  const record = asRecord(toolCall);
  return record ? asRecord(record.rawInput) : null;
};`,
    replace: `const readRawInput = (toolCall: unknown): TUnknownRecord | null => {
  const record = asRecord(toolCall);
  return record ? asRecord(record.rawInput) : null;
};

/**
 * ACP \`ToolCallUpdate.content\`（[{ type:'content', content:{ type:'text', text } }]）中的首段文本。
 * Kimi Code（TS 版）经 acp-adapter/session.ts::handleQuestion 把真实问句放在这里，而非 rawInput；
 * title 则被硬编码为工具名「AskUserQuestion」。
 */
const readToolCallContentText = (toolCall: unknown): string | null => {
  const record = asRecord(toolCall);
  if (!record || !Array.isArray(record.content)) {
    return null;
  }
  for (const entry of record.content) {
    const entryRecord = asRecord(entry);
    if (!entryRecord || entryRecord.type !== 'content') {
      continue;
    }
    const inner = asRecord(entryRecord.content);
    const text = inner && inner.type === 'text' ? asNonEmptyString(inner.text) : null;
    if (text) {
      return text;
    }
  }
  return null;
};`,
  },
  {
    name: 'resolve-question-text',
    done: 'const fromContent = readToolCallContentText(toolCall);',
    find: `/** 问题文本：rawInput.questions[0].question → rawInput.question → toolCall.title → 兜底。 */
const resolveQuestionText = (request: IAcpPermissionRequest): string => {
  const toolCall = request.toolCall;
  const firstQuestion = readFirstRawQuestion(toolCall);
  const fromFirstQuestion = firstQuestion ? asNonEmptyString(firstQuestion.question) : null;
  const rawInput = readRawInput(toolCall);
  const fromRawInput = rawInput ? asNonEmptyString(rawInput.question) : null;
  const fromTitle = asNonEmptyString(asRecord(toolCall)?.title);
  return fromFirstQuestion ?? fromRawInput ?? fromTitle ?? DEFAULT_QUESTION_TEXT;
};`,
    replace: `/**
 * 问题文本优先级：toolCall.content 文本（Kimi 把真实问句放这）→ rawInput.questions[0].question
 * → rawInput.question → 兜底。不再回退 toolCall.title：Kimi 把它硬编码为工具名，并非问句。
 */
const resolveQuestionText = (request: IAcpPermissionRequest): string => {
  const toolCall = request.toolCall;
  const fromContent = readToolCallContentText(toolCall);
  const firstQuestion = readFirstRawQuestion(toolCall);
  const fromFirstQuestion = firstQuestion ? asNonEmptyString(firstQuestion.question) : null;
  const rawInput = readRawInput(toolCall);
  const fromRawInput = rawInput ? asNonEmptyString(rawInput.question) : null;
  return fromContent ?? fromFirstQuestion ?? fromRawInput ?? DEFAULT_QUESTION_TEXT;
};`,
  },
  {
    name: 'resolve-header',
    done: '// Kimi 仅透传 question、不发 header',
    find: `const resolveHeader = (request: IAcpPermissionRequest): string => {
  const firstQuestion = readFirstRawQuestion(request.toolCall);
  const header = firstQuestion ? asNonEmptyString(firstQuestion.header) : null;
  const value = header ?? DEFAULT_HEADER;
  return value.length > MAX_HEADER_LENGTH ? value.slice(0, MAX_HEADER_LENGTH) : value;
};`,
    replace: `const resolveHeader = (request: IAcpPermissionRequest): string => {
  const firstQuestion = readFirstRawQuestion(request.toolCall);
  const header = firstQuestion ? asNonEmptyString(firstQuestion.header) : null;
  // Kimi 仅透传 question、不发 header：返回空串，让 UI 以问题正文作标题（不再显示默认「提问」）。
  if (!header) {
    return '';
  }
  return header.length > MAX_HEADER_LENGTH ? header.slice(0, MAX_HEADER_LENGTH) : header;
};`,
  },
]);

stripDiag(FILE);
console.log('完成。');