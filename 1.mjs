#!/usr/bin/env node
/**
 * fix-batch6-workspace-newlines.mjs — #55 补丁（自动探测版）
 *
 * Batch 5 把 normalizeCommandOutputNewlines 从 workspace.ts 移到了
 * shared/normalize-newlines.ts 并导出为 normalizeNewlines。
 * 本脚本自动探测目标文件和函数名，添加 \r fast-path。
 *
 * 执行: node fix-batch6-workspace-newlines.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 候选文件列表（按优先级）
const candidates = [
  join(__dirname, 'agent-sidecar/src/engines/shared/normalize-newlines.ts'),
  join(__dirname, 'agent-sidecar/src/engines/workspace/workspace.ts'),
];

const target = candidates.find((p) => existsSync(p));

if (!target) {
  console.error('ERROR: None of the candidate files exist:');
  candidates.forEach((p) => console.error('  ' + p));
  process.exit(1);
}

console.log('Target file:', target);

const original = readFileSync(target, 'utf-8');

// 候选函数名（batch5 可能用了 normalizeNewlines 或保留原名）
const funcNames = ['normalizeNewlines', 'normalizeCommandOutputNewlines'];
const funcName = funcNames.find((name) => original.includes('export const ' + name));

if (!funcName) {
  console.error('ERROR: Could not find any of these function names:', funcNames.join(', '));
  console.error('File contents (first 2000 chars):');
  console.error(original.slice(0, 2000));
  process.exit(1);
}

console.log('Target function:', funcName);

// 找到函数声明的起始位置
const marker = 'export const ' + funcName;
const startIdx = original.indexOf(marker);
if (startIdx === -1) {
  console.error('ERROR: marker not found');
  process.exit(1);
}

// 从 marker 往后找函数体结束
// 策略：找到 '=>' 后的 'value.replace(' 开始，然后匹配括号到结尾
const afterMarker = original.slice(startIdx);

// 找 'value.replace(' 或类似的入口
let replaceIdx = afterMarker.indexOf('value.replace(');
if (replaceIdx === -1) {
  // 也可能写成 input.replace( 或 v.replace(
  replaceIdx = afterMarker.indexOf('.replace(');
}

if (replaceIdx !== -1) {
  // 箭头函数或单行函数体：找两个 .replace() 的完整调用
  // 从第一个 .replace( 开始匹配括号深度
  let depth = 1;
  let i = replaceIdx;
  // 回退到 '('
  while (i < afterMarker.length && afterMarker[i] !== '(') i++;
  i++; // skip '('
  
  let firstCallEnd = -1;
  while (i < afterMarker.length) {
    if (afterMarker[i] === '(') depth++;
    else if (afterMarker[i] === ')') {
      depth--;
      if (depth === 0) {
        firstCallEnd = i;
        break;
      }
    }
    i++;
  }
  
  if (firstCallEnd !== -1) {
    // 找第二个 .replace(
    const secondIdx = afterMarker.indexOf('.replace(', firstCallEnd + 1);
    if (secondIdx !== -1) {
      let j = secondIdx;
      while (j < afterMarker.length && afterMarker[j] !== '(') j++;
      j++; // skip '('
      depth = 1;
      while (j < afterMarker.length) {
        if (afterMarker[j] === '(') depth++;
        else if (afterMarker[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      // j 指向最后的 ')'
      j++; // move past ')'
      
      // 找结尾 ';' 或换行
      let endPos = j;
      // skip trailing whitespace
      while (endPos < afterMarker.length && (afterMarker[endPos] === ' ' || afterMarker[endPos] === '\t')) endPos++;
      if (endPos < afterMarker.length && afterMarker[endPos] === ';') endPos++;
      
      const endIdx = startIdx + endPos;
      
      const replacement = [
        'export const ' + funcName + ' = (value: string): string => {',
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
        console.log('No change needed (already patched?).');
      } else {
        writeFileSync(target, modified, 'utf-8');
        console.log('OK #55 ' + target.split('/').pop() + ': fast-path added to ' + funcName);
      }
    } else {
      console.error('ERROR: Could not find second .replace() call');
      process.exit(1);
    }
  } else {
    console.error('ERROR: Could not find end of first .replace() call');
    process.exit(1);
  }
} else {
  // 也许已经是多行函数体 { ... }
  const braceStart = afterMarker.indexOf('{');
  if (braceStart !== -1) {
    let depth = 1;
    let i = braceStart + 1;
    while (i < afterMarker.length && depth > 0) {
      if (afterMarker[i] === '{') depth++;
      else if (afterMarker[i] === '}') depth--;
      i++;
    }
    // i 指向 '}' 之后
    let endPos = i;
    if (endPos < afterMarker.length && afterMarker[endPos] === ';') endPos++;
    
    const endIdx = startIdx + endPos;
    
    // 检查是否已经包含 'includes' （已打过补丁）
    const existingBody = original.slice(startIdx, endIdx);
    if (existingBody.includes("includes('") || existingBody.includes('includes("')) {
      console.log('Already has fast-path. No change needed.');
      process.exit(0);
    }
    
    const replacement = [
      'export const ' + funcName + ' = (value: string): string => {',
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
      writeFileSync(target, modified, 'utf-8');
      console.log('OK #55 ' + target.split('/').pop() + ': fast-path added to ' + funcName);
    }
  } else {
    console.error('ERROR: Could not parse function body (no value.replace and no { found)');
    console.error('Context around marker:');
    console.error(afterMarker.slice(0, 500));
    process.exit(1);
  }
}