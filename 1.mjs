#!/usr/bin/env node
// 修正 tree-sitter 引擎的 github-light 调色板：不再给普通变量/参数/操作符/标点上色、
// 注释去斜体。保持 capture->cm-tsh-*->baseTheme 的 tree-sitter 原生单一词表，零新依赖。
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
  variable: 'cm-tsh-variable',
  'variable.parameter': 'cm-tsh-parameter',
  parameter: 'cm-tsh-parameter',
  property: 'cm-tsh-property',
  field: 'cm-tsh-property',
  function: 'cm-tsh-function',
  method: 'cm-tsh-function',
  constructor: 'cm-tsh-function',
  keyword: 'cm-tsh-keyword',
  conditional: 'cm-tsh-keyword',
  repeat: 'cm-tsh-keyword',
  operator: 'cm-tsh-operator',
  type: 'cm-tsh-type',
  namespace: 'cm-tsh-type',
  attribute: 'cm-tsh-attribute',
  tag: 'cm-tsh-tag',
  label: 'cm-tsh-label',
  punctuation: 'cm-tsh-punctuation',
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

const OLD_THEME = `const treeSitterHighlightTheme = EditorView.baseTheme({
  '.cm-tsh-comment': { color: '#6e7781', fontStyle: 'italic' },
  '.cm-tsh-string': { color: '#0a3069' },
  '.cm-tsh-escape': { color: '#0a3069', fontWeight: '600' },
  '.cm-tsh-number': { color: '#0550ae' },
  '.cm-tsh-constant': { color: '#0550ae' },
  '.cm-tsh-variable': { color: '#953800' },
  '.cm-tsh-parameter': { color: '#953800' },
  '.cm-tsh-property': { color: '#0550ae' },
  '.cm-tsh-function': { color: '#8250df' },
  '.cm-tsh-keyword': { color: '#cf222e' },
  '.cm-tsh-operator': { color: '#0550ae' },
  '.cm-tsh-type': { color: '#953800' },
  '.cm-tsh-attribute': { color: '#0550ae' },
  '.cm-tsh-tag': { color: '#116329' },
  '.cm-tsh-label': { color: '#0550ae' },
  '.cm-tsh-punctuation': { color: '#24292f' },
});`;

const NEW_THEME = `const treeSitterHighlightTheme = EditorView.baseTheme({
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

let src = readFileSync(FILE, 'utf8');
src = replaceOnce(src, OLD_MAP, NEW_MAP, 'CAPTURE_CLASS');
src = replaceOnce(src, OLD_THEME, NEW_THEME, 'baseTheme');

if (DRY) {
  console.log('锚点全部命中且唯一：CAPTURE_CLASS、baseTheme 均可安全替换。');
} else {
  writeFileSync(FILE, src, 'utf8');
  console.log('已更新调色板：删去变量/参数/操作符/标点上色，注释去斜体 →', FILE);
}