// fix-store-ts-errors.mjs
// 修复 src/store 下 git.ts / git.store.spec.ts / editor.ts 的 7 个 TS 报错。
// 用法：把本文件放到项目根目录，然后 `node fix-store-ts-errors.mjs`，最后 `pnpm typecheck`。
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = process.cwd();

/** 精确替换：若已应用则跳过；否则断言锚点恰好命中 1 次再替换。 */
function applyEdit(content, file, { find, replace, applied }) {
  if (applied(content)) {
    console.log(`  · 跳过（已应用）: ${file}`);
    return content;
  }
  const count = content.split(find).length - 1;
  if (count !== 1) {
    throw new Error(`锚点在 ${file} 命中 ${count} 次（期望 1 次）：\n${find}`);
  }
  console.log(`  ✓ 已修复: ${file}`);
  return content.replace(find, replace);
}

async function patchFile(relPath, edits) {
  const abs = resolve(ROOT, relPath);
  await access(abs); // 不存在会抛错，提示路径不对
  let content = await readFile(abs, 'utf8');
  for (const edit of edits) content = applyEdit(content, relPath, edit);
  await writeFile(abs, content, 'utf8');
}

async function main() {
  // ① git.ts —— 包装 setTimeout 返回值为 TCommitStatsTimer
  await patchFile('src/store/git.ts', [
    {
      find: `    commitStatsTimer = setTimeout(run, GIT_COMMIT_STATS_BACKGROUND_DELAY_MS);`,
      replace: `    commitStatsTimer = { kind: 'timeout', id: setTimeout(run, GIT_COMMIT_STATS_BACKGROUND_DELAY_MS) };`,
      applied: (c) => c.includes(`{ kind: 'timeout', id: setTimeout(run, GIT_COMMIT_STATS_BACKGROUND_DELAY_MS) }`),
    },
  ]);

  // ② git.store.spec.ts —— 外层数组改为可变，才能 .push
  await patchFile('src/store/git.store.spec.ts', [
    {
      find: `    const historyRefs: readonly IGitCommitSummaryPayload[][] = [];`,
      replace: `    const historyRefs: IGitCommitSummaryPayload[][] = [];`,
      applied: (c) => !c.includes(`readonly IGitCommitSummaryPayload[][]`),
    },
  ]);

  // ③④⑤⑥⑦ editor.ts
  await patchFile('src/store/editor.ts', [
    // ③ 删除未使用的类型导入 ICommandTemplate
    {
      find: `  IAnalyzeScriptPayload,\n  ICommandTemplate,\n  IEditorDocument,`,
      replace: `  IAnalyzeScriptPayload,\n  IEditorDocument,`,
      applied: (c) => !c.includes(`  ICommandTemplate,\n`),
    },
    // ④ 删除未使用的辅助函数 isLoadedTextDocument
    {
      find:
        `const isLoadedTextDocument = (document: IEditorDocument): boolean =>\n` +
        `  document.kind === 'text' && document.bufferLoaded !== false;\n\n`,
      replace: ``,
      applied: (c) => !c.includes(`const isLoadedTextDocument`),
    },
    // ⑤ import: createUniqueId -> createPrefixedId
    {
      find: `import { createUniqueId } from '@/utils/core/id';`,
      replace: `import { createPrefixedId } from '@/utils/core/id';`,
      applied: (c) => c.includes(`import { createPrefixedId } from '@/utils/core/id';`),
    },
    // ⑥⑦ 三处调用 createUniqueId('x') -> createPrefixedId('x')
    {
      find:
        `const createDocumentId = (): string => createUniqueId('document');\n` +
        `const createLogId = (): string => createUniqueId('log');\n` +
        `const createRunHistoryId = (): string => createUniqueId('run-history');`,
      replace:
        `const createDocumentId = (): string => createPrefixedId('document');\n` +
        `const createLogId = (): string => createPrefixedId('log');\n` +
        `const createRunHistoryId = (): string => createPrefixedId('run-history');`,
      applied: (c) => !c.includes(`createUniqueId(`),
    },
  ]);

  console.log('\n全部完成。请运行: pnpm typecheck（vue-tsc --noEmit，预期 0 error）');
}

main().catch((err) => {
  console.error('补丁失败：', err.message);
  process.exitCode = 1;
});