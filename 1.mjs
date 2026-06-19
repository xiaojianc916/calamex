#!/usr/bin/env node
// scripts/codemod/step7-1-entries-persist-schema.mjs
//
// Step 7.1: entries 持久化信封 schema + 版本号 + 逐条救援（纯新增，零行为变化）
//
// 用法:
//   node scripts/codemod/step7-1-entries-persist-schema.mjs --check   # 干跑，仅打印将创建的文件
//   node scripts/codemod/step7-1-entries-persist-schema.mjs           # 实际写入
//   node scripts/codemod/step7-1-entries-persist-schema.mjs --force   # 允许覆盖已存在文件
//   REPO_ROOT=/path/to/repo node scripts/codemod/step7-1-entries-persist-schema.mjs
//
// 设计:
//   - 仅创建 3 个新文件, 不修改任何既有文件 → git revert / 删文件即可回滚。
//   - 默认拒绝覆盖已存在文件(防误伤); --force 才允许。
//   - 事务化: 先校验全部前置条件, 任一不满足则零写入退出。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT ? resolve(process.env.REPO_ROOT) : process.cwd();
const CHECK = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');

const PERSIST_SCHEMA = `import { z } from 'zod';

import { aiThreadSchema } from '@/types/ai/thread/entry.schema';

/* ============================================================================
 * AI Thread 持久化信封 schema（ADR-0014 Step 7.1）
 *
 * 对标现有 aiConversationPersistSchema（扁平 messages 持久化），区别在于线程改用
 * entries 模型（aiThreadSchema）取代扁平 messages。新增 version 版本号，为后续
 * v1->vN 结构迁移留出兼容位（沿用 aiConversation 的 hydrate 容错思路）。
 *
 * 单一真源：schema 在此定义，类型由 z.infer 推导，严禁手写并行接口。
 * 本文件为纯新增，未接线进任何 store hydrate（接线在 Step 7.3 完成），故零行为变化。
 * ========================================================================== */

/** 当前 entries 持久化结构版本。发生结构破坏性变更时 +1，并补对应迁移分支。 */
export const AI_THREAD_PERSIST_VERSION = 1;

export const aiThreadPersistSchema = z.object({
  /**
   * 结构版本号；缺省 / 非法兑底为当前版本。
   * 旧快照无此字段时按当前版本处理，避免因缺字段整库 parse 失败。
   */
  version: z.number().int().positive().catch(AI_THREAD_PERSIST_VERSION),
  activeThreadId: z.string().trim().min(1).nullable(),
  threads: z.array(aiThreadSchema),
});

/** 持久化信封类型（z.infer 推导，单一真源）。 */
export type IAiThreadPersist = z.infer<typeof aiThreadPersistSchema>;
`;

const PERSIST_SALVAGE = `import { aiThreadEntrySchema, aiThreadSchema } from '@/types/ai/thread';
import type { IAiThread } from '@/types/ai/thread';

/* ============================================================================
 * Entries 持久化逐条救援（ADR-0014 Step 7.1）
 *
 * 等价搬运 aiConversation 的 salvageHydratedThreads 容错思路到 entries 模型：
 * 严格 parse 失败后，逐线程 / 逐 entry safeParse —
 * - 单条 entry 不合法 → 仅丢弃该 entry，保留同线程其余 entries；
 * - 线程元信息(id/title/时间戳)不合法 → 丢弃该线程，保留其余线程；
 * - 至少救回一个线程即返回；全部不可救援才返回 null（交回 legacy / 兜底）。
 * 绝不因单条坏数据清空整库。
 *
 * 纯函数、无 I/O、无 Vue/store 依赖，可在 Node 单测中独立运行。
 * 仅供 Step 7.3 在严格 parse 失败后作为兜底调用；本步未接线，故零行为变化。
 * ========================================================================== */

/** 救援结果运行时形状（不含 version；版本戳由调用方在归一化阶段补齐）。 */
export interface IAiThreadPersistShape {
  activeThreadId: string | null;
  threads: IAiThread[];
}

/**
 * 逐线程 / 逐 entry 救援一份 entries 持久化快照。
 *
 * 仅在严格 aiThreadPersistSchema parse 失败后作为兜底调用；parse 成功路径不变。
 */
export function salvageHydratedThreadEntries(
  rawThreads: unknown,
  rawActiveThreadId: unknown,
): IAiThreadPersistShape | null {
  if (!Array.isArray(rawThreads)) {
    return null;
  }
  const threads = rawThreads.flatMap((rawThread): IAiThread[] => {
    if (typeof rawThread !== 'object' || rawThread === null) {
      return [];
    }
    const candidate = rawThread as Record<string, unknown>;
    const rawEntries = Array.isArray(candidate.entries) ? candidate.entries : [];
    // 逐条救援: 保留可通过校验的 entry, 丢弃异常单条, 避免一条坏数据牵连整线程。
    const entries = rawEntries.flatMap((rawEntry) => {
      const parsed = aiThreadEntrySchema.safeParse(rawEntry);
      return parsed.success ? [parsed.data] : [];
    });
    // 用线程 schema 校验元信息; entries 已替换为救援后的合法集合。
    const parsedThread = aiThreadSchema.safeParse({ ...candidate, entries });
    return parsedThread.success ? [parsedThread.data] : [];
  });
  if (threads.length === 0) {
    return null;
  }
  const activeThreadId =
    typeof rawActiveThreadId === 'string' && rawActiveThreadId.trim().length > 0
      ? rawActiveThreadId
      : null;
  return { activeThreadId, threads };
}
`;

const PERSIST_SPEC = `import { describe, expect, it } from 'vitest';

import { salvageHydratedThreadEntries } from '@/store/aiThread/persist';
import { aiThreadPersistSchema } from '@/types/ai/thread/persist.schema';

const ISO = '2026-06-19T09:00:00.000Z';

const validThread = (id: string) => ({
  id,
  title: '线程 ' + id,
  titleStatus: 'generated',
  createdAt: ISO,
  updatedAt: ISO,
  entries: [
    { type: 'user_message', id: id + '-u1', createdAt: ISO, content: [{ type: 'text', text: '你好' }] },
    {
      type: 'assistant_message',
      id: id + '-a1',
      createdAt: ISO,
      chunks: [{ type: 'message', block: { type: 'text', text: '回答' } }],
    },
  ],
});

describe('aiThreadPersistSchema', () => {
  it('校验完整持久化信封并保留 version', () => {
    const parsed = aiThreadPersistSchema.parse({
      version: 1,
      activeThreadId: 't1',
      threads: [validThread('t1')],
    });
    expect(parsed.version).toBe(1);
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.activeThreadId).toBe('t1');
  });

  it('version 缺省 / 非法兑底为当前版本', () => {
    const missing = aiThreadPersistSchema.parse({ activeThreadId: null, threads: [] });
    expect(missing.version).toBe(1);
    const invalid = aiThreadPersistSchema.parse({ version: -3, activeThreadId: null, threads: [] });
    expect(invalid.version).toBe(1);
  });
});

describe('salvageHydratedThreadEntries', () => {
  it('丢弃单条非法 entry, 保留同线程其余 entries', () => {
    const thread = validThread('t1');
    const salvaged = salvageHydratedThreadEntries(
      [
        {
          ...thread,
          entries: [thread.entries[0], { type: 'mystery', id: 'bad', createdAt: ISO }, thread.entries[1]],
        },
      ],
      't1',
    );
    expect(salvaged).not.toBeNull();
    expect(salvaged?.threads).toHaveLength(1);
    expect(salvaged?.threads[0]?.entries).toHaveLength(2);
    expect(salvaged?.activeThreadId).toBe('t1');
  });

  it('丢弃元信息非法的线程, 保留其余线程', () => {
    const bad = { ...validThread('bad'), title: '' };
    const salvaged = salvageHydratedThreadEntries([bad, validThread('good')], 'good');
    expect(salvaged?.threads.map((t) => t.id)).toEqual(['good']);
  });

  it('全部不可救援返回 null', () => {
    expect(salvageHydratedThreadEntries('not-an-array', null)).toBeNull();
    expect(salvageHydratedThreadEntries([{ nope: true }], null)).toBeNull();
  });

  it('非法 activeThreadId 归一化为 null', () => {
    const salvaged = salvageHydratedThreadEntries([validThread('t1')], '   ');
    expect(salvaged?.activeThreadId).toBeNull();
  });
});
`;

const files = [
  { path: 'src/types/ai/thread/persist.schema.ts', content: PERSIST_SCHEMA },
  { path: 'src/store/aiThread/persist.ts', content: PERSIST_SALVAGE },
  { path: 'src/store/aiThread/persist.spec.ts', content: PERSIST_SPEC },
];

// ── 前置检查（事务化：任一不满足则零写入）
const problems = [];
const deps = ['src/types/ai/thread/entry.schema.ts', 'src/types/ai/thread/index.ts'];
for (const d of deps) {
  if (!existsSync(join(REPO_ROOT, d))) {
    problems.push('缺少依赖文件: ' + d + '（仓库结构与预期不符，中止）');
  }
}
for (const f of files) {
  if (existsSync(join(REPO_ROOT, f.path)) && !FORCE) {
    problems.push('目标已存在: ' + f.path + '（用 --force 覆盖，或先确认）');
  }
}
if (problems.length > 0) {
  console.error('✗ 前置检查未通过:\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}

if (CHECK) {
  console.log('● --check 干跑，将创建以下文件:');
  for (const f of files) console.log('  + ' + f.path + ' (' + f.content.split('\n').length + ' 行)');
  console.log('● 不修改任何既有文件。');
  process.exit(0);
}

for (const f of files) {
  const abs = join(REPO_ROOT, f.path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, f.content, 'utf8');
  console.log('  + 写入 ' + f.path);
}
console.log('✓ Step 7.1 完成。');
console.log('  下一步: pnpm typecheck && pnpm lint && pnpm test，然后手动提交（按 SOP 不经 MCP 提交）。');
console.log('  注意: 本步未接线进任何 hydrate（接线在 Step 7.3），界面零变化。');