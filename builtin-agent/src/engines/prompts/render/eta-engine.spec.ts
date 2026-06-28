import assert from 'node:assert/strict';
import test from 'node:test';

import { compilePromptTemplate } from './eta-engine.js';

test('compilePromptTemplate interpolates provided fields', () => {
    const template = compilePromptTemplate<{ name: string }>('Hi <%~ it.name %>');
    assert.equal(template.render({ name: 'Cal' }), 'Hi Cal');
});

test('compilePromptTemplate runs in strict mode and throws on missing fields', () => {
    const template = compilePromptTemplate<Record<string, never>>('Hi <%~ it.name %>');
    assert.throws(() => template.render({}));
});

test('compilePromptTemplate does not HTML-escape values', () => {
    const template = compilePromptTemplate<{ value: string }>('<%~ it.value %>');
    assert.equal(template.render({ value: '<a> & "b"' }), '<a> & "b"');
});
