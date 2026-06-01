import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BatchPartsProcessor, PIIDetector } from '@mastra/core/processors';
import { createMastraAgentOutputProcessors } from './workspace.js';

test('output processors stay streaming-safe (no whole-message buffering)', () => {
    const processors = createMastraAgentOutputProcessors();

    // 不得包含基于大模型的 PIIDetector：strategy:'redact' + lastMessageOnly 会把整段
    // 输出缓冲到流结束才放出，破坏 chat / agent 的逐 token 流式输出（“末尾一次性全弹”）。
    assert.ok(
        processors.every((processor) => !(processor instanceof PIIDetector)),
        'PIIDetector must not be used as an output processor; it blocks token streaming.',
    );

    // 仍保留不阻塞流的 BatchPartsProcessor（达到 batchSize 或 maxWaitTime 即 flush）。
    assert.ok(
        processors.some((processor) => processor instanceof BatchPartsProcessor),
        'A non-blocking BatchPartsProcessor should remain for light coalescing.',
    );
});
