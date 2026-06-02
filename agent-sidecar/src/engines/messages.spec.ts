import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMastraMessages, hasImageAttachmentParts, isVisionModelId } from './messages.js';
import type { IAgentRuntimeInput } from './contracts/runtime-input.js';

const imageDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
const carrierLine = `AI_SDK_IMAGE_PART_JSON:${JSON.stringify({
    type: 'image',
    image: imageDataUrl,
    mediaType: 'image/png',
})}`;

const createInput = (overrides: Partial<IAgentRuntimeInput> = {}): IAgentRuntimeInput => ({
    mode: 'ask',
    goal: '分析附件',
    messages: [
        {
            role: 'user',
            content: '这张图有什么问题？',
        },
    ],
    ...overrides,
});

test('buildMastraMessages keeps legacy string content when there are no image attachments', () => {
    const messages = buildMastraMessages(createInput());

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, 'user');
    assert.equal(messages[0]?.content, '这张图有什么问题？');
});

test('buildMastraMessages maps image attachment carrier to AI SDK compatible image parts', () => {
    const messages = buildMastraMessages(createInput({
        context: [
            {
                id: 'image-1',
                kind: 'image-attachment',
                label: '图片附件 · screenshot.png',
                path: 'screenshot.png',
                range: null,
                contentPreview: [
                    '文件名：screenshot.png',
                    '类型：image/png',
                    carrierLine,
                ].join('\n'),
                redacted: false,
            },
        ],
    }));

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, 'user');
    assert.deepEqual(messages[0]?.content, [
        {
            type: 'text',
            text: '这张图有什么问题？',
        },
        {
            type: 'image',
            image: imageDataUrl,
            mediaType: 'image/png',
        },
    ]);
});

test('buildMastraMessages deduplicates repeated image attachment sources', () => {
    const messages = buildMastraMessages(createInput({
        context: [
            {
                id: 'image-1',
                kind: 'image-attachment',
                label: '图片附件 · a.png',
                path: 'a.png',
                range: null,
                contentPreview: carrierLine,
                redacted: false,
            },
            {
                id: 'image-2',
                kind: 'image-attachment',
                label: '图片附件 · b.png',
                path: 'b.png',
                range: null,
                contentPreview: carrierLine,
                redacted: false,
            },
        ],
    }));

    assert.ok(Array.isArray(messages[0]?.content));
    assert.equal(messages[0]?.content.length, 2);
});

test('hasImageAttachmentParts only returns true for valid image carriers', () => {
    assert.equal(hasImageAttachmentParts(undefined), false);
    assert.equal(hasImageAttachmentParts([
        {
            id: 'text-1',
            kind: 'search-result',
            label: '附件 · notes.txt',
            path: 'notes.txt',
            range: null,
            contentPreview: carrierLine,
            redacted: false,
        },
    ]), false);
    assert.equal(hasImageAttachmentParts([
        {
            id: 'image-1',
            kind: 'image-attachment',
            label: '图片附件 · screenshot.png',
            path: 'screenshot.png',
            range: null,
            contentPreview: carrierLine,
            redacted: false,
        },
    ]), true);
});

test('isVisionModelId is conservative for known non-vision and vision models', () => {
    assert.equal(isVisionModelId('deepseek/deepseek-v4-flash'), false);
    assert.equal(isVisionModelId('openai/gpt-4o'), true);
    assert.equal(isVisionModelId('google/gemini-3.1-pro'), true);
    assert.equal(isVisionModelId('anthropic/claude-4-sonnet'), true);
    assert.equal(isVisionModelId('alibaba/qwen2.5-vl-72b'), true);
});
