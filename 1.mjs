#!/usr/bin/env node
/**
 * Step 7.3（质量优先 / 纯逻辑先行）：entries 持久化「读路径」解析器。
 *
 * 编码 hydrate 时的数据优先级决策（纯函数、无 I/O、无 store 依赖）：
 *   1) 新 key（entries 信封）严格 aiThreadPersistSchema 解析成功 → 权威采用；
 *   2) 新 key 存在但严格失败 → salvageHydratedThreadEntries 逐条救援；
 *   3) 新 key 缺失 / 不可救援 → 回退旧 key legacy messages，按线程 legacyThreadToThread
 *      懒投影为 entries（旧 key 迁移期仍作非破坏式备份）；
 *   4) 都没有 → 空态。
 * activeThreadId 一律 normalize（指向不存在线程时落首个，空库为 null）。
 *
 * 仅依赖已合入 main 的 7.1（persist.schema / persist）+ 既有 legacy-adapter；
 * 不依赖 7.2（不碰 conversation.schema）。本步不接线，零运行时变化。
 *
 * 创建：
 *   - src/store/aiThread/hydrate.ts
 *   - src/store/aiThread/hydrate.spec.ts
 *
 * 用法：
 *   node scripts/codemod/step7-3-hydrate-resolver.mjs --check
 *   node scripts/codemod/step7-3-hydrate-resolver.mjs
 *   REPO_ROOT=/path/to/repo node scripts/codemod/step7-3-hydrate-resolver.mjs
 *   --force  # 允许覆盖已存在的新文件
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.env.REPO_ROOT ?? process.cwd());
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const FORCE = args.has('--force');

const abs = (relPath) => join(REPO_ROOT, ...relPath.split('/'));
const fail = (msg) => {
  console.error(`\n✗ ${msg}\n  未写入任何文件。`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// 前置依赖校验（7.1 必须已合入；缺失则拒绝，给出明确指引）
// ---------------------------------------------------------------------------
const DEPS = [
  { path: 'src/types/ai/thread/persist.schema.ts', token: 'aiThreadPersistSchema' },
  { path: 'src/store/aiThread/persist.ts', token: 'salvageHydratedThreadEntries' },
  { path: 'src/store/aiThread/legacy-adapter.ts', token: 'legacyThreadToThread' },
];
for (const { path, token } of DEPS) {
  if (!existsSync(abs(path))) {
    fail(`缺少依赖文件 ${path}（请先合入 Step 7.1 后再运行 7.3）。`);
  }
  if (!readFileSync(abs(path), 'utf8').includes(token)) {
    fail(`依赖 ${path} 未导出 ${token}（7.1 产物与预期不符，请核对后再运行）。`);
  }
}

// ---------------------------------------------------------------------------
// 新文件内容
// ---------------------------------------------------------------------------
const HYDRATE_TS = `import type { IAiConversationThread } from '@/store/aiConversation';
import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';
import { salvageHydratedThreadEntries } from '@/store/aiThread/persist';
import type { IAiThread } from '@/types/ai/thread';
import { aiThreadPersistSchema } from '@/types/ai/thread/persist.schema';

/* ============================================================================
 * Entries 持久化「读路径」解析器（ADR-0014 Step 7.3）
 *
 * 统一编码 hydrate 时「该用哪份数据」的优先级决策，纯函数、无 I/O、无 store 依赖：
 *   1) 新 key（entries 信封）严格 aiThreadPersistSchema 解析成功 → 直接采用（权威）；
 *   2) 新 key 存在但严格解析失败 → salvageHydratedThreadEntries 逐条救援；
 *   3) 新 key 缺失 / 不可救援 → 回退旧 key（legacy messages），按线程 legacyThreadToThread
 *      懒投影为 entries（迁移期旧 key 仍作非破坏式备份保留）；
 *   4) 都没有 → 空态。
 *
 * activeThreadId 一律经 normalize 校正：指向不存在的线程时落到首个线程，空库则为 null。
 *
 * 注意：本模块尚未被任何地方 import（接线在 Step 7.4 的异步预热 hydrate + 双写完成），
 * 故对运行时行为零影响。旧 aiConversation store 仍是唯一权威，渲染仍走既有投影。
 * ========================================================================== */

/** 命中的数据来源，便于接线层打点 / 灰度观测。 */
export type TPersistedThreadsSource = 'entries' | 'entries-salvaged' | 'legacy' | 'empty';

export interface IResolvedPersistedThreads {
  source: TPersistedThreadsSource;
  activeThreadId: string | null;
  threads: IAiThread[];
}

export interface IResolvePersistedThreadsInput {
  /** 新 key（entries 信封）原始快照；缺失传 null / undefined。 */
  rawEntriesSnapshot: unknown;
  /** 旧 key 已 hydrate 的 activeThreadId（回退用）。 */
  legacyActiveThreadId: string | null;
  /** 旧 key 已 hydrate / 已救援的 legacy 线程（回退用）。 */
  legacyThreads: IAiConversationThread[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** activeThreadId 必须指向现存线程；否则落到首个线程（空库为 null）。 */
function normalizeActiveThreadId(
  activeThreadId: string | null,
  threads: IAiThread[],
): string | null {
  if (threads.length === 0) {
    return null;
  }
  if (activeThreadId && threads.some((thread) => thread.id === activeThreadId)) {
    return activeThreadId;
  }
  return threads[0].id;
}

export function resolvePersistedThreads(
  input: IResolvePersistedThreadsInput,
): IResolvedPersistedThreads {
  const { rawEntriesSnapshot, legacyActiveThreadId, legacyThreads } = input;

  // 1) + 2) 新 key 存在才尝试 entries 路径（区分「不存在」与「存在但空/坏」）。
  if (rawEntriesSnapshot != null) {
    const strict = aiThreadPersistSchema.safeParse(rawEntriesSnapshot);
    if (strict.success) {
      // 严格成功即权威，即使 threads 为空也尊重（用户已清空，不复活 legacy）。
      return {
        source: 'entries',
        activeThreadId: normalizeActiveThreadId(strict.data.activeThreadId, strict.data.threads),
        threads: strict.data.threads,
      };
    }
    if (isRecord(rawEntriesSnapshot)) {
      const salvaged = salvageHydratedThreadEntries(
        rawEntriesSnapshot.threads,
        rawEntriesSnapshot.activeThreadId,
      );
      if (salvaged) {
        return {
          source: 'entries-salvaged',
          activeThreadId: normalizeActiveThreadId(salvaged.activeThreadId, salvaged.threads),
          threads: salvaged.threads,
        };
      }
    }
    // 新 key 存在但无法解析 / 救援：落到 legacy 兜底（非破坏式，旧 key 仍在）。
  }

  // 3) 回退 legacy messages → entries 投影（懒迁移）。
  if (legacyThreads.length > 0) {
    const threads = legacyThreads.map(legacyThreadToThread);
    return {
      source: 'legacy',
      activeThreadId: normalizeActiveThreadId(legacyActiveThreadId, threads),
      threads,
    };
  }

  // 4) 空态。
  return { source: 'empty', activeThreadId: null, threads: [] };
}
`;

const HYDRATE_SPEC_TS = `import { describe, expect, it } from 'vitest';

import type { IAiConversationThread } from '@/store/aiConversation';
import { resolvePersistedThreads } from '@/store/aiThread/hydrate';

const ISO_A = '2026-06-19T10:00:00.000Z';
const ISO_B = '2026-06-19T10:01:00.000Z';

const userMessageEntry = (id: string, text: string) => ({
  type: 'user_message',
  id,
  createdAt: ISO_A,
  content: text.length > 0 ? [{ type: 'text', text }] : [],
  references: [],
});

const entriesThread = (id: string, entries: unknown[]) => ({
  id,
  title: 'Thread ' + id,
  titleStatus: 'generated',
  createdAt: ISO_A,
  updatedAt: ISO_B,
  entries,
});

const legacyUserThread = (id: string): IAiConversationThread =>
  ({
    id,
    title: 'Legacy ' + id,
    titleStatus: 'generated',
    createdAt: ISO_A,
    updatedAt: ISO_B,
    messages: [{ role: 'user', id: 'm-' + id, createdAt: ISO_A, content: 'hello', references: [] }],
  }) as unknown as IAiConversationThread;

describe('resolvePersistedThreads（Step 7.3 读路径优先级）', () => {
  it('新 key 严格解析成功 → 直接采用 entries', () => {
    const snapshot = {
      version: 1,
      activeThreadId: 't1',
      threads: [entriesThread('t1', [userMessageEntry('u1', 'hi')])],
    };
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: snapshot,
      legacyActiveThreadId: null,
      legacyThreads: [],
    });
    expect(result.source).toBe('entries');
    expect(result.activeThreadId).toBe('t1');
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].entries).toHaveLength(1);
  });

  it('新 key 含单条坏 entry → 逐条救援，丢坏留好', () => {
    const snapshot = {
      version: 1,
      activeThreadId: 't1',
      threads: [
        entriesThread('t1', [userMessageEntry('u1', 'ok'), userMessageEntry('', 'bad-empty-id')]),
      ],
    };
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: snapshot,
      legacyActiveThreadId: null,
      legacyThreads: [],
    });
    expect(result.source).toBe('entries-salvaged');
    expect(result.threads[0].entries).toHaveLength(1);
    expect(result.threads[0].entries[0].type).toBe('user_message');
  });

  it('新 key 缺失 → 回退 legacy，按线程投影为 entries', () => {
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: null,
      legacyActiveThreadId: 'L1',
      legacyThreads: [legacyUserThread('L1')],
    });
    expect(result.source).toBe('legacy');
    expect(result.activeThreadId).toBe('L1');
    expect(result.threads[0].entries[0].type).toBe('user_message');
  });

  it('新 key 存在但不可救援（threads 非数组）→ 回退 legacy', () => {
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: { version: 1, activeThreadId: 'x', threads: 'not-an-array' },
      legacyActiveThreadId: 'L1',
      legacyThreads: [legacyUserThread('L1')],
    });
    expect(result.source).toBe('legacy');
  });

  it('新旧 key 都空 → 空态', () => {
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: null,
      legacyActiveThreadId: null,
      legacyThreads: [],
    });
    expect(result.source).toBe('empty');
    expect(result.activeThreadId).toBeNull();
    expect(result.threads).toEqual([]);
  });

  it('activeThreadId 指向不存在线程 → 校正为首个线程', () => {
    const snapshot = {
      version: 1,
      activeThreadId: 'nope',
      threads: [entriesThread('t1', [userMessageEntry('u1', 'hi')])],
    };
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: snapshot,
      legacyActiveThreadId: null,
      legacyThreads: [],
    });
    expect(result.source).toBe('entries');
    expect(result.activeThreadId).toBe('t1');
  });

  it('新 key 严格成功但 threads 为空 → 尊重空态，不复活 legacy', () => {
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: { version: 1, activeThreadId: null, threads: [] },
      legacyActiveThreadId: 'L1',
      legacyThreads: [legacyUserThread('L1')],
    });
    expect(result.source).toBe('entries');
    expect(result.threads).toEqual([]);
    expect(result.activeThreadId).toBeNull();
  });
});
`;

// ---------------------------------------------------------------------------
// 写入（CREATE-only；已存在则拒绝，除非 --force）
// ---------------------------------------------------------------------------
const CREATES = [
  { path: 'src/store/aiThread/hydrate.ts', content: HYDRATE_TS },
  { path: 'src/store/aiThread/hydrate.spec.ts', content: HYDRATE_SPEC_TS },
];

for (const { path } of CREATES) {
  if (existsSync(abs(path)) && !FORCE) {
    fail(`目标文件已存在：${path}（如确需覆盖请加 --force）。`);
  }
}

if (CHECK) {
  console.log('— step7-3 预演（--check，未写入）—');
  console.log(`REPO_ROOT = ${REPO_ROOT}`);
  console.log('依赖校验通过：persist.schema / persist / legacy-adapter 均存在且导出齐全。');
  for (const c of CREATES) console.log(`  [create] ${c.path}  (${c.content.split('\n').length} 行)`);
  console.log('可去掉 --check 应用。');
  process.exit(0);
}

for (const c of CREATES) {
  mkdirSync(dirname(abs(c.path)), { recursive: true });
  writeFileSync(abs(c.path), c.content, 'utf8');
  console.log(`✓ created ${c.path}`);
}
console.log('\n完成。请运行 pnpm typecheck && pnpm lint && pnpm test 后手动提交。');