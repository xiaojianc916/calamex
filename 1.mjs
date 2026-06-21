// fix-aithread-theme-ts-errors.mjs
// 修复 3 个文件 / 6 个 TS 报错：
//   src/store/aiThread/thread-mutations.ts        (ts2554)
//   src/store/aiThread/entriesRenderHydrate.spec.ts (ts2339 ×4)
//   src/themes/runtime/resolved-theme.ts          (ts6133)
// 用法（项目根目录 D:\com.xiaojianc\my_desktop_app）：
//   node fix-aithread-theme-ts-errors.mjs
//   pnpm typecheck
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = process.cwd();

function applyEdit(content, file, { find, replace, applied }) {
  if (applied(content)) {
    console.log(`  · 跳过（已应用）: ${file}`);
    return content;
  }
  const count = content.split(find).length - 1;
  if (count !== 1) {
    throw new Error(
      `锚点在 ${file} 命中 ${count} 次（期望 1 次），已中止：\n--- 锚点 ---\n${find}\n------------`,
    );
  }
  console.log(`  ✓ 已修复: ${file}`);
  return content.replace(find, replace);
}

async function patchFile(relPath, edits) {
  const abs = resolve(ROOT, relPath);
  try {
    await access(abs);
  } catch {
    throw new Error(`文件不存在: ${relPath}（请确认在项目根目录运行）`);
  }
  let content = await readFile(abs, 'utf8');
  for (const edit of edits) content = applyEdit(content, relPath, edit);
  await writeFile(abs, content, 'utf8');
}

async function main() {
  // ───────── ① thread-mutations.ts ─────────
  await patchFile('src/store/aiThread/thread-mutations.ts', [
    {
      find: `import { createUniqueId } from '@/utils/core/id';`,
      replace: `import { createPrefixedId } from '@/utils/core/id';`,
      applied: (c) => c.includes(`import { createPrefixedId } from '@/utils/core/id';`),
    },
    {
      find: `const createThreadId = (): string => createUniqueId('ai-thread');`,
      replace: `const createThreadId = (): string => createPrefixedId('ai-thread');`,
      applied: (c) => !c.includes(`createUniqueId(`),
    },
  ]);

  // ───────── ② entriesRenderHydrate.spec.ts ─────────
  await patchFile('src/store/aiThread/entriesRenderHydrate.spec.ts', [
    // A: test1 声明 -> const 数组
    {
      find:
        `    let received: IResolvePersistedThreadsInput | null = null;\n` +
        `    const legacyThreads: IAiConversationThread[] = [];`,
      replace:
        `    const receivedInputs: IResolvePersistedThreadsInput[] = [];\n` +
        `    const legacyThreads: IAiConversationThread[] = [];`,
      applied: (c) =>
        c.includes(
          `    const receivedInputs: IResolvePersistedThreadsInput[] = [];\n    const legacyThreads: IAiConversationThread[] = [];`,
        ),
    },
    // B: test1 回调 push
    {
      find:
        `        loadSnapshot: async () => ({ status: 'loaded', raw: JSON.stringify({ hello: 'world' }) }),\n` +
        `        resolve: (input) => {\n` +
        `          received = input;\n` +
        `          return resolved;\n` +
        `        },`,
      replace:
        `        loadSnapshot: async () => ({ status: 'loaded', raw: JSON.stringify({ hello: 'world' }) }),\n` +
        `        resolve: (input) => {\n` +
        `          receivedInputs.push(input);\n` +
        `          return resolved;\n` +
        `        },`,
      applied: (c) =>
        c.includes(
          `raw: JSON.stringify({ hello: 'world' }) }),\n        resolve: (input) => {\n          receivedInputs.push(input);`,
        ),
    },
    // C: test1 断言段 -> 读数组首元素
    {
      find:
        `    expect(received).not.toBeNull();\n` +
        `    expect(received?.rawEntriesSnapshot).toEqual({ hello: 'world' });\n` +
        `    expect(received?.legacyActiveThreadId).toBe('legacy-1');\n` +
        `    expect(received?.legacyThreads).toBe(legacyThreads);\n` +
        `    expect(result).toBe(resolved);`,
      replace:
        `    const received = receivedInputs[0];\n` +
        `    expect(received).toBeDefined();\n` +
        `    expect(received?.rawEntriesSnapshot).toEqual({ hello: 'world' });\n` +
        `    expect(received?.legacyActiveThreadId).toBe('legacy-1');\n` +
        `    expect(received?.legacyThreads).toBe(legacyThreads);\n` +
        `    expect(result).toBe(resolved);`,
      applied: (c) =>
        c.includes(`    const received = receivedInputs[0];\n    expect(received).toBeDefined();`),
    },
    // D: test2 声明 -> const 数组
    {
      find:
        `    let received: IResolvePersistedThreadsInput | null = null;\n` +
        `    const resolved: IResolvedPersistedThreads = {\n` +
        `      source: 'legacy',`,
      replace:
        `    const receivedInputs: IResolvePersistedThreadsInput[] = [];\n` +
        `    const resolved: IResolvedPersistedThreads = {\n` +
        `      source: 'legacy',`,
      applied: (c) =>
        c.includes(
          `    const receivedInputs: IResolvePersistedThreadsInput[] = [];\n    const resolved: IResolvedPersistedThreads = {\n      source: 'legacy',`,
        ),
    },
    // E: test2 回调 push
    {
      find:
        `        loadSnapshot: async () => ({ status: 'loaded', raw: '{ not valid json' }),\n` +
        `        resolve: (input) => {\n` +
        `          received = input;\n` +
        `          return resolved;\n` +
        `        },`,
      replace:
        `        loadSnapshot: async () => ({ status: 'loaded', raw: '{ not valid json' }),\n` +
        `        resolve: (input) => {\n` +
        `          receivedInputs.push(input);\n` +
        `          return resolved;\n` +
        `        },`,
      applied: (c) =>
        c.includes(
          `raw: '{ not valid json' }),\n        resolve: (input) => {\n          receivedInputs.push(input);`,
        ),
    },
    // F: test2 断言 -> 读数组首元素
    {
      find: `    expect(received?.rawEntriesSnapshot).toBeNull();`,
      replace: `    expect(receivedInputs[0]?.rawEntriesSnapshot).toBeNull();`,
      applied: (c) => c.includes(`    expect(receivedInputs[0]?.rawEntriesSnapshot).toBeNull();`),
    },
  ]);

  // ───────── ③ resolved-theme.ts ─────────
  await patchFile('src/themes/runtime/resolved-theme.ts', [
    {
      find: `function buildUserOverrideCssVars(opts: {`,
      replace: `export function buildUserOverrideCssVars(opts: {`,
      applied: (c) => c.includes(`export function buildUserOverrideCssVars(`),
    },
  ]);

  console.log('\n全部完成。请运行: pnpm typecheck');
}

main().catch((err) => {
  console.error('\n✗ 失败:', err.message);
  process.exit(1);
});