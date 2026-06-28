import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createToolErrorCircuitBreaker, resolveToolFailureBucket } from './circuit-breaker.js';

type TStubTool = { execute: (...args: unknown[]) => unknown };

// circuit-breaker 仅要求 execute 为函数(见 isExecutableToolLike),此处用最小桩工具验证包装行为。
const wrapOne = (execute: (...args: unknown[]) => unknown): TStubTool => {
    const wrapped = createToolErrorCircuitBreaker({
        tool: { id: 'stub', description: 'stub', execute },
    } as never) as unknown as Record<string, TStubTool | undefined>;
    const target = wrapped.tool;
    if (!target) {
        throw new Error('circuit breaker 丢弃了工具');
    }
    return target;
};

test('🔴 透传 Mastra 注入的第 2 参 context(ask_user 工具级 suspend 依赖)', async () => {
    let receivedContext: unknown;
    const tool = wrapOne((_input, context) => {
        receivedContext = context;
        return 'ok';
    });
    const ctx = { agent: { suspend: () => undefined } };
    const result = await tool.execute({ questions: [] }, ctx);
    assert.equal(result, 'ok');
    assert.equal(receivedContext, ctx);
});

test('🟠 成功调用透传结果并复位连续失败计数', async () => {
    let calls = 0;
    const tool = wrapOne(() => {
        calls += 1;
        if (calls === 1) {
            throw new Error('boom');
        }
        return 'recovered';
    });
    await assert.rejects(async () => {
        await tool.execute({});
    }, /boom/);
    assert.equal(await tool.execute({}), 'recovered');
});

test('🟠 同类连续失败达阈值后触发熔断', async () => {
    const tool = wrapOne(() => {
        throw new Error('always fails');
    });
    await assert.rejects(async () => {
        await tool.execute({});
    }, /always fails/);
    await assert.rejects(async () => {
        await tool.execute({});
    }, /always fails/);
    await assert.rejects(async () => {
        await tool.execute({});
    }, /always fails/);
    await assert.rejects(async () => {
        await tool.execute({});
    }, /已停止继续尝试/);
});

test('🟡 resolveToolFailureBucket 细分 mcp 调用并对普通工具用工具名', () => {
    assert.equal(
        resolveToolFailureBucket('mcp_call_tool', { serverName: 'memory', toolName: 'search' }),
        'mcp_call_tool:memory:search',
    );
    assert.equal(resolveToolFailureBucket('mcp_list_tools', { serverName: 'memory' }), 'mcp_list_tools:memory');
    assert.equal(resolveToolFailureBucket('ask_user', { questions: [] }), 'ask_user');
});