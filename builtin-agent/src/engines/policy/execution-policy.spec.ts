import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    DEFAULT_AGENT_EXECUTION_MAX_STEPS,
    MAX_AGENT_EXECUTION_MAX_STEPS,
    MIN_AGENT_EXECUTION_MAX_STEPS,
    resolveAgentExecutionMaxSteps,
    resolveAgentExecutionPolicy,
} from './execution-policy.js';

test('resolveAgentExecutionMaxSteps：默认使用保守工具步数', () => {
    assert.equal(resolveAgentExecutionMaxSteps({}), DEFAULT_AGENT_EXECUTION_MAX_STEPS);
});

test('resolveAgentExecutionMaxSteps：允许环境变量覆盖', () => {
    assert.equal(resolveAgentExecutionMaxSteps({ AGENT_EXECUTION_MAX_STEPS: '16' }), 16);
});

test('resolveAgentExecutionMaxSteps：非法值回退默认值', () => {
    for (const value of ['abc', 'NaN', 'Infinity', '']) {
        assert.equal(
            resolveAgentExecutionMaxSteps({ AGENT_EXECUTION_MAX_STEPS: value }),
            DEFAULT_AGENT_EXECUTION_MAX_STEPS,
            value,
        );
    }
});

test('resolveAgentExecutionMaxSteps：覆盖值被限制在安全上下限内', () => {
    assert.equal(
        resolveAgentExecutionMaxSteps({ AGENT_EXECUTION_MAX_STEPS: '-1' }),
        MIN_AGENT_EXECUTION_MAX_STEPS,
    );
    assert.equal(
        resolveAgentExecutionMaxSteps({ AGENT_EXECUTION_MAX_STEPS: '999' }),
        MAX_AGENT_EXECUTION_MAX_STEPS,
    );
});

test('resolveAgentExecutionPolicy：集中返回执行策略', () => {
    assert.deepEqual(
        resolveAgentExecutionPolicy({ AGENT_EXECUTION_MAX_STEPS: '7' }),
        { maxSteps: 7 },
    );
});
