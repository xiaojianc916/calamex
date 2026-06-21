// scripts/codemods/floating-goto-two-fields.mjs
// 将已应用的单框「转到行」弹窗升级为「行 / 列」两个独立输入框。
// 用法:node scripts/codemods/floating-goto-two-fields.mjs [仓库根目录]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.argv[2] ?? '.';
const file = resolve(root, 'src/components/editor/CodeMirrorScriptEditor.vue');

let src = readFileSync(file, 'utf8');

if (!src.includes('createGotoLinePanel')) {
  throw new Error('未检测到转到行弹窗,请先运行 floating-goto-panel.mjs。');
}
if (src.includes('columnInput')) {
  console.log('⏭  已是行/列双框版,跳过(幂等)。');
  process.exit(0);
}

const replaceOnce = (haystack, find, replacement, label) => {
  const first = haystack.indexOf(find);
  if (first === -1) throw new Error(`锚点未找到:${label}`);
  if (haystack.indexOf(find, first + find.length) !== -1)
    throw new Error(`锚点不唯一:${label}`);
  return haystack.slice(0, first) + replacement + haystack.slice(first + find.length);
};

// 1) 单输入框 → 行框 + 分隔符 + 列框
src = replaceOnce(
  src,
  `  const input = document.createElement('input');
  input.className = 'cm-floating-search__input';
  input.type = 'text';
  input.placeholder = '行 或 行:列';
  input.setAttribute('aria-label', '转到行 / 列');
  input.spellcheck = false;`,
  `  const lineInput = document.createElement('input');
  lineInput.className = 'cm-floating-search__input cm-floating-search__input--num';
  lineInput.type = 'text';
  lineInput.inputMode = 'numeric';
  lineInput.placeholder = '行';
  lineInput.setAttribute('aria-label', '行号');
  lineInput.spellcheck = false;

  const separator = document.createElement('span');
  separator.className = 'cm-floating-search__sep';
  separator.setAttribute('aria-hidden', 'true');
  separator.textContent = ':';

  const columnInput = document.createElement('input');
  columnInput.className = 'cm-floating-search__input cm-floating-search__input--num';
  columnInput.type = 'text';
  columnInput.inputMode = 'numeric';
  columnInput.placeholder = '列';
  columnInput.setAttribute('aria-label', '列号(可选)');
  columnInput.spellcheck = false;`,
  'inputs',
);

// 2) append 顺序
src = replaceOnce(
  src,
  `  dom.append(grip, input, goButton, closeButton);`,
  `  dom.append(grip, lineInput, separator, columnInput, goButton, closeButton);`,
  'append',
);

// 3) 提交解析:分别取两个框
src = replaceOnce(
  src,
  `    const raw = input.value.trim();
    if (!raw) return;
    const [linePart, columnPart] = raw.split(/[:,]/);
    const line = Number.parseInt(linePart, 10);
    if (!Number.isFinite(line) || line <= 0) return;
    const column = columnPart ? Math.max(1, Number.parseInt(columnPart, 10) || 1) : 1;`,
  `    const lineRaw = lineInput.value.trim();
    if (!lineRaw) return;
    const line = Number.parseInt(lineRaw, 10);
    if (!Number.isFinite(line) || line <= 0) return;
    const columnRaw = columnInput.value.trim();
    const parsedColumn = Number.parseInt(columnRaw, 10);
    const column =
      columnRaw && Number.isFinite(parsedColumn) ? Math.max(1, parsedColumn) : 1;`,
  'submit-parse',
);

// 4) keydown:抽成共享 handler,两个框都绑
src = replaceOnce(
  src,
  `  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeGotoLinePanel(view);
      view.focus();
    }
  });
  goButton.addEventListener('click', submit);`,
  `  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeGotoLinePanel(view);
      view.focus();
    }
  };
  lineInput.addEventListener('keydown', onKeydown);
  columnInput.addEventListener('keydown', onKeydown);
  goButton.addEventListener('click', submit);`,
  'keydown',
);

// 5) mount 聚焦行框
src = replaceOnce(
  src,
  `      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });`,
  `      requestAnimationFrame(() => {
        lineInput.focus();
        lineInput.select();
      });`,
  'mount-focus',
);

// 6) 样式:宽度自适应 + 数字框 + 分隔符
src = replaceOnce(
  src,
  `.cm-floating-search--goto {
  width: 300px;
}`,
  `.cm-floating-search--goto {
  width: auto;
}
.cm-floating-search__input--num {
  width: 56px;
  flex: 0 0 auto;
  text-align: center;
}
.cm-floating-search__sep {
  color: #9aa0a6;
  font-size: 13px;
  line-height: 1;
  user-select: none;
}`,
  'css',
);

// 注释微调(非关键,缺失则忽略)
src = src.replace(
  '// 与查找弹窗同款:恒浅色、图标化、可拖拽、智能定位。',
  '// 与查找弹窗同款:恒浅色、图标化、可拖拽、智能定位。行、列分两个输入框。',
);

writeFileSync(file, src, 'utf8');
console.log('✓ 已升级为行/列双框版');