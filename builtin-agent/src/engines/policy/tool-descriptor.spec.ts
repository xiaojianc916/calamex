import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    CALAMEX_CORE_TOOL_DESCRIPTORS,
    assertUniqueToolDescriptors,
    createMcpToolDescriptor,
    createMcpToolDescriptorName,
    filterToolDescriptorsForModel,
    groupToolDescriptorsBySource,
    resolveDescriptorApprovalDefault,
} from './tool-descriptor.js';

test('CALAMEX_CORE_TOOL_DESCRIPTORS：核心工具名唯一', () => {
    assert.doesNotThrow(() => assertUniqueToolDescriptors(CALAMEX_CORE_TOOL_DESCRIPTORS));
});

test('assertUniqueToolDescriptors：发现重复工具名', () => {
    assert.throws(() => assertUniqueToolDescriptors([
        {
            name: 'dup',
            source: 'internal',
            kind: 'other',
            mutatesState: false,
            requiresApprovalByDefault: false,
            supportsStreamingInput: false,
        },
        {
            name: 'dup',
            source: 'workspace',
            kind: 'read',
            mutatesState: false,
            requiresApprovalByDefault: false,
            supportsStreamingInput: false,
        },
    ]), /Duplicate agent tool descriptor/u);
});

test('createMcpToolDescriptor：MCP 工具使用独立命名空间', () => {
    assert.equal(createMcpToolDescriptorName('github', 'terminal'), 'mcp:github:terminal');
    assert.deepEqual(createMcpToolDescriptor('github', 'create_issue', true), {
        name: 'mcp:github:create_issue',
        source: 'mcp',
        kind: 'other',
        mutatesState: true,
        requiresApprovalByDefault: true,
        supportsStreamingInput: false,
        requiredCapability: 'tools',
    });
});

test('filterToolDescriptorsForModel：按模型能力过滤工具', () => {
    const withoutTools = filterToolDescriptorsForModel(CALAMEX_CORE_TOOL_DESCRIPTORS, {
        supportsTools: false,
        supportsNetworkTools: false,
    });
    assert.deepEqual(withoutTools, []);

    const withToolsNoNetwork = filterToolDescriptorsForModel(CALAMEX_CORE_TOOL_DESCRIPTORS, {
        supportsTools: true,
        supportsNetworkTools: false,
    });
    assert(withToolsNoNetwork.some((tool) => tool.name === 'workspace.read_file'));
    assert(!withToolsNoNetwork.some((tool) => tool.name === 'browser.navigate'));

    const withNetwork = filterToolDescriptorsForModel(CALAMEX_CORE_TOOL_DESCRIPTORS, {
        supportsTools: true,
        supportsNetworkTools: true,
    });
    assert(withNetwork.some((tool) => tool.name === 'browser.navigate'));
});

test('resolveDescriptorApprovalDefault：读工具默认 allow，写/执行工具默认 confirm', () => {
    const readFile = CALAMEX_CORE_TOOL_DESCRIPTORS.find((tool) => tool.name === 'workspace.read_file');
    const editFile = CALAMEX_CORE_TOOL_DESCRIPTORS.find((tool) => tool.name === 'workspace.edit_file');
    const execute = CALAMEX_CORE_TOOL_DESCRIPTORS.find((tool) => tool.name === 'workspace.execute_command');

    assert(readFile);
    assert(editFile);
    assert(execute);
    assert.equal(resolveDescriptorApprovalDefault(readFile), 'allow');
    assert.equal(resolveDescriptorApprovalDefault(editFile), 'confirm');
    assert.equal(resolveDescriptorApprovalDefault(execute), 'confirm');
});

test('groupToolDescriptorsBySource：按来源分组', () => {
    const grouped = groupToolDescriptorsBySource(CALAMEX_CORE_TOOL_DESCRIPTORS);
    assert(grouped.workspace.length > 0);
    assert(grouped.internal.length > 0);
    assert(grouped.mcp.length === 0);
});
