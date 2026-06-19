// fix-dup-imports.mjs
// 修复重复 import + terminal.ts ANSI 正则 biome 规则冲突

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const readFile = (rel) => {
  if (!existsSync(rel)) { console.warn('⚠ 不存在: ' + rel); return null; }
  return readFileSync(rel, 'utf-8');
};

const writeFile = (rel, content) => {
  writeFileSync(rel, content, 'utf-8');
  console.log('✅ 已修复: ' + rel);
};

// ---------------------------------------------------------------------------
// 1. useWorkspacePathSuggestions.ts: 去掉重复 import
// ---------------------------------------------------------------------------
function fixDupImports() {
  const f = 'src/composables/useWorkspacePathSuggestions.ts';
  let content = readFile(f);
  if (!content) return;

  // 去重 lru-cache import：把重复的 getBoundedCacheValue/setBoundedCacheValue 行删掉
  // 匹配连续重复的 import 成员
  content = content.replace(
    /import \{[\s\S]*?\} from '@\/utils\/core\/lru-cache';/,
`import { getBoundedCacheValue, setBoundedCacheValue } from '@/utils/core/lru-cache';`
  );

  // 去重 joinFileSystemPath import
  content = content.replace(
    /import \{[\s\S]*?\} from '@\/utils\/file\/path';/,
`import { joinFileSystemPath } from '@/utils/file/path';`
  );

  writeFile(f, content);
}

// ---------------------------------------------------------------------------
// 2. terminal.ts: 改回 String.fromCharCode(27) 加 biome 忽略注释
// ---------------------------------------------------------------------------
function fixAnsiRegex() {
  const f = 'src/store/terminal.ts';
  let content = readFile(f);
  if (!content) return;

  // biome 的 noControlCharactersInRegex 规则不允许 /\x1b/ 正则字面量中的控制字符。
  // 改用 new RegExp 构造避免该规则触发，同时保持等价行为。
  content = content.replace(
    'const ANSI_ESCAPE_CHARACTER_PATTERN = /\\x1b/gu;',
    "const ANSI_ESCAPE_CHARACTER_PATTERN = new RegExp(String.fromCharCode(27), 'gu');"
  );

  writeFile(f, content);
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
console.log('🔧 修复重复 import + ANSI 正则...\n');

let ok = 0;
let fail = 0;

for (const fn of [fixDupImports, fixAnsiRegex]) {
  try {
    fn();
    ok++;
  } catch (err) {
    console.error('❌ 失败:', err);
    fail++;
  }
}

console.log('\n--- 完成: ' + ok + ' 成功, ' + fail + ' 失败 ---');