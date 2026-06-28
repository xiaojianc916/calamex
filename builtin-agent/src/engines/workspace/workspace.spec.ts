import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_MASTRA_INPUT_TOKEN_LIMIT,
    createMastraAgentInputProcessors,
    createMastraAgentOutputProcessors,
    createWorkspaceSensitivePathApprovalGate,
    extractWorkspaceToolPathInput,
    resolveMastraInputTokenLimit,
} from './workspace.js';

test('input processors use Mastra official TokenLimiterProcessor for context trimming', () => {
    const processors = createMastraAgentInputProcessors({ env: {} });
    const processorIds = processors.map((processor) => processor.id);

    assert.deepEqual(processorIds, ['unicode-normalizer', 'token-limiter']);

    const tokenLimiter = processors.find((processor) => processor.id === 'token-limiter');
    assert.ok(tokenLimiter);
    assert.equal(
        (tokenLimiter as unknown as { getMaxTokens: () => number }).getMaxTokens(),
        DEFAULT_MASTRA_INPUT_TOKEN_LIMIT,
    );
});

test('resolveMastraInputTokenLimit supports env override and disable switch', () => {
    assert.equal(
        resolveMastraInputTokenLimit({ BUILTIN_AGENT_INPUT_TOKEN_LIMIT: '12000' }),
        12_000,
    );
    assert.equal(
        resolveMastraInputTokenLimit({ BUILTIN_AGENT_INPUT_TOKEN_LIMIT: 'false' }),
        null,
    );
});

test('output processors stay streaming-safe (no buffering / no coalescing)', () => {
    const processors = createMastraAgentOutputProcessors();

    // 流式聊天 / Agent 的最终回答必须逐 token 实时下发，输出侧不得挂任何处理器：
    // 既不能用基于大模型的 PIIDetector（strategy:'redact' + lastMessageOnly 会整段缓冲、
    // “末尾一次性全弹”），也不能用 BatchPartsProcessor（成批合并 token，快速模型下会把内容
    // 堆到末尾再放出）。consumeTextStream 读取的是 output processor 之后的 fullStream，
    // 任何处理器都会截留 token。平滑节奏交由前端 markstream-vue 负责；输入侧脱敏由 Rust
    // 网关 collect_messages 中的 redact_text 完成，安全护栏不受影响。
    assert.equal(
        processors.length,
        0,
        'Output processors must be empty so the final answer streams token-by-token.',
    );
});

test('extractWorkspaceToolPathInput reads Mastra workspace path args defensively', () => {
    assert.equal(extractWorkspaceToolPathInput({ path: 'src/main.ts' }), 'src/main.ts');
    assert.equal(extractWorkspaceToolPathInput({ path: '' }), null);
    assert.equal(extractWorkspaceToolPathInput({ content: 'hello' }), null);
    assert.equal(extractWorkspaceToolPathInput(null), null);
});

test('workspace sensitive-path approval gate composes Mastra dynamic approval with Calamex policy', () => {
    const gate = createWorkspaceSensitivePathApprovalGate('workspace.edit_file', false);

    assert.equal(gate({ args: { path: 'src/main.ts' } }), false);
    assert.equal(gate({ args: { path: 'safe/../.env.local' } }), true);
    assert.equal(gate({ args: { path: '.agents/foo/../skills/review/SKILL.md' } }), true);
    assert.equal(gate({ args: { path: 'src/../.zed/settings.json' } }), true);
});

test('workspace sensitive-path approval gate preserves default approval posture', () => {
    const gate = createWorkspaceSensitivePathApprovalGate('workspace.write_file', true);

    assert.equal(gate({ args: { path: 'src/main.ts' } }), true);
    assert.equal(gate({ args: { path: '.env.local' } }), true);
});
