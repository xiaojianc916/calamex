// scripts/cleanup-workspace-root-path.mjs
//
// Option B 清理：彻底移除 useAiProviderConfig 不再消费的 workspaceRootPath 依赖。
//   - src/composables/ai/useAiAssistant.provider-config.ts：接口删字段
//   - src/composables/ai/useAiAssistant.ts：调用点不再传该字段
//
// 用法（在仓库根目录 D:\com.xiaojianc\my_desktop_app 执行）：
//   node scripts/cleanup-workspace-root-path.mjs
//
// 安全策略：每处必须精确命中 1 次；命中 0 次且目标 token 已消失 → 视为已处理并跳过；
// 命中 0 次但 token 仍在 → 报错（本地格式与预期不一致，需人工确认），绝不静默改坏。
// 兼容 CRLF / LF 与任意缩进；仅改动目标片段，其余字节与行尾不变。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();

const edits = [
  {
    file: 'src/composables/ai/useAiAssistant.provider-config.ts',
    pattern:
      /(export interface IUseAiProviderConfigDeps \{[\r\n]+)[ \t]*workspaceRootPath: Ref<string \| null>;[\r\n]+([ \t]*errorMessage: Ref<string>;)/g,
    replacement: '$1$2',
    removedToken: 'workspaceRootPath: Ref<string | null>;',
  },
  {
    file: 'src/composables/ai/useAiAssistant.ts',
    pattern:
      /(useAiProviderConfig\(\{[\r\n]+)[ \t]*workspaceRootPath: options\.workspaceRootPath,[\r\n]+([ \t]*errorMessage,)/g,
    replacement: '$1$2',
    removedToken: 'workspaceRootPath: options.workspaceRootPath,',
  },
];

let failed = false;

for (const { file, pattern, replacement, removedToken } of edits) {
  const filePath = path.join(repoRoot, file);

  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    console.error(`[fail] 读不到文件（确认在仓库根目录执行）：${file}`);
    failed = true;
    continue;
  }

  const matches = content.match(pattern);
  const count = matches ? matches.length : 0;

  if (count === 1) {
    await writeFile(filePath, content.replace(pattern, replacement), 'utf8');
    console.log(`[ok]   已更新：${file}`);
  } else if (count === 0) {
    if (content.includes(removedToken)) {
      console.error(
        `[fail] 未匹配到预期片段，但 \`${removedToken}\` 仍在：${file}\n` +
          '       本地格式可能与预期不一致，请人工核对后再删。',
      );
      failed = true;
    } else {
      console.log(`[skip] 已是目标状态：${file}`);
    }
  } else {
    console.error(`[fail] 命中 ${count} 处（预期 1 处，已中止）：${file}`);
    failed = true;
  }
}

if (failed) {
  console.error('\n存在失败项，未全部完成。');
  process.exit(1);
}

console.log('\n完成。建议先 pnpm typecheck 验证，再提交。');