import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkspaceBm25TokenizeOptions, tokenizeWorkspaceText } from './bm25-tokenizer.js';

test('🔴 tokenizeWorkspaceText splits CJK runs into overlapping bigrams', () => {
    assert.deepEqual(tokenizeWorkspaceText('工作区'), ['工作', '作区']);
});

test('🔴 tokenizeWorkspaceText emits bigrams so CJK substrings stay searchable', () => {
    const documentTokens = new Set(tokenizeWorkspaceText('后台预热索引'));
    for (const queryToken of tokenizeWorkspaceText('预热')) {
        assert.ok(documentTokens.has(queryToken), `期望文档命中查询子词 ${queryToken}`);
    }
});

test('🔴 tokenizeWorkspaceText keeps Latin identifiers intact and lowercased', () => {
    assert.deepEqual(tokenizeWorkspaceText('warmWorkspaceSearchIndex'), ['warmworkspacesearchindex']);
});

test('🟠 tokenizeWorkspaceText segments mixed CJK + Latin tokens', () => {
    assert.deepEqual(tokenizeWorkspaceText('工作区workspace'), ['工作', '作区', 'workspace']);
});

test('🟠 tokenizeWorkspaceText treats punctuation as separators', () => {
    assert.deepEqual(tokenizeWorkspaceText('foo.bar(baz)'), ['foo', 'bar', 'baz']);
});

test('🟠 tokenizeWorkspaceText drops English stopwords and sub-minimum tokens', () => {
    assert.deepEqual(tokenizeWorkspaceText('the a of x ok'), ['ok']);
});

test('🟡 tokenizeWorkspaceText keeps a lone CJK character as a unigram', () => {
    assert.deepEqual(tokenizeWorkspaceText('好 abc'), ['好', 'abc']);
});

test('🟡 tokenizeWorkspaceText handles supplementary-plane CJK via code points', () => {
    assert.deepEqual(tokenizeWorkspaceText('\u{20000}\u{20001}'), ['\u{20000}\u{20001}']);
});

test('🟡 tokenizeWorkspaceText returns an empty array for blank input', () => {
    assert.deepEqual(tokenizeWorkspaceText('   \n\t '), []);
});

test('🟠 createWorkspaceBm25TokenizeOptions wires in the CJK-aware tokenizer', () => {
    const options = createWorkspaceBm25TokenizeOptions();
    assert.equal(options.tokenizer, tokenizeWorkspaceText);
});
