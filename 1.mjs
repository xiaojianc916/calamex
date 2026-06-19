#!/usr/bin/env node
// scripts/codemod/step7-4d-wire-entries-mirror.mjs
//
// Step 7.4d —— 真实接线: 在 pinia 注册插件, ai-conversation store 惰性实例化时
// 装载 entries 双写镜像 (7.4c 的 installEntriesMirror)。
//
// 编辑 (仅一个文件):
//   src/store/index.ts
//     1) 顶部新增 import { installEntriesMirror, type IConversationStoreLike }
//     2) 尾部 pinia.use(piniaPluginPersistedstate) 之后新增镜像插件
//
// 不动 main.ts; 不 eager 实例化; 不翻转渲染 SoT; Step 8 整体删除即回退。
//
// 依赖前置 (缺失即提前失败, 零写入):
//   - 7.4c: src/store/aiThread/entriesMirrorBridge.ts 含 installEntriesMirror / IConversationStoreLike
//   - src/store/index.ts 含两处锚点
//
// 幂等: 若 index.ts 已含 'entriesMirrorBridge' → 视为已接线, 跳过并退出 0。
//
// 用法:
//   node scripts/codemod/step7-4d-wire-entries-mirror.mjs --check
//   node scripts/codemod/step7-4d-wire-entries-mirror.mjs
//   REPO_ROOT=/path node scripts/codemod/step7-4d-wire-entries-mirror.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.env.REPO_ROOT ?? process.cwd());
const argv = new Set(process.argv.slice(2));
const CHECK = argv.has('--check');

const log = (...a) => console.log('[step7-4d]', ...a);
const fail = (msg) => {
  console.error('[step7-4d] ✗', msg);
  process.exit(1);
};

const TARGET = 'src/store/index.ts';
const BRIDGE = 'src/store/aiThread/entriesMirrorBridge.ts';
const WIRED_MARKER = 'entriesMirrorBridge';

const IMPORT_FIND =
  "import { createPinia } from 'pinia';\n" +
  "import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';";

const IMPORT_REPLACE =
  "import { createPinia } from 'pinia';\n" +
  "import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';\n" +
  '\n' +
  "import { installEntriesMirror, type IConversationStoreLike } from '@/store/aiThread/entriesMirrorBridge';";

const PLUGIN_FIND =
  'export const pinia = createPinia();\n' +
  'pinia.use(piniaPluginPersistedstate);';

const PLUGIN_REPLACE =
  'export const pinia = createPinia();\n' +
  'pinia.use(piniaPluginPersistedstate);\n' +
  '\n' +
  '// Step 7.4d —— entries 双写镜像接线 (Step 8 整体删除)。\n' +
  '// ai-conversation store 惰性实例化、persistedstate hydrate 之后装载双写镜像;\n' +
  '// 仅向新 key 投影, 不改变渲染 SoT; 保留惰性 hydrate, 不 eager 实例化。\n' +
  'pinia.use(({ store }) => {\n' +
  "  if (store.$id === 'ai-conversation') {\n" +
  '    installEntriesMirror(store as unknown as IConversationStoreLike);\n' +
  '  }\n' +
  '});';

const checkPreconditions = () => {
  const errors = [];

  const bridgeAbs = join(REPO_ROOT, BRIDGE);
  if (!existsSync(bridgeAbs)) {
    errors.push(`缺少 ${BRIDGE} —— 请先应用 step7-4c-entries-mirror-bridge.mjs (7.4c)。`);
  } else {
    const bc = readFileSync(bridgeAbs, 'utf8');
    for (const token of ['installEntriesMirror', 'IConversationStoreLike']) {
      if (!bc.includes(token)) {
        errors.push(`${BRIDGE} 未包含 "${token}" —— 7.4c 不完整。`);
      }
    }
  }

  const targetAbs = join(REPO_ROOT, TARGET);
  if (!existsSync(targetAbs)) {
    errors.push(`缺少 ${TARGET}。`);
  }

  return errors;
};

const applyEdit = (content, find, replace, label) => {
  const occurrences = content.split(find).length - 1;
  if (occurrences !== 1) {
    fail(`锚点 [${label}] 预期出现 1 次, 实际 ${occurrences} 次; 未写入。`);
  }
  return content.replace(find, () => replace);
};

const run = () => {
  log('REPO_ROOT =', REPO_ROOT);
  log(CHECK ? '模式: --check (干跑)' : '模式: 写入');

  const preErrors = checkPreconditions();
  if (preErrors.length > 0) {
    preErrors.forEach((e) => console.error('[step7-4d] ✗ 前置:', e));
    fail('依赖前置校验失败, 未写入。');
  }
  log('✓ 依赖前置校验通过 (7.4c bridge + index 锚点文件存在)');

  const targetAbs = join(REPO_ROOT, TARGET);
  const before = readFileSync(targetAbs, 'utf8');

  if (before.includes(WIRED_MARKER)) {
    log(`✓ ${TARGET} 已包含 "${WIRED_MARKER}", 视为已接线, 跳过 (无操作)。`);
    return;
  }

  let next = before;
  next = applyEdit(next, IMPORT_FIND, IMPORT_REPLACE, 'import');
  next = applyEdit(next, PLUGIN_FIND, PLUGIN_REPLACE, 'plugin');

  if (next === before) {
    fail('编辑后内容无变化, 异常; 未写入。');
  }

  if (CHECK) {
    log(`  [将修改] ${TARGET} (${before.length} → ${next.length} bytes)`);
    log('✓ --check 通过, 未写入。');
    return;
  }

  writeFileSync(targetAbs, next, { encoding: 'utf8' });
  log('  ✓ 写入', TARGET);
  log('✓ 完成。下一步: pnpm typecheck && pnpm lint && pnpm test');
};

run();