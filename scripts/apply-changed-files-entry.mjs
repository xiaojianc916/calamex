// scripts/apply-changed-files-store.mjs
// 仅处理 store/aiThread 三文件的 changed_files 接入。依赖 PR #1 已在本地。
// 行尾自适应（CRLF/LF）；幂等（先查 marker）；需在仓库根目录执行。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

/** @type {Array<{file:string, find:string, replace:string, marker:string}>} */
const edits = [
  // ---- src/store/aiThread/events.ts -------------------------------------
  {
    file: 'src/store/aiThread/events.ts',
    marker: `  IAiThreadChangedFilesEntry,\n  IAiThreadContentBlock,`,
    find: `import type {\n  IAiThreadContentBlock,`,
    replace: `import type {\n  IAiThreadChangedFilesEntry,\n  IAiThreadContentBlock,`,
  },
  {
    file: 'src/store/aiThread/events.ts',
    marker: `kind: 'changed_files';`,
    find:
      `  | {\n` +
      `      kind: 'context_compaction';\n` +
      `      id: string;\n` +
      `      createdAt: string;\n` +
      `      message?: string;\n` +
      `    }`,
    replace:
      `  | {\n` +
      `      kind: 'context_compaction';\n` +
      `      id: string;\n` +
      `      createdAt: string;\n` +
      `      message?: string;\n` +
      `    }\n` +
      `  | {\n` +
      `      kind: 'changed_files';\n` +
      `      id: string;\n` +
      `      createdAt: string;\n` +
      `      summary: IAiThreadChangedFilesEntry['summary'];\n` +
      `    }`,
  },

  // ---- src/store/aiThread/reduce.ts -------------------------------------
  {
    file: 'src/store/aiThread/reduce.ts',
    marker: `function upsertChangedFiles(`,
    find: `/* ----- Stream finalization ------------------------------------------------ */`,
    replace:
      `/* ----- Changed files (ChangedFiles summary) ------------------------------- */\n` +
      `function upsertChangedFiles(\n` +
      `  thread: IAiThread,\n` +
      `  event: TAiThreadReduceEventByKind<'changed_files'>,\n` +
      `): IAiThread {\n` +
      `  const index = thread.entries.findIndex(\n` +
      `    (entry) => entry.type === 'changed_files' && entry.id === event.id,\n` +
      `  );\n\n` +
      `  if (index === -1) {\n` +
      `    const entry: IAiThreadEntry = {\n` +
      `      type: 'changed_files',\n` +
      `      id: event.id,\n` +
      `      createdAt: event.createdAt,\n` +
      `      summary: event.summary,\n` +
      `    };\n` +
      `    return { ...thread, entries: [...thread.entries, entry] };\n` +
      `  }\n\n` +
      `  // 撤销/重新应用同一 patch 走更新分支：保留首次 createdAt 以稳定时间线位置。\n` +
      `  const current = thread.entries[index];\n` +
      `  const merged: IAiThreadEntry = {\n` +
      `    type: 'changed_files',\n` +
      `    id: event.id,\n` +
      `    createdAt: current.createdAt,\n` +
      `    summary: event.summary,\n` +
      `  };\n` +
      `  return { ...thread, entries: replaceAt(thread.entries, index, merged) };\n` +
      `}\n\n` +
      `/* ----- Stream finalization ------------------------------------------------ */`,
  },
  {
    file: 'src/store/aiThread/reduce.ts',
    marker: `    case 'changed_files':`,
    find: `    case 'context_compaction':\n      return appendContextCompaction(thread, event);`,
    replace:
      `    case 'context_compaction':\n` +
      `      return appendContextCompaction(thread, event);\n` +
      `    case 'changed_files':\n` +
      `      return upsertChangedFiles(thread, event);`,
  },

  // ---- src/store/aiThread/reduce.spec.ts --------------------------------
  {
    file: 'src/store/aiThread/reduce.spec.ts',
    marker: `  IAiThreadChangedFilesEntry,\n  IAiThreadContextCompactionEntry,`,
    find: `  IAiThreadAssistantMessageEntry,\n  IAiThreadContextCompactionEntry,`,
    replace: `  IAiThreadAssistantMessageEntry,\n  IAiThreadChangedFilesEntry,\n  IAiThreadContextCompactionEntry,`,
  },
  {
    file: 'src/store/aiThread/reduce.spec.ts',
    marker: `changed_files 按 id upsert`,
    find: `  it('nextToolStatus 状态机', () => {`,
    replace:
      `  it('changed_files 按 id upsert：应用创建、撤销同 id 整体替换 summary 并保留位置', () => {\n` +
      `    let thread = createThread();\n` +
      `    const summary: IAiThreadChangedFilesEntry['summary'] = {\n` +
      `      id: 'patch-1',\n` +
      `      runId: 'run-1',\n` +
      `      stepId: 's1',\n` +
      `      files: [\n` +
      `        { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, diffRef: 'd1' },\n` +
      `      ],\n` +
      `      totalAdditions: 3,\n` +
      `      totalDeletions: 1,\n` +
      `      patchRef: 'p-ref-1',\n` +
      `    };\n` +
      `    thread = reduceThread(thread, {\n` +
      `      kind: 'changed_files',\n` +
      `      id: 'patch-1',\n` +
      `      createdAt: ISO,\n` +
      `      summary,\n` +
      `    });\n` +
      `    expect(thread.entries.filter((e) => e.type === 'changed_files')).toHaveLength(1);\n\n` +
      `    const reverted: IAiThreadChangedFilesEntry['summary'] = {\n` +
      `      ...summary,\n` +
      `      revertedAt: '2026-06-14T09:06:00.000Z',\n` +
      `    };\n` +
      `    thread = reduceThread(thread, {\n` +
      `      kind: 'changed_files',\n` +
      `      id: 'patch-1',\n` +
      `      createdAt: '2026-06-14T09:06:00.000Z',\n` +
      `      summary: reverted,\n` +
      `    });\n\n` +
      `    const changed = thread.entries.filter(\n` +
      `      (e) => e.type === 'changed_files',\n` +
      `    ) as IAiThreadChangedFilesEntry[];\n` +
      `    expect(changed).toHaveLength(1);\n` +
      `    expect(changed[0].summary.revertedAt).toBe('2026-06-14T09:06:00.000Z');\n` +
      `    // 保留首次出现的 createdAt，位置稳定\n` +
      `    expect(changed[0].createdAt).toBe(ISO);\n` +
      `  });\n\n` +
      `  it('nextToolStatus 状态机', () => {`,
  },
];

let applied = 0;
let skipped = 0;

for (const e of edits) {
  const path = resolve(ROOT, e.file);
  if (!existsSync(path)) {
    console.error(`✗ 缺少文件：${e.file}`);
    process.exit(1);
  }
  let src = readFileSync(path, 'utf8');

  // 按文件实际行尾自适应（关键修复：本地 store 文件是 CRLF）。
  const nl = /\r\n/.test(src) ? '\r\n' : '\n';
  const toEol = (s) => s.split('\n').join(nl);
  const find = toEol(e.find);
  const replace = toEol(e.replace);
  const marker = toEol(e.marker);

  // 先查 marker：已应用则跳过（幂等，避免重复插入）。
  if (src.includes(marker)) {
    console.log(`• 跳过（已应用）：${e.file} :: ${e.marker.split('\n')[0]}`);
    skipped += 1;
    continue;
  }

  const occurrences = src.split(find).length - 1;
  if (occurrences === 0) {
    console.error(`✗ 锚点未找到：${e.file}\n  锚点：${JSON.stringify(e.find.slice(0, 60))}`);
    process.exit(1);
  }
  if (occurrences > 1) {
    console.error(`✗ 锚点不唯一（${occurrences} 处）：${e.file} —— 请人工核对。`);
    process.exit(1);
  }

  src = src.replace(find, () => replace); // 保持文件原有行尾
  writeFileSync(path, src, 'utf8');
  console.log(`✓ 应用 ${e.file}（行尾 ${nl === '\r\n' ? 'CRLF' : 'LF'}）`);
  applied += 1;
}

console.log(`\n完成：应用 ${applied} 处，跳过 ${skipped} 处。`);
console.log('请运行：pnpm lint && pnpm typecheck && pnpm test');