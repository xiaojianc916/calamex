#!/usr/bin/env node
/**
 * fix-batch6-workspace-newlines.mjs — #55 补丁
 * 纯字符串匹配，避免正则转义问题。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = join(__dirname, 'agent-sidecar/src/engines/workspace/workspace.ts');

const original = readFileSync(filePath, 'utf-8');

// 找到函数声明的起始位置
const marker = 'export const normalizeCommandOutputNewlines';
const startIdx = original.indexOf(marker);
if (startIdx === -1) {
  console.error('ERROR: Could not find normalizeCommandOutputNewlines in workspace.ts');
  process.exit(1);
}

// 找到函数体结束位置：从 startIdx 开始往后找，匹配到第一个 ';' 或 '};'
// 先找箭头函数的单行结尾 ';'，再找多行 '};'
const afterMarker = original.slice(startIdx);

// 尝试匹配单行箭头函数: ... =>  value.replace(...).replace(...);
const arrowEnd = afterMarker.indexOf("';'") !== -1
  ? -1
  : afterMarker.indexOf('value.replace(');
  
let endIdx;

if (arrowEnd !== -1) {
  // 找到 value.replace(，往后找对应的结尾分号
  // 简单方案：从 value.replace( 开始往后找第一个出现 '\n' 后跟非空格非斜杠字符的位置
  // 更简单：找到第二个 .replace( 之后的第一个 ';' 或 '\n;'
  const secondReplace = afterMarker.indexOf('.replace(', arrowEnd + 10);
  if (secondReplace !== -1) {
    // 从第二个 .replace( 往后找闭合
    let depth = 1;
    let i = secondReplace + 9; // skip past ".replace("
    while (i < afterMarker.length && depth > 0) {
      if (afterMarker[i] === '(') depth++;
      else if (afterMarker[i] === ')') depth--;
      i++;
    }
    // i 现在指向 ')' 之后，找下一个 ';' 或 '\n'
    const afterParens = afterMarker.slice(i);
    const semiIdx = afterParens.indexOf(';');
    const newlineIdx = afterParens.indexOf('\n');
    if (semiIdx !== -1) {
      endIdx = startIdx + i + semiIdx + 1; // 包含分号
    } else {
      endIdx = startIdx + i + (newlineIdx !== -1 ? newlineIdx : afterParens.length);
    }
  } else {
    endIdx = -1;
  }
}

if (endIdx === -1 || endIdx === undefined) {
  // 尝试多行函数体 { ... };
  const braceStart = afterMarker.indexOf('{');
  if (braceStart !== -1) {
    let depth = 1;
    let i = braceStart + 1;
    while (i < afterMarker.length && depth > 0) {
      if (afterMarker[i] === '{') depth++;
      else if (afterMarker[i] === '}') depth--;
      i++;
    }
    // i 指向 '}' 之后，找 ';'
    const afterBrace = afterMarker.slice(i);
    const semiIdx = afterBrace.indexOf(';');
    endIdx = startIdx + i + (semiIdx !== -1 ? semiIdx + 1 : 0);
  } else {
    console.error('ERROR: Could not parse function body');
    process.exit(1);
  }
}

// 构建替换文本
const replacement = [
  'export const normalizeCommandOutputNewlines = (value: string): string => {',
  '    // Fast path: Linux/macOS stdout almost never contains \\r.',
  '    // Skip two O(n) replace passes when no \\r is present.',
  "    if (!value.includes('\\r')) {",
  '        return value;',
  '    }',
  "    return value.replace(/\\r\\n/gu, '\\n').replace(/\\r/gu, '\\n');",
  '};'
].join('\n');

const modified = original.slice(0, startIdx) + replacement + original.slice(endIdx);

if (original === modified) {
  console.log('No change needed.');
} else {
  writeFileSync(filePath, modified, 'utf-8');
  console.log('OK #55 workspace.ts: normalizeCommandOutputNewlines fast-path added');
}