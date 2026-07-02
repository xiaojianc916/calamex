#!/usr/bin/env node
// 用官方 @shikijs/themes/github-light 的真值改写 tree-sitter 引擎调色板：
// 修正全部错误 hex；区分 用户实体(紫#6f42c1) / 内建(蓝#005cc5) / 标签(绿#22863a)；
// 普通变量/参数/操作符/标点保持默认色。保持 capture->cm-tsh-*->baseTheme 单一词表，零新依赖。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DRY = process.argv.includes('--dry');
const FILE = resolve(process.cwd(), 'src/services/editor/codemirror-tree-sitter-highlight.ts');

function replaceOnce(src, oldStr, newStr, label) {
  const i = src.indexOf(oldStr);
  if (i === -1) throw new Error('找不到锚点: ' + label);
  if (src.indexOf(oldStr, i + oldStr.length) !== -1) throw new Error('锚点不唯一: ' + label);
  return src.slice(0, i) + newStr + src.slice(i + oldStr.length);
}

const OLD_MAP = `const CAPTURE_CLASS: Readonly<Record<string, string>> = {
  comment: 'cm-tsh-comment',
  string: 'cm-tsh-string',
  character: 'cm-tsh-string',
  'string.escape': 'cm-tsh-escape',
  escape: 'cm-tsh-escape',
  number: 'cm-tsh-number',
  float: 'cm-tsh-number',
  boolean: 'cm-tsh-constant',
  constant: 'cm-tsh-constant',
  function: 'cm-tsh-function',
  method: 'cm-tsh-function',
  constructor: 'cm-tsh-function',
  keyword: 'cm-tsh-keyword',
  conditional: 'cm-tsh-keyword',
  repeat: 'cm-tsh-keyword',
  type: 'cm-tsh-type',
  namespace: 'cm-tsh-type',
  attribute: 'cm-tsh-attribute',
  tag: 'cm-tsh-tag',
  label: 'cm-tsh-label',
};`;

const NEW_MAP = `const CAPTURE_CLASS: Readonly<Record<string, string>> = {
  comment: 'cm-tsh-comment',
  string: 'cm-tsh-string',
  character: 'cm-tsh-string',
  'string.escape': 'cm-tsh-escape',
  escape: 'cm-tsh-escape',
  number: 'cm-tsh-number',
  float: 'cm-tsh-number',
  boolean: 'cm-tsh-constant',
  constant: 'cm-tsh-constant',
  'variable.builtin': 'cm-tsh-constant',
  function: 'cm-tsh-function',
  'function.builtin': 'cm-tsh-constant',
  method: 'cm-tsh-function',
  constructor: 'cm-tsh-function',
  keyword: 'cm-tsh-keyword',
  conditional: 'cm-tsh-keyword',
  repeat: 'cm-tsh-keyword',
  type: 'cm-tsh-type',
  'type.builtin': 'cm-tsh-constant',
  namespace: 'cm-tsh-type',
  attribute: 'cm-tsh-attribute',
  tag: 'cm-tsh-tag',
  label: 'cm-tsh-label',
};`;

const OLD_THEME = `const treeSitterHighlightTheme = EditorView.baseTheme({
  // 取值对齐 GitHub Light Default（primer）；仅对 github-light 实际着色的类别上色，
  // 普通变量/参数/操作符/标点保持默认前景色，注释不用斜体——与 Shiki 那条线视觉一致。
  '.cm-tsh-comment': { color: '#6e7781' },
  '.cm-tsh-string': { color: '#0a3069' },
  '.cm-tsh-escape': { color: '#0550ae' },
  '.cm-tsh-number': { color: '#0550ae' },
  '.cm-tsh-constant': { color: '#0550ae' },
  '.cm-tsh-function': { color: '#8250df' },
  '.cm-tsh-keyword': { color: '#cf222e' },
  '.cm-tsh-type': { color: '#953800' },
  '.cm-tsh-attribute': { color: '#0550ae' },
  '.cm-tsh-tag': { color: '#116329' },
  '.cm-tsh-label': { color: '#0550ae' },
});`;

const NEW_THEME = `const treeSitterHighlightTheme = EditorView.baseTheme({
  // 取值 100% 来自本地官方 @shikijs/themes/github-light（primer 经典版，默认前景 #24292e）。
  // 继承依据：entity / entity.name = #6f42c1（用户函数/类型/属性）；entity.name.tag = #22863a；
  // support / constant / variable.language = #005cc5（内建与常量）；storage/keyword = #d73a49；
  // 普通变量(variable.other)/参数(variable.parameter.function)/操作符/标点 = 默认色，不着色。
  '.cm-tsh-comment': { color: '#6a737d' },
  '.cm-tsh-string': { color: '#032f62' },
  '.cm-tsh-escape': { color: '#005cc5' },
  '.cm-tsh-number': { color: '#005cc5' },
  '.cm-tsh-constant': { color: '#005cc5' },
  '.cm-tsh-function': { color: '#6f42c1' },
  '.cm-tsh-keyword': { color: '#d73a49' },
  '.cm-tsh-type': { color: '#6f42c1' },
  '.cm-tsh-attribute': { color: '#6f42c1' },
  '.cm-tsh-tag': { color: '#22863a' },
  '.cm-tsh-label': { color: '#6f42c1' },
});`;

let src = readFileSync(FILE, 'utf8');
src = replaceOnce(src, OLD_MAP, NEW_MAP, 'CAPTURE_CLASS');
src = replaceOnce(src, OLD_THEME, NEW_THEME, 'baseTheme');

if (DRY) {
  console.log('两处锚点均命中且唯一，可安全替换：CAPTURE_CLASS、baseTheme。');
} else {
  writeFileSync(FILE, src, 'utf8');
  console.log('已用官方 github-light 真值改写调色板 →', FILE);
}