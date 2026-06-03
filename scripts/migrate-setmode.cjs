#!/usr/bin/env node
/**
 * ④ 收敛 mode 写入: 在 aiAgent store 新增 setMode(nextMode) action,
 * 并把分散在 useAiAssistant / useAiAgentPlan / useAiAgentRun 里的
 * store.mode = ... / Reflect.set(store,'mode',...) 全部改走 store.setMode(...)。
 *
 * 内部 failPlanning 的 mode.value = 'plan' 保留(那是 store 内部实现)。
 *
 * 安全策略: 逐文件按预期出现次数校验(fail-loud);
 *           全部文件先验证通过才写入(不会改一半);
 *           幂等(文件含 marker 则跳过)。
 *
 * 用法(仓库根目录): node migrate-setmode.cjs
 */
'use strict';

const path = require('path');

// 按子串精确替换, 并校验出现次数。任一不符立即抛错。
function applyEdits(content, edits) {
    let out = content;
    for (const e of edits) {
        const count = out.split(e.find).length - 1;
        if (count !== e.count) {
            throw new Error(`${e.label}: 期望 ${e.count} 处, 实际 ${count}`);
        }
        out = out.split(e.find).join(e.replace);
    }
    return out;
}

// 单个文件的迁移计划: 含 marker 则视为已迁移。
function planForContent(content, plan) {
    if (content.includes(plan.marker)) {
        return { skipped: true, content };
    }
    return { skipped: false, content: applyEdits(content, plan.edits) };
}

const FILE_PLANS = [
    {
        path: path.join('src', 'store', 'aiAgent.ts'),
        marker: 'const setMode = (nextMode: TAiAgentPanelMode): void => {',
        edits: [
            {
                label: 'aiAgent: 定义 setMode',
                count: 1,
                find:
                    '    const setNetworkPermission = (permission: TAiAgentNetworkPermission): void => {\n' +
                    '      networkPermission.value = permission;\n' +
                    '    };',
                replace:
                    '    const setNetworkPermission = (permission: TAiAgentNetworkPermission): void => {\n' +
                    '      networkPermission.value = permission;\n' +
                    '    };\n\n' +
                    '    const setMode = (nextMode: TAiAgentPanelMode): void => {\n' +
                    '      mode.value = nextMode;\n' +
                    '    };',
            },
            {
                label: 'aiAgent: 导出 setMode',
                count: 1,
                find: '      // actions\n      setNetworkPermission,',
                replace: '      // actions\n      setNetworkPermission,\n      setMode,',
            },
        ],
    },
    {
        path: path.join('src', 'composables', 'ai', 'useAiAssistant.ts'),
        marker: 'agentStore.setMode(nextMode);',
        edits: [
            {
                label: 'useAiAssistant: activeMode setter',
                count: 1,
                find: '      agentStore.mode = nextMode;',
                replace: '      agentStore.setMode(nextMode);',
            },
        ],
    },
    {
        path: path.join('src', 'composables', 'ai', 'useAiAgentPlan.ts'),
        marker: "store.setMode('plan');",
        edits: [
            {
                label: "useAiAgentPlan: store.mode = 'plan'",
                count: 3,
                find: "store.mode = 'plan';",
                replace: "store.setMode('plan');",
            },
            {
                label: "useAiAgentPlan: store.mode = 'agent'",
                count: 1,
                find: "store.mode = 'agent';",
                replace: "store.setMode('agent');",
            },
        ],
    },
    {
        path: path.join('src', 'composables', 'ai', 'useAiAgentRun.ts'),
        marker: 'store.setMode(nextMode);',
        edits: [
            {
                label: 'useAiAgentRun: setMode 走 store',
                count: 1,
                find: "Reflect.set(store, 'mode', nextMode);",
                replace: 'store.setMode(nextMode);',
            },
            {
                label: "useAiAgentRun: applyReplanned store.mode = 'plan'",
                count: 1,
                find: "store.mode = 'plan';",
                replace: "store.setMode('plan');",
            },
        ],
    },
];

module.exports = { applyEdits, planForContent, FILE_PLANS };

if (require.main === module) {
    const fs = require('fs');
    const fail = (msg) => {
        console.error('✗ ' + msg);
        console.error('  未做任何改动, 所有文件保持原样。');
        process.exit(1);
    };

    // 第一轮: 全部读取 + 验证(不写入)
    const results = [];
    for (const plan of FILE_PLANS) {
        if (!fs.existsSync(plan.path)) {
            fail('找不到文件: ' + plan.path + ' (请在仓库根目录运行)');
        }
        const original = fs.readFileSync(plan.path, 'utf8');
        try {
            const r = planForContent(original, plan);
            results.push({ plan, original, ...r });
        } catch (e) {
            fail(e.message);
        }
    }

    const changed = results.filter((r) => !r.skipped);
    if (changed.length === 0) {
        console.log('✓ 已迁移过(检测到 setMode 收敛), 无需改动。');
        process.exit(0);
    }

    // 第二轮: 全部验证通过后才写入
    for (const r of changed) {
        fs.writeFileSync(r.plan.path, r.content, 'utf8');
        console.log('✓ ' + r.plan.path);
    }
    const skipped = results.filter((r) => r.skipped);
    for (const r of skipped) {
        console.log('- 跳过(已迁移): ' + r.plan.path);
    }
    console.log(
        '\n下一步: pnpm typecheck && pnpm test src/composables/ai/useAiAssistant.spec.ts',
    );
}