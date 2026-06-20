#!/usr/bin/env node
// 8.1c — 收敛 aiThread store 的 renderFromEntries/setRenderFromEntries 双轨开关。
// 仅两文件实引用：store index.ts（state+doc+action+两处导出）、useAiAssistant.ts（一处调用）。
// 用法：
//   node 1.mjs --check   # 干跑：只校验匹配命中数，不写盘
//   node 1.mjs           # 落盘
// 约定：REPO_ROOT 环境变量可覆盖仓库根（默认 cwd）；两文件均 LF，写盘强制 LF。
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const CHECK = process.argv.includes('--check');

const rel = (p) => relative(REPO_ROOT, p) || p;
const read = (p) => readFile(p, 'utf8');
const toLf = (s) => s.replace(/\r\n/g, '\n');

/** 断言 oldStr 恰好命中 1 次后替换；命中数不为 1 直接抛错，宁可失败也不误改。 */
function replaceOnce(content, oldStr, newStr, label) {
  const parts = content.split(oldStr);
  const count = parts.length - 1;
  if (count !== 1) {
    throw new Error(`[${label}] 期望恰好 1 处匹配，实际 ${count} 处`);
  }
  return parts.join(newStr);
}

const edits = [];

// ---------------------------------------------------------------------------
// 文件 1：src/store/aiThread/index.ts
//   - 删除 renderFromEntries 状态声明 + 其 JSDoc（含其后空行）
//   - 删除 setRenderFromEntries action（含其后空行）
//   - 从 return 的 // state 段删除 renderFromEntries
//   - 从 return 的 // actions 段删除 setRenderFromEntries
//   保留：ref/computed/watch 导入（仍被其余 ref/派生使用）。
// ---------------------------------------------------------------------------
{
  const path = join(REPO_ROOT, 'src/store/aiThread/index.ts');
  let content = toLf(await read(path));

  content = replaceOnce(
    content,
    '  /**\n   * 双轨期开关：渲染层据此在「旧 messages 路径」与「新 entries 路径」之间切换。\n   * Step 8 收敛后移除。\n   */\n  const renderFromEntries = ref(true);\n\n',
    '',
    'store:remove-state-decl',
  );

  content = replaceOnce(
    content,
    '  function setRenderFromEntries(value: boolean): void {\n    renderFromEntries.value = value;\n  }\n\n',
    '',
    'store:remove-action',
  );

  content = replaceOnce(
    content,
    '    // state\n    renderFromEntries,\n    liveThread,',
    '    // state\n    liveThread,',
    'store:remove-state-export',
  );

  content = replaceOnce(
    content,
    '    setLiveThread,\n    setRenderFromEntries,\n    setPersistedThreads,',
    '    setLiveThread,\n    setPersistedThreads,',
    'store:remove-action-export',
  );

  edits.push({ path, content });
}

// ---------------------------------------------------------------------------
// 文件 2：src/composables/ai/useAiAssistant.ts
//   - 删除 updateLiveThreadFromSidecarEvents 末尾对 setRenderFromEntries 的唯一调用。
//     其前的 aiThreadStore.setLiveThread(...) 保留不动；aiThreadStore 仍被使用。
// ---------------------------------------------------------------------------
{
  const path = join(REPO_ROOT, 'src/composables/ai/useAiAssistant.ts');
  let content = toLf(await read(path));

  content = replaceOnce(
    content,
    '    aiThreadStore.setRenderFromEntries(true);\n',
    '',
    'composable:remove-call',
  );

  edits.push({ path, content });
}

// ---------------------------------------------------------------------------
// 落盘 / 干跑
// ---------------------------------------------------------------------------
for (const { path, content } of edits) {
  if (CHECK) {
    console.log(`[check] 将写入 ${rel(path)}（${content.length} bytes）`);
  } else {
    await writeFile(path, content, 'utf8');
    console.log(`[write] ${rel(path)}（${content.length} bytes）`);
  }
}

console.log(CHECK ? '\n[check] OK —— 全部匹配命中且唯一，未写盘。' : '\n[done] 8.1c 已应用。');