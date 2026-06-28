import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeTerminalCommandSafety } from './command-safety.js';
import {
    createMcpToolPermissionName,
    decidePathToolPermission,
    decideSensitivePathToolPermission,
    decideToolPermission,
    findSensitiveToolPath,
    mostRestrictiveToolPermissionDecision,
    type IToolPermissionPolicy,
} from './tool-permission-policy.js';

const confirmByDefault: IToolPermissionPolicy = {
    defaultMode: 'confirm',
    tools: {},
};

test('analyzeTerminalCommandSafety：识别灾难性 rm 目标', () => {
    for (const command of [
        'rm -rf /',
        'rm -fr /*',
        'rm --recursive --force ~',
        'rm -rf $HOME',
        'rm -rf ${HOME}/foo/..',
        'rm -rf .',
        'rm -rf ..',
        "'rm' -rf '/'",
        'ls && rm -rf /',
        'echo $(rm -rf /)',
        'echo `rm -rf /`',
        'cat <(rm -rf /)',
    ]) {
        assert.equal(analyzeTerminalCommandSafety(command).status, 'unsafe', command);
    }
});

test('analyzeTerminalCommandSafety：允许具体目录删除但保留命令列表', () => {
    const result = analyzeTerminalCommandSafety('git status && rm -rf ./build');
    assert.equal(result.status, 'safe');
    assert.deepEqual(result.commands, ['git status', 'rm -rf ./build']);
});

test('analyzeTerminalCommandSafety：shell 插值进入 unsupported，供权限层 fail closed', () => {
    for (const command of ['echo $HOME', 'echo $(whoami)', 'echo `whoami`', 'cat <(ls)']) {
        assert.equal(analyzeTerminalCommandSafety(command).status, 'unsupported', command);
    }
});

test('decideToolPermission：hardcoded deny 优先级高于全局 allow', () => {
    const result = decideToolPermission({
        toolName: 'terminal',
        inputs: ['rm -rf /'],
        policy: { defaultMode: 'allow' },
    });
    assert.equal(result.kind, 'deny');
});

test('decideToolPermission：unsupported terminal 命令在非无条件 allow 下拒绝', () => {
    const result = decideToolPermission({
        toolName: 'terminal',
        inputs: ['echo $HOME'],
        policy: confirmByDefault,
    });
    assert.equal(result.kind, 'deny');
});

test('decideToolPermission：无条件 allow 可放行普通插值，但不能绕过 hardcoded deny', () => {
    assert.equal(decideToolPermission({
        toolName: 'terminal',
        inputs: ['echo $HOME'],
        policy: { defaultMode: 'allow' },
    }).kind, 'allow');

    assert.equal(decideToolPermission({
        toolName: 'terminal',
        inputs: ['echo $(rm -rf /)'],
        policy: { defaultMode: 'allow' },
    }).kind, 'deny');
});

test('decideToolPermission：deny > confirm > allow > default', () => {
    const policy: IToolPermissionPolicy = {
        defaultMode: 'confirm',
        tools: {
            terminal: {
                defaultMode: 'allow',
                alwaysAllow: [{ pattern: '^git\\b' }],
                alwaysConfirm: [{ pattern: '--force' }],
                alwaysDeny: [{ pattern: 'push\\s+origin\\s+main' }],
            },
        },
    };

    assert.equal(decideToolPermission({
        toolName: 'terminal',
        inputs: ['git status'],
        policy,
    }).kind, 'allow');

    assert.equal(decideToolPermission({
        toolName: 'terminal',
        inputs: ['git push --force'],
        policy,
    }).kind, 'confirm');

    assert.equal(decideToolPermission({
        toolName: 'terminal',
        inputs: ['git push origin main --force'],
        policy,
    }).kind, 'deny');
});

test('decideToolPermission：allow 必须覆盖链式命令中的每一条子命令', () => {
    const policy: IToolPermissionPolicy = {
        defaultMode: 'confirm',
        tools: {
            terminal: {
                alwaysAllow: [{ pattern: '^git\\b' }],
            },
        },
    };

    assert.equal(decideToolPermission({
        toolName: 'terminal',
        inputs: ['git status && git diff'],
        policy,
    }).kind, 'allow');

    assert.equal(decideToolPermission({
        toolName: 'terminal',
        inputs: ['git status && npm install'],
        policy,
    }).kind, 'confirm');
});

test('decidePathToolPermission：raw path 与 normalized path 取最严格结果', () => {
    const policy: IToolPermissionPolicy = {
        defaultMode: 'allow',
        tools: {
            edit_file: {
                alwaysConfirm: [{ pattern: '^\\.zed/' }],
            },
        },
    };

    const result = decidePathToolPermission({
        toolName: 'edit_file',
        inputs: ['safe/../.zed/settings.json'],
        policy,
    });
    assert.equal(result.kind, 'confirm');
});

test('findSensitiveToolPath：识别会改变 agent 行为或泄露 secret 的敏感路径', () => {
    assert.equal(findSensitiveToolPath('safe/../.mastracode/memory.db')?.kind, 'agent_memory');
    assert.equal(findSensitiveToolPath('.agents/foo/../skills/review/SKILL.md')?.kind, 'agent_skills');
    assert.equal(findSensitiveToolPath('./apps/api/.env.local')?.kind, 'environment');
    assert.equal(findSensitiveToolPath('src/../.zed/settings.json')?.kind, 'ide_settings');
    assert.equal(findSensitiveToolPath('src/main.ts'), null);
});

test('decideSensitivePathToolPermission：敏感路径即使基础策略 allow 也升级为 confirm', () => {
    const result = decideSensitivePathToolPermission({
        toolName: 'workspace.edit_file',
        inputs: ['packages/app/../.env.local'],
        policy: { defaultMode: 'allow' },
    });

    assert.equal(result.kind, 'confirm');
    assert.match(result.reason ?? '', /environment/u);
});

test('decideSensitivePathToolPermission：显式 deny 仍然优先于敏感路径 confirm', () => {
    const result = decideSensitivePathToolPermission({
        toolName: 'workspace.edit_file',
        inputs: ['.env.local'],
        policy: {
            defaultMode: 'allow',
            tools: {
                'workspace.edit_file': {
                    alwaysDeny: [{ pattern: '^\\.env' }],
                },
            },
        },
    });

    assert.equal(result.kind, 'deny');
});

test('createMcpToolPermissionName：MCP 工具命名空间不与内置工具碰撞', () => {
    assert.equal(createMcpToolPermissionName('github', 'terminal'), 'mcp:github:terminal');
});

test('mostRestrictiveToolPermissionDecision：deny > confirm > allow', () => {
    assert.deepEqual(
        mostRestrictiveToolPermissionDecision({ kind: 'allow' }, { kind: 'confirm' }),
        { kind: 'confirm' },
    );
    assert.deepEqual(
        mostRestrictiveToolPermissionDecision({ kind: 'confirm' }, { kind: 'deny' }),
        { kind: 'deny' },
    );
});
