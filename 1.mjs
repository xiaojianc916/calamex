import { readFileSync, writeFileSync } from 'node:fs';

const base = 'src/components/ai-elements/code-block/';

// 通用：唯一替换，幂等
const fixOnce = (path, from, to) => {
  const s = readFileSync(path, 'utf8');
  if (s.includes(to) && !s.includes(from)) {
    console.log('[skip] 已正确: ' + path);
    return;
  }
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error('[' + path + '] 期望 1 处，实际 ' + n + ' 处: ' + from);
  writeFileSync(path, s.split(from).join(to), 'utf8');
  console.log('[ok] 已修复: ' + path);
};

// 1) utils.ts：把被误改名的“定义”改回（import 和函数体里的 highlightCodeSync 是对的，不能动）
fixOnce(base + 'utils.ts',
  'export const highlightCodeSync = (',
  'export const highlightCode = (');

// 2) index.ts：re-export 改回
fixOnce(base + 'index.ts',
  "export { highlightCodeSync } from './utils';",
  "export { highlightCode } from './utils';");

// 3) CodeBlockContent.vue：本文件里所有 highlightCodeSync 都是误改，全部改回
{
  const path = base + 'CodeBlockContent.vue';
  const s = readFileSync(path, 'utf8');
  const n = s.split('highlightCodeSync').length - 1;
  if (n === 0) {
    console.log('[skip] 已正确: ' + path);
  } else {
    writeFileSync(path, s.split('highlightCodeSync').join('highlightCode'), 'utf8');
    console.log('[ok] 已修复 ' + n + ' 处: ' + path);
  }
}

console.log('全部完成，可以直接 git commit 了。');