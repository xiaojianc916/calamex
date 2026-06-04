import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMastraAgentOutputProcessors } from './workspace.js';
test('output processors stay streaming-safe (no buffering / no coalescing)', () => {
    const processors = createMastraAgentOutputProcessors();
    // 流式聊天 / Agent 的最终回答必须逐 token 实时下发，输出侧不得挂任何处理器：
    // 既不能用基于大模型的 PIIDetector（strategy:'redact' + lastMessageOnly 会整段缓冲、
    // “末尾一次性全弹”），也不能用 BatchPartsProcessor（成批合并 token，快速模型下会把内容
    // 堆到末尾再放出）。consumeTextStream 读取的是 output processor 之后的 fullStream，
    // 任何处理器都会截留 token。平滑节奏交由前端 markstream-vue 负责；输入侧脱敏由 Rust
    // 网关 collect_messages 中的 redact_text 完成，安全护栏不受影响。
    assert.equal(processors.length, 0, 'Output processors must be empty so the final answer streams token-by-token.');
});
