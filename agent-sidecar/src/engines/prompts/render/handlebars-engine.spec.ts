import assert from 'node:assert/strict';
import test from 'node:test';

import { compilePromptTemplate } from './handlebars-engine.js';

test('compilePromptTemplate interpolates provided fields', () => {
    const template = compilePromptTemplate<{ name: string }>('Hi name');
    assert.equal(template.render({ name: 'Cal' }), 'Hi Cal');
});

test('compilePromptTemplate runs in strict mode and throws on missing fields', () => {
    const template = compilePromptTemplate<Record<string, never>>('Hi name');
    assert.throws(() => template.render({}));
});

test('compilePromptTemplate does not HTML-escape values', () => {
    const template = compilePromptTemplate<{ value: string }>('value');
    assert.equal(template.render({ value: '<a> & "b"' }), '<a> & "b"');
});
