import assert from 'node:assert/strict';
import test from 'node:test';

import type {
    IAgentContextReferenceInput,
    IAgentRuntimeInput,
} from '../../contracts/runtime-input.js';
import { assembleSystemPromptContext } from './system-prompt-context.js';

const buildInput = (overrides: Partial<IAgentRuntimeInput> = {}): IAgentRuntimeInput => ({
    mode: 'agent',
    goal: '',
    messages: [],
    ...overrides,
});

const buildReference = (
    overrides: Partial<IAgentContextReferenceInput> = {},
): IAgentContextReferenceInput => ({
    id: 'ref-1',
    kind: 'file',
    label: 'example.ts',
    path: 'src/example.ts',
    range: null,
    contentPreview: 'const x = 1;',
    redacted: false,
    ...overrides,
});

test('infers the provider label from the model id', () => {
    assert.equal(assembleSystemPromptContext(buildInput(), 'claude-3-5-sonnet').providerLabel, 'Anthropic');
    assert.equal(assembleSystemPromptContext(buildInput(), 'gpt-4o').providerLabel, 'OpenAI');
    assert.equal(assembleSystemPromptContext(buildInput(), 'deepseek-chat').providerLabel, 'DeepSeek');
    assert.equal(assembleSystemPromptContext(buildInput(), 'qwen-max').providerLabel, '通义千问');
    assert.equal(assembleSystemPromptContext(buildInput(), 'gemini-1.5-pro').providerLabel, 'Google');
    assert.equal(assembleSystemPromptContext(buildInput(), 'llama-3').providerLabel, '当前配置的 AI 服务平台');
});

test('falls back to the unspecified model label when the model id is blank', () => {
    assert.equal(assembleSystemPromptContext(buildInput(), '   ').modelLabel, '未指定');
});

test('filters current-file references out of the context block', () => {
    const context = assembleSystemPromptContext(buildInput({
        context: [buildReference({ kind: 'current-file' })],
    }));
    assert.equal(context.hasContext, false);
    assert.equal(context.contextReferences.length, 0);
});

test('renders skill references as skill_read instructions', () => {
    const context = assembleSystemPromptContext(buildInput({
        context: [buildReference({ kind: 'skill', label: 'My Skill', path: 'my-skill' })],
    }));
    const [view] = context.contextReferences;
    assert.ok(view);
    assert.equal(view.isSkill, true);
    assert.equal(view.skillSlug, 'my-skill');
});

test('truncates long file previews and selects an injection-safe fence', () => {
    const context = assembleSystemPromptContext(buildInput({
        context: [buildReference({ contentPreview: '```js\n'.concat('a'.repeat(2_000)) })],
    }));
    const [view] = context.contextReferences;
    assert.ok(view);
    assert.equal(view.truncated, true);
    assert.ok(view.fence.length >= 4);
});

test('extracts trimmed system messages and goal', () => {
    const context = assembleSystemPromptContext(buildInput({
        goal: '  做点事  ',
        messages: [
            { role: 'system', content: '  额外规则  ' },
            { role: 'user', content: 'hi' },
        ],
    }));
    assert.equal(context.goal, '做点事');
    assert.equal(context.hasGoal, true);
    assert.deepEqual(context.extraSystemMessages, ['额外规则']);
});

test('marks workspace availability from the workspace root path', () => {
    assert.equal(assembleSystemPromptContext(buildInput()).hasWorkspace, false);
    assert.equal(
        assembleSystemPromptContext(buildInput({ workspaceRootPath: 'D:/proj' })).hasWorkspace,
        true,
    );
});
