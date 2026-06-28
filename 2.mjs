// rename-eta-engine.mjs
// 把 handlebars-engine.* 彻底改名为 eta-engine.*，并清掉注释里残留的 "Handlebars" 字样。
// 先决条件：git pull origin main（本地须为已迁移到 eta 的版本），且工作区干净。
// 用法：在仓库根目录运行  node rename-eta-engine.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASE = 'builtin-agent/src/engines/prompts';
const RENDER = `${BASE}/render`;

const OLD_ENGINE = `${RENDER}/handlebars-engine.ts`;
const NEW_ENGINE = `${RENDER}/eta-engine.ts`;
const OLD_SPEC = `${RENDER}/handlebars-engine.spec.ts`;
const NEW_SPEC = `${RENDER}/eta-engine.spec.ts`;
const TEMPLATE = `${BASE}/templates/system-prompt.template.ts`;
const SYS_PROMPT = `${BASE}/system-prompt.ts`;
const CONTEXT = `${BASE}/domain/system-prompt-context.ts`;

const git = (cmd) => execSync(`git ${cmd}`, { stdio: 'pipe' }).toString().trim();

// 替换且校验：找不到目标就报错（多半是没 pull，本地还不是 eta 版本）。
const must = (content, find, repl, file) => {
    if (!content.includes(find)) {
        throw new Error(`× 在 ${file} 找不到待替换片段，请先 git pull origin main：\n   ${find}`);
    }
    return content.split(find).join(repl);
};

const edit = (file, edits) => {
    let content = readFileSync(file, 'utf8');
    for (const [find, repl] of edits) content = must(content, find, repl, file);
    writeFileSync(file, content);
    console.log(`✓ 已更新 ${file}`);
};

if (!existsSync(OLD_ENGINE)) {
    throw new Error(`× 找不到 ${OLD_ENGINE}；请在仓库根目录运行，且已 git pull。`);
}

// 1) git mv 两个文件（保留 git 改名历史）
git(`mv "${OLD_ENGINE}" "${NEW_ENGINE}"`);
git(`mv "${OLD_SPEC}" "${NEW_SPEC}"`);
console.log('✓ 已重命名 handlebars-engine.* → eta-engine.*');

// 2) 引擎文件：删掉注释里所有 "Handlebars" 旧实现字样
edit(NEW_ENGINE, [
    ['提示词模板引擎（基于 eta，替代原先的 Handlebars 实现）。', '提示词模板引擎（eta）。'],
    ['，复刻 Handlebars `strict: true` 的语义', ''],
    ['，等价于 Handlebars 的 `noEscape: true`', ''],
    ['用 Proxy 复刻 Handlebars strict 行为：', '用 Proxy 实现严格上下文：'],
]);

// 3) 引擎测试：改 import 路径
edit(NEW_SPEC, [
    ["from './handlebars-engine.js'", "from './eta-engine.js'"],
]);

// 4) 模板文件：改 import 路径 + 清注释
edit(TEMPLATE, [
    ["from '../render/handlebars-engine.js'", "from '../render/eta-engine.js'"],
    ['标题 + 各条消息按行拼接，等价于原 Handlebars each 块的输出。', '标题 + 各条消息按行拼接。'],
    ['，等价旧模板 each 块的首行空行', ''],
]);

// 5) 入口与上下文：清注释里的 "Handlebars" 字样
edit(SYS_PROMPT, [['（Handlebars 严格模板）', '（eta 严格模板）']]);
edit(CONTEXT, [['以满足 Handlebars 严格模式：', '以满足模板严格模式：']]);

// 6) 暂存改动
git('add -A');
console.log('\n全部完成 ✅  已 git add。建议接着执行：');
console.log('  pnpm --dir builtin-agent test   # 验证 eta 引擎用例');
console.log('  pnpm lint && pnpm typecheck');
console.log('  git commit -m "refactor(prompts): 重命名 handlebars-engine -> eta-engine"');
console.log('  git push');