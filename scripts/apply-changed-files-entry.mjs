// scripts/apply-changed-files-entry.mjs
// 方案B / Step 5.0 第二切片：为 AI thread entries 增加 changed_files entry，
// 并让 reduceThread 按 patch id upsert（应用创建 / 撤销重应用替换 summary）。
// 幂等：可重复运行；锚点已应用则自动跳过。需在仓库根目录执行。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

if (!existsSync(resolve(ROOT, 'src/types/ai/thread/entry.schema.ts'))) {
  console.error('✗ 未找到 src/types/ai/thread/entry.schema.ts —— 请在仓库根目录运行此脚本。');
  process.exit(1);
}

/** @type {Array<{file:string, find:string, replace:string, marker:string, all?:boolean}>} */
const edits = [
  // ---- src/types/ai/thread/constants.ts ---------------------------------
  {
    file: 'src/types/ai/thread/constants.ts',
    marker: `  'changed_files',\n] as const;`,
    find: `  'context_compaction',\n] as const;`,
    replace: `  'context_compaction',\n  'changed_files',\n] as const;`,
  },

  // ---- src/types/ai/thread/entry.schema.ts ------------------------------
  {
    file: 'src/types/ai/thread/entry.schema.ts',
    marker: `from '@/types/ai/patch.schema'`,
    find: `} from '@/types/ai/conversation.schema';`,
    replace: `} from '@/types/ai/conversation.schema';\nimport { aiAgentPatchSummarySchema } from '@/types/ai/patch.schema';`,
  },
  {
    file: 'src/types/ai/thread/entry.schema.ts',
    marker: `aiThreadChangedFilesEntrySchema = z.object(`,
    find: `export const aiThreadEntrySchema = z.discriminatedUnion('type', [`,
    replace:
      `/**\n` +
      ` * Changed-files entry：内嵌完整 patch 摘要快照，使 thread entries 自洽可持久化。\n` +
      ` * 投影层据此渲染 changed-files-summary；应用/撤销同一 patch 按 id upsert，\n` +
      ` * 避免与 aiAgent store 的 patch 摘要错位（位置由首次 createdAt 固定）。\n` +
      ` */\n` +
      `export const aiThreadChangedFilesEntrySchema = z.object({\n` +
      `  type: z.literal('changed_files'),\n` +
      `  id: z.string().min(1),\n` +
      `  createdAt: z.string().min(1),\n` +
      `  summary: aiAgentPatchSummarySchema,\n` +
      `});\n\n` +
      `export const aiThreadEntrySchema = z.discriminatedUnion('type', [`,
  },
  {
    file: 'src/types/ai/thread/entry.schema.ts',
    marker: `  aiThreadChangedFilesEntrySchema,\n]);`,
    find: `  aiThreadContextCompactionEntrySchema,\n]);`,
    replace: `  aiThreadContextCompactionEntrySchema,\n  aiThreadChangedFilesEntrySchema,\n]);`,
  },

  // ---- src/types/ai/thread/index.ts -------------------------------------
  // 同时出现在「type import 块」和「value re-export 块」，两处都要加 → all。
  {
    file: 'src/types/ai/thread/index.ts',
    all: true,
    marker: `  aiThreadChangedFilesEntrySchema,\n  aiThreadContextCompactionEntrySchema,`,
    find: `  aiThreadAssistantMessageEntrySchema,\n  aiThreadContextCompactionEntrySchema,`,
    replace: `  aiThreadAssistantMessageEntrySchema,\n  aiThreadChangedFilesEntrySchema,\n  aiThreadContextCompactionEntrySchema,`,
  },
  {
    file: 'src/types/ai/thread/index.ts',
    marker: `export type IAiThreadChangedFilesEntry = z.infer`,
    find: `export type IAiThreadContextCompactionEntry = z.infer<typeof aiThreadContextCompactionEntrySchema>;`,
    replace:
      `export type IAiThreadContextCompactionEntry = z.infer<typeof aiThreadContextCompactionEntrySchema>;\n` +
      `export type IAiThreadChangedFilesEntry = z.infer<typeof aiThreadChangedFilesEntrySchema>;`,
  },

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

  const occurrences = src.split(e.find).length - 1;

  if (occurrences === 0) {
    if (src.includes(e.marker)) {
      console.log(`• 跳过（已应用）：${e.file} :: ${e.marker.split('\n')[0]}`);
      skipped += 1;
      continue;
    }
    console.error(`✗ 锚点未找到：${e.file}\n  锚点：${JSON.stringify(e.find.slice(0, 60))}`);
    process.exit(1);
  }

  if (!e.all && occurrences > 1) {
    console.error(`✗ 锚点不唯一（${occurrences} 处）：${e.file} —— 请人工核对。`);
    process.exit(1);
  }

  src = e.all ? src.split(e.find).join(e.replace) : src.replace(e.find, () => e.replace);

  writeFileSync(path, src, 'utf8');
  console.log(`✓ 应用 ${e.all ? `(${occurrences} 处)` : ''} ${e.file}`);
  applied += 1;
}

console.log(`\n完成：应用 ${applied} 处，跳过 ${skipped} 处。`);
console.log('请运行：pnpm lint && pnpm typecheck && pnpm test');