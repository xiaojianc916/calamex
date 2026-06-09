import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  READ_FILE_MAX_FULL_LINES,
  buildLargeFileGuidance,
  buildReadFileResult,
  countLines,
} from './read-file.js';

test('countLines 不为尾随换行额外计一行', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\nb\n'), 2);
});

test('buildReadFileResult 小文件整篇带行号', () => {
  const result = buildReadFileResult({ path: 'a.ts', content: 'alpha\nbeta' });
  assert.equal(result.ok, true);
  assert.equal(result.content, '     1\talpha\n     2\tbeta');
  assert.equal(result.line_count, 2);
  assert.equal(result.start_line, 1);
  assert.equal(result.end_line, 2);
  assert.equal(result.truncated, false);
});

test('buildReadFileResult 空文件不报错且行号区间为空', () => {
  const result = buildReadFileResult({ path: 'empty.ts', content: '' });
  assert.equal(result.content, '');
  assert.equal(result.line_count, 0);
  assert.equal(result.start_line, null);
  assert.equal(result.end_line, null);
});

test('buildReadFileResult 区间从 start 编号并裁剪', () => {
  const content = 'L1\nL2\nL3\nL4\nL5';
  const result = buildReadFileResult({ path: 'a.ts', content, startLine: 2, endLine: 4 });
  assert.equal(result.content, '     2\tL2\n     3\tL3\n     4\tL4\n');
  assert.equal(result.start_line, 2);
  assert.equal(result.end_line, 4);
  assert.equal(result.line_count, 5);
});

test('buildReadFileResult 大文件改为引导而非整篇 dump', () => {
  const lines = Array.from(
    { length: READ_FILE_MAX_FULL_LINES + 5 },
    (_unused, index) => `line ${index + 1}`,
  );
  const result = buildReadFileResult({ path: 'big.ts', content: lines.join('\n') });
  assert.equal(result.start_line, null);
  assert.equal(result.end_line, null);
  assert.match(result.content, /Do NOT retry without a line range\./u);
  assert.ok(result.content.includes(String(READ_FILE_MAX_FULL_LINES + 5)));
});

test('buildReadFileResult 超出字符上限时截断并置位', () => {
  const result = buildReadFileResult({ path: 'a.ts', content: 'x'.repeat(50), maxOutputChars: 10 });
  assert.equal(result.truncated, true);
});

test('buildLargeFileGuidance 含路径、行数与区间提示', () => {
  const guidance = buildLargeFileGuidance('big.ts', 5000, 2000);
  assert.match(guidance, /big\.ts/u);
  assert.match(guidance, /5000/u);
  assert.match(guidance, /start_line/u);
});
