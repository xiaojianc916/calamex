#!/usr/bin/env node
/**
 * fix-search-replacement-abort-guard.mjs
 *
 * 只修上一个脚本失败的部分：
 * src/components/workbench/sidebar/search/useWorkspaceReplacement.ts
 *
 * 修复点：
 * - previewReplacementToSearch 成功路径补 abort guard。
 * - refreshReplacementPreviewAfterLineApply 成功路径补 abort guard。
 *
 * 特点：
 * - 不依赖完整格式化片段。
 * - 已经加过则跳过。
 * - 不生成备份文件。
 *
 * 用法：
 *   node fix-search-replacement-abort-guard.mjs
 *   node fix-search-replacement-abort-guard.mjs --apply
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const apply = process.argv.includes('--apply');
const file = 'src/components/workbench/sidebar/search/useWorkspaceReplacement.ts';
const path = join(root, file);

const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

if (!existsSync(path)) {
  fail(`缺少文件：${file}`);
}

let content = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const findMatchingBrace = (text, openBraceIndex) => {
  let depth = 0;
  for (let index = openBraceIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const findFunctionRange = (name) => {
  const start = content.indexOf(`const ${name} = async`);
  if (start === -1) {
    fail(`找不到函数：${name}`);
  }

  const openBrace = content.indexOf('{', start);
  if (openBrace === -1) {
    fail(`函数 ${name} 找不到函数体开始花括号`);
  }

  const closeBrace = findMatchingBrace(content, openBrace);
  if (closeBrace === -1) {
    fail(`函数 ${name} 找不到函数体结束花括号`);
  }

  return { start, openBrace, closeBrace };
};

const patchFirstSuccessGuardAfterPreviewCall = (functionName, expectedReturn, label) => {
  const range = findFunctionRange(functionName);
  const fnText = content.slice(range.start, range.closeBrace + 1);

  const previewCall = 'const preview = await tauriService.previewWorkspaceReplacement';
  const previewCallIndex = fnText.indexOf(previewCall);
  if (previewCallIndex === -1) {
    fail(`${label}：找不到 previewWorkspaceReplacement 调用`);
  }

  const guardStart = fnText.indexOf('if (', previewCallIndex + previewCall.length);
  if (guardStart === -1) {
    fail(`${label}：preview 调用后找不到成功路径 if guard`);
  }

  const returnIndex = fnText.indexOf(expectedReturn, guardStart);
  if (returnIndex === -1) {
    fail(`${label}：成功路径 guard 后找不到 ${expectedReturn.trim()}`);
  }

  const guardText = fnText.slice(guardStart, returnIndex + expectedReturn.length);

  if (guardText.includes('abortController.signal.aborted')) {
    console.log(`• 已存在，跳过：${label}`);
    return;
  }

  const patchedGuardText = guardText.replace(
    'if (',
    `if (
        abortController.signal.aborted ||`,
  );

  if (patchedGuardText === guardText) {
    fail(`${label}：插入 abort guard 失败`);
  }

  const absoluteGuardStart = range.start + guardStart;
  const absoluteGuardEnd = range.start + returnIndex + expectedReturn.length;

  content =
    content.slice(0, absoluteGuardStart) +
    patchedGuardText +
    content.slice(absoluteGuardEnd);

  console.log(`✓ 已补 abort guard：${label}`);
};

patchFirstSuccessGuardAfterPreviewCall(
  'previewReplacementToSearch',
  'return false;',
  '替换预览成功路径',
);

patchFirstSuccessGuardAfterPreviewCall(
  'refreshReplacementPreviewAfterLineApply',
  'return;',
  '行替换后刷新预览成功路径',
);

if (apply) {
  writeFileSync(path, content, 'utf8');
  console.log(`\n已修改：${file}`);
  console.log('\n继续执行：');
  console.log('  pnpm typecheck');
  console.log('  pnpm test');
} else {
  console.log('\n模式：dry-run，只检查匹配，不写入');
  console.log('\n确认无误后执行：');
  console.log('  node fix-search-replacement-abort-guard.mjs --apply');
}