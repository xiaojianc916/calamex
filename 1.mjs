// 1.mjs — Brick 1: 移除 store/index.ts 中重复的 entries 双写镜像安装(双装 bug)
//
// 背景: installEntriesMirror 被装了两次 ——
//   (1) src/app/main.ts: hydrate + runStartupPersistedRead 之后(顺序正确, 保留);
//   (2) src/store/index.ts: pinia 插件在 ai-conversation store 创建时(多余, 删除)。
// 两次都会 $subscribe + 每次 mutation 投影序列化整库 → 重复开销。保留 (1) 删 (2)。
// 行为等价: 镜像仍安装一次, 新 key 仍双写; 迁移由安装时的即时镜像覆盖。
//
// 用法:
//   node 1.mjs --check   # 仅校验能否精确命中, 不写盘
//   node 1.mjs           # 执行并写回
// 可选: 设 REPO_ROOT 指向仓库根(默认当前工作目录)。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();
const CHECK_ONLY = process.argv.includes('--check');
const target = resolve(REPO_ROOT, 'src/store/index.ts');

const join = (arr, eol) => arr.join(eol);

function replaceOnce(content, oldStr, newStr, label) {
  const count = content.split(oldStr).length - 1;
  if (count === 0) {
    throw new Error(`[${label}] 未找到待替换片段(0 次匹配)。源可能已变更, 已中止。`);
  }
  if (count > 1) {
    throw new Error(`[${label}] 命中 ${count} 次, 预期恰好 1 次, 已中止以免误改。`);
  }
  return content.replace(oldStr, newStr);
}

let content = readFileSync(target, 'utf8');
const eol = content.includes('\r\n') ? '\r\n' : '\n';

// 幂等短路: 已不含 installEntriesMirror 即视为本砖已应用。
if (!content.includes('installEntriesMirror')) {
  console.log('✓ 已是目标状态(store/index.ts 不含 installEntriesMirror), 跳过。');
  process.exit(0);
}

// ── 1) 删除 import 块(连同其上方空行, 避免遗留双空行)。
const importOld = join(
  [
    `import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';`,
    ``,
    `import {`,
    `  type IConversationStoreLike,`,
    `  installEntriesMirror,`,
    `} from '@/store/aiThread/entriesMirrorBridge';`,
  ],
  eol,
);
const importNew = `import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';`;

// ── 2) 删除文件末尾的 pinia.use 镜像接线块(连同注释), 仅保留前一行。
const wiringOld = join(
  [
    `pinia.use(piniaPluginPersistedstate);`,
    ``,
    `// Step 7.4d —— entries 双写镜像接线 (Step 8 整体删除)。`,
    `// ai-conversation store 惰性实例化、persistedstate hydrate 之后装载双写镜像;`,
    `// 仅向新 key 投影, 不改变渲染 SoT; 保留惰性 hydrate, 不 eager 实例化。`,
    `pinia.use(({ store }) => {`,
    `  if (store.$id === 'ai-conversation') {`,
    `    installEntriesMirror(store as unknown as IConversationStoreLike);`,
    `  }`,
    `});`,
  ],
  eol,
);
const wiringNew = `pinia.use(piniaPluginPersistedstate);`;

content = replaceOnce(content, importOld, importNew, 'remove-import');
content = replaceOnce(content, wiringOld, wiringNew, 'remove-wiring');

// 安全断言: 不得残留任何相关引用。
if (content.includes('installEntriesMirror') || content.includes('IConversationStoreLike')) {
  throw new Error('替换后仍残留 installEntriesMirror / IConversationStoreLike, 已中止写盘。');
}
if (content.includes('entriesMirrorBridge')) {
  throw new Error('替换后仍残留 entriesMirrorBridge import, 已中止写盘。');
}

if (CHECK_ONLY) {
  console.log('✓ --check 通过: 两处片段均精确命中 1 次, 可安全应用。');
  process.exit(0);
}

writeFileSync(target, content, 'utf8');
console.log('✓ 已更新 src/store/index.ts: 移除重复的 entries 双写镜像安装及其 import。');