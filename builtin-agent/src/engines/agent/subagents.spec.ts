import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '@mastra/core/agent';

import {
    SUBAGENT_ID_PREFIX,
    buildCodingSubAgentDefinitions,
    buildCodingSubAgents,
    buildSupervisorDelegationInstructions,
    isSubAgentsEnabled,
    type TSubAgentSlug,
} from './subagents.js';

test('buildCodingSubAgentDefinitions：四个子 agent，slug / id / 描述齐备且唯一', () => {
    const definitions = buildCodingSubAgentDefinitions();
    assert.equal(definitions.length, 4);

    const expectedSlugs: TSubAgentSlug[] = ['planner', 'coder', 'reviewer', 'researcher'];
    assert.deepEqual(definitions.map((d) => d.slug), expectedSlugs);

    const ids = new Set(definitions.map((d) => d.id));
    assert.equal(ids.size, 4, 'id 必须唯一');

    for (const definition of definitions) {
        assert.ok(definition.id.startsWith(SUBAGENT_ID_PREFIX), `${definition.slug} id 前缀`);
        assert.ok(definition.name.trim().length > 0, `${definition.slug} name 非空`);
        // 描述是 supervisor 委派的选型依据，必须足够具体。
        assert.ok(definition.description.trim().length >= 10, `${definition.slug} description 充分`);
        assert.ok(definition.instructions.trim().length > 0, `${definition.slug} instructions 非空`);
    }

    // 仅规划 agent 为纯推理（不挂工具）。
    const planner = definitions.find((d) => d.slug === 'planner');
    assert.equal(planner?.needsTools, false);
});

test('buildSupervisorDelegationInstructions：涵盖四个子 agent 且含委派原则', () => {
    const instructions = buildSupervisorDelegationInstructions();
    for (const definition of buildCodingSubAgentDefinitions()) {
        assert.ok(
            instructions.includes(definition.name),
            `委派指令应包含 ${definition.name}`,
        );
        assert.ok(
            instructions.includes(definition.slug),
            `委派指令应包含 slug ${definition.slug}`,
        );
    }
    assert.ok(instructions.includes('委派'), '应包含委派原则');
});

test('buildCodingSubAgents：返回可作为父 Agent agents 字段的 Agent 记录', () => {
    const agents = buildCodingSubAgents({ model: 'openai/gpt-4o-mini' });

    assert.deepEqual(Object.keys(agents).sort(), ['coder', 'planner', 'researcher', 'reviewer']);
    for (const agent of Object.values(agents)) {
        assert.ok(agent instanceof Agent);
    }
});

test('isSubAgentsEnabled：默认关，仅 1 / true / on 开启', () => {
    assert.equal(isSubAgentsEnabled({}), false);
    assert.equal(isSubAgentsEnabled({ AGENT_SUBAGENTS: '0' }), false);
    assert.equal(isSubAgentsEnabled({ AGENT_SUBAGENTS: 'false' }), false);
    assert.equal(isSubAgentsEnabled({ AGENT_SUBAGENTS: '' }), false);

    assert.equal(isSubAgentsEnabled({ AGENT_SUBAGENTS: '1' }), true);
    assert.equal(isSubAgentsEnabled({ AGENT_SUBAGENTS: 'true' }), true);
    assert.equal(isSubAgentsEnabled({ AGENT_SUBAGENTS: 'ON' }), true);
});
