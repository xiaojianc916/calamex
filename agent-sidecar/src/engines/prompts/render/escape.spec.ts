import assert from 'node:assert/strict';
import test from 'node:test';

import { selectCodeFence, toSafeInlineLabel } from './escape.js';

test('selectCodeFence returns a triple-backtick fence for plain content', () => {
    assert.equal(selectCodeFence('hello world'), '```');
    assert.equal(selectCodeFence(''), '```');
});

test('selectCodeFence grows beyond the longest backtick run in untrusted content', () => {
    assert.equal(selectCodeFence('a ``` b'), '````');
    assert.equal(selectCodeFence('````x'), '`````');
    assert.equal(selectCodeFence('one ` two `` three'), '```');
});

test('toSafeInlineLabel collapses whitespace and neutralizes backticks', () => {
    assert.equal(toSafeInlineLabel('line1\nline2\t`code`'), "line1 line2 'code'");
    assert.equal(toSafeInlineLabel('  spaced   out  '), 'spaced out');
});
