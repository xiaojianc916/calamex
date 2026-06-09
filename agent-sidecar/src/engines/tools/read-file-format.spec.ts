import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	formatNumberedFileSlice,
	formatWithLineNumbers,
	resolveLineRange,
	sliceInclusiveLineRange,
} from './read-file-format.js';

test('formatWithLineNumbers 为小文件加上 cat -n 行号（无尾随换行）', () => {
	assert.equal(
		formatWithLineNumbers('This is a small file content', 1),
		'     1\tThis is a small file content',
	);
});

test('formatWithLineNumbers 保留尾随换行且不额外编号空行', () => {
	assert.equal(formatWithLineNumbers('alpha\n', 1), '     1\talpha\n');
});

test('formatWithLineNumbers 多行从指定起始行号编号', () => {
	assert.equal(
		formatWithLineNumbers('Line 2\nLine 3\nLine 4\n', 2),
		'     2\tLine 2\n     3\tLine 3\n     4\tLine 4\n',
	);
});

test('formatWithLineNumbers 保留 CRLF 行终止符', () => {
	assert.equal(formatWithLineNumbers('a\r\nb', 1), '     1\ta\r\n     2\tb');
});

test('formatWithLineNumbers 对空字符串返回空字符串', () => {
	assert.equal(formatWithLineNumbers('', 1), '');
});

test('resolveLineRange 将起始行下限钳到 1', () => {
	assert.deepEqual(resolveLineRange(0, 2), { start: 1, end: 2 });
	assert.deepEqual(resolveLineRange(-5, 2), { start: 1, end: 2 });
});

test('resolveLineRange 在 end < start 时把 end 提升到 start', () => {
	assert.deepEqual(resolveLineRange(3, 2), { start: 3, end: 3 });
});

test('resolveLineRange 缺省时返回 [1, MAX]', () => {
	assert.deepEqual(resolveLineRange(), { start: 1, end: Number.MAX_SAFE_INTEGER });
});

const FIVE_LINES = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';

test('sliceInclusiveLineRange 返回 1 基闭区间', () => {
	const sliced = sliceInclusiveLineRange(FIVE_LINES, 2, 4);
	assert.equal(sliced.firstLineNumber, 2);
	assert.equal(sliced.text, 'Line 2\nLine 3\nLine 4\n');
});

test('sliceInclusiveLineRange 末行无换行时如实保留', () => {
	const sliced = sliceInclusiveLineRange(FIVE_LINES, 4, 99);
	assert.equal(sliced.text, 'Line 4\nLine 5');
});

test('sliceInclusiveLineRange 对 0 起始按第 1 行处理', () => {
	const sliced = sliceInclusiveLineRange(FIVE_LINES, 0, 2);
	assert.equal(sliced.firstLineNumber, 1);
	assert.equal(sliced.text, 'Line 1\nLine 2\n');
});

test('sliceInclusiveLineRange 对反转区间至少返回一行', () => {
	const sliced = sliceInclusiveLineRange(FIVE_LINES, 3, 2);
	assert.equal(sliced.firstLineNumber, 3);
	assert.equal(sliced.text, 'Line 3\n');
});

test('formatNumberedFileSlice 无区间时输出整篇并从第 1 行编号', () => {
	assert.equal(formatNumberedFileSlice('alpha\nbeta'), '     1\talpha\n     2\tbeta');
});

test('formatNumberedFileSlice 带区间时按 start 编号并裁剪', () => {
	assert.equal(
		formatNumberedFileSlice(FIVE_LINES, 2, 3),
		'     2\tLine 2\n     3\tLine 3\n',
	);
});
