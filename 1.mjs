// 10.mjs —— 在仓库根目录运行: node 10.mjs  (修提问框页码插值)
import { readFile, writeFile } from 'node:fs/promises';

const FILE = 'src/components/business/ai/chat/AiPromptInput.vue';
const detectEol = (s) => (s.includes('\r\n') ? '\r\n' : '\n');

const raw = await readFile(FILE, 'utf8');
const eol = detectEol(raw);
let text = raw.split('\r\n').join('\n');

const OLD = '<span class="ai-question-pager-label"> questionIndex + 1  /  questionTotal </span>';
const NEW = '<span class="ai-question-pager-label"> questionIndex + 1  /  questionTotal </span>';

if (text.includes(NEW)) {
  console.log('[10.mjs] 页码插值已修复，跳过。');
} else {
  const i = text.indexOf(OLD);
  if (i === -1) throw new Error('未找到页码 span 锚点（可能已被改动）。');
  if (text.indexOf(OLD, i + 1) !== -1) throw new Error('页码 span 锚点不唯一，已中止。');
  text = text.slice(0, i) + NEW + text.slice(i + OLD.length);
  await writeFile(FILE, text.split('\n').join(eol), 'utf8');
  console.log('[10.mjs] ✅ 页码已修为  questionIndex + 1  /  questionTotal 。');
}