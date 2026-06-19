#!/usr/bin/env node
/* step7-5a-entries-render-hydrate.mjs
 * ADR-0014 Step 7.5a —— 新建 entries 渲染 hydrate 组合器（DI、纯组合、未接线）。
 *   读取新 key 原始快照(JSON 字符串) -> JSON.parse 容错 -> resolvePersistedThreads
 *   归一 -> 仅活动线程附件预览指针即时恢复(失败非致命)。
 * CREATE-only：默认拒绝覆盖（--force 覆盖）；--check 干跑；前置校验跨文件导出契约。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();
const CHECK = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');
const tag = '[step7-5a]';
const log = (m) => console.log(tag + ' ' + m);
const die = (m) => { console.error(tag + ' ✗ ' + m); process.exit(1); };

log('REPO_ROOT = ' + REPO_ROOT);
log('模式: ' + (CHECK ? '检查' : '写入') + (FORCE ? '（--force 覆盖）' : ''));

const requireExport = (relPath, token) => {
  const abs = join(REPO_ROOT, relPath);
  if (!existsSync(abs)) die('前置缺失：' + relPath + ' 不存在。');
  if (!readFileSync(abs, 'utf8').includes(token)) die('前置缺失：' + relPath + ' 未找到 ' + token + '。');
};
requireExport('src/store/aiThread/hydrate.ts', 'export function resolvePersistedThreads');
requireExport('src/store/plugins/aiThreadEntriesStorage.ts', 'export const hydrateAiThreadEntriesSnapshot');
requireExport('src/store/plugins/debouncedPersistStorage.ts', 'restoreAttachmentPreviewPointers');

const SOURCE = `/* ============================================================================
 * Entries 渲染 hydrate 组合器（ADR-0014 Step 7.5a）
 *
 * 把「读取新 key 原始快照 -> resolvePersistedThreads 归一 -> 活动线程附件预览
 * 指针即时恢复」编排为纯组合、可注入依赖的异步函数。本文件不接线、除注入依赖外
 * 无副作用来源；接线在 7.5c（启动后台 hydrate 完成时调用）。
 *
 * 关键点：
 * - aiThreadEntriesStorage 的 hydrate 仅返回「原始 JSON 字符串」，不还原图片指针，
 *   故本层先 JSON.parse（坏 JSON 容错为 null，交由 resolver 回退 legacy），再交给
 *   纯函数 resolver 决策来源（entries / entries-salvaged / legacy / empty）。
 * - 仅对「活动线程」即时恢复附件预览指针（idb:// -> base64），保证首屏图片可见；
 *   其余线程留待 store 侧按活动线程切换惰性恢复（见 7.5b）。
 * - 恢复失败非致命：保留 idb:// 指针并返回未替换结果，下游按缺图处理。
 * ========================================================================== */
import type { IAiConversationThread } from '@/store/aiConversation';
import {
  resolvePersistedThreads,
  type IResolvePersistedThreadsInput,
  type IResolvedPersistedThreads,
} from '@/store/aiThread/hydrate';
import {
  hydrateAiThreadEntriesSnapshot,
  type IAiThreadEntriesHydrateResult,
} from '@/store/plugins/aiThreadEntriesStorage';
import { restoreAttachmentPreviewPointers } from '@/store/plugins/debouncedPersistStorage';
import type { IAiThread } from '@/types/ai/thread';

export interface IHydrateAiThreadEntriesForRenderInput {
  /** 旧 key 已 hydrate 的 activeThreadId（回退用）。 */
  legacyActiveThreadId: string | null;
  /** 旧 key 已 hydrate / 已救援的 legacy 线程（回退用）。 */
  legacyThreads: IAiConversationThread[];
}

export interface IEntriesRenderHydrateDeps {
  loadSnapshot: () => Promise<IAiThreadEntriesHydrateResult>;
  resolve: (input: IResolvePersistedThreadsInput) => IResolvedPersistedThreads;
  restorePointers: (thread: IAiThread) => Promise<{ changed: boolean; value: IAiThread }>;
}

const defaultDeps: IEntriesRenderHydrateDeps = {
  loadSnapshot: hydrateAiThreadEntriesSnapshot,
  resolve: resolvePersistedThreads,
  restorePointers: restoreAttachmentPreviewPointers,
};

/** 原始快照是 JSON 字符串：解析失败容错为 null（resolver 据此回退 legacy）。 */
function parseEntriesSnapshot(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** 仅对活动线程即时恢复指针；不可变替换，失败非致命。 */
async function restoreActiveThreadPointers(
  resolved: IResolvedPersistedThreads,
  restorePointers: IEntriesRenderHydrateDeps['restorePointers'],
): Promise<IResolvedPersistedThreads> {
  const { activeThreadId, threads } = resolved;
  if (!activeThreadId) return resolved;
  const at = threads.findIndex((thread) => thread.id === activeThreadId);
  if (at < 0) return resolved;
  try {
    const { changed, value } = await restorePointers(threads[at]);
    if (!changed) return resolved;
    const nextThreads = threads.slice();
    nextThreads[at] = value;
    return { ...resolved, threads: nextThreads };
  } catch {
    return resolved;
  }
}

export async function hydrateAiThreadEntriesForRender(
  input: IHydrateAiThreadEntriesForRenderInput,
  deps: IEntriesRenderHydrateDeps = defaultDeps,
): Promise<IResolvedPersistedThreads> {
  const snapshot = await deps.loadSnapshot();
  const resolved = deps.resolve({
    rawEntriesSnapshot: parseEntriesSnapshot(snapshot.raw),
    legacyActiveThreadId: input.legacyActiveThreadId,
    legacyThreads: input.legacyThreads,
  });
  return restoreActiveThreadPointers(resolved, deps.restorePointers);
}
`;

const SPEC = `import { describe, expect, it } from 'vitest';

import type { IAiConversationThread } from '@/store/aiConversation';
import { hydrateAiThreadEntriesForRender } from '@/store/aiThread/entriesRenderHydrate';
import type {
  IResolvePersistedThreadsInput,
  IResolvedPersistedThreads,
} from '@/store/aiThread/hydrate';
import type { IAiThread } from '@/types/ai/thread';

function makeThread(id: string): IAiThread {
  return {
    id,
    title: 'Thread ' + id,
    titleStatus: 'temporary',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: [],
  };
}

describe('hydrateAiThreadEntriesForRender', () => {
  it('解析原始快照 JSON 并把 legacy 入参透传给 resolver', async () => {
    let received: IResolvePersistedThreadsInput | null = null;
    const legacyThreads: IAiConversationThread[] = [];
    const resolved: IResolvedPersistedThreads = { source: 'entries', activeThreadId: null, threads: [] };

    const result = await hydrateAiThreadEntriesForRender(
      { legacyActiveThreadId: 'legacy-1', legacyThreads },
      {
        loadSnapshot: async () => ({ status: 'loaded', raw: JSON.stringify({ hello: 'world' }) }),
        resolve: (input) => {
          received = input;
          return resolved;
        },
        restorePointers: async (value: IAiThread) => ({ changed: false, value }),
      },
    );

    expect(received).not.toBeNull();
    expect(received?.rawEntriesSnapshot).toEqual({ hello: 'world' });
    expect(received?.legacyActiveThreadId).toBe('legacy-1');
    expect(received?.legacyThreads).toBe(legacyThreads);
    expect(result).toBe(resolved);
  });

  it('坏 JSON 容错为 null（交由 resolver 回退 legacy）', async () => {
    let received: IResolvePersistedThreadsInput | null = null;
    const resolved: IResolvedPersistedThreads = { source: 'legacy', activeThreadId: null, threads: [] };

    await hydrateAiThreadEntriesForRender(
      { legacyActiveThreadId: null, legacyThreads: [] },
      {
        loadSnapshot: async () => ({ status: 'loaded', raw: '{ not valid json' }),
        resolve: (input) => {
          received = input;
          return resolved;
        },
        restorePointers: async (value: IAiThread) => ({ changed: false, value }),
      },
    );

    expect(received?.rawEntriesSnapshot).toBeNull();
  });

  it('仅对活动线程即时恢复指针，且不可变替换', async () => {
    const t1 = makeThread('t1');
    const t2 = makeThread('t2');
    const restoredT2: IAiThread = { ...makeThread('t2'), title: 'restored' };
    const threads = [t1, t2];
    const resolved: IResolvedPersistedThreads = { source: 'entries', activeThreadId: 't2', threads };
    const restoreCalls: IAiThread[] = [];

    const result = await hydrateAiThreadEntriesForRender(
      { legacyActiveThreadId: null, legacyThreads: [] },
      {
        loadSnapshot: async () => ({ status: 'loaded', raw: '{}' }),
        resolve: () => resolved,
        restorePointers: async (value: IAiThread) => {
          restoreCalls.push(value);
          return { changed: true, value: restoredT2 };
        },
      },
    );

    expect(restoreCalls).toEqual([t2]);
    expect(result.threads[0]).toBe(t1);
    expect(result.threads[1]).toBe(restoredT2);
    expect(threads[1]).toBe(t2);
    expect(result.threads).not.toBe(threads);
  });

  it('指针恢复抛错非致命，原样返回 resolved', async () => {
    const t1 = makeThread('t1');
    const resolved: IResolvedPersistedThreads = { source: 'entries', activeThreadId: 't1', threads: [t1] };

    const result = await hydrateAiThreadEntriesForRender(
      { legacyActiveThreadId: null, legacyThreads: [] },
      {
        loadSnapshot: async () => ({ status: 'loaded', raw: '{}' }),
        resolve: () => resolved,
        restorePointers: async () => {
          throw new Error('idb down');
        },
      },
    );

    expect(result).toBe(resolved);
    expect(result.threads[0]).toBe(t1);
  });
});
`;

const files = [
  { path: 'src/store/aiThread/entriesRenderHydrate.ts', content: SOURCE },
  { path: 'src/store/aiThread/entriesRenderHydrate.spec.ts', content: SPEC },
];

for (const f of files) {
  if (existsSync(join(REPO_ROOT, f.path)) && !FORCE) {
    die('目标已存在：' + f.path + '（如确需覆盖请加 --force）。');
  }
}
if (CHECK) {
  log('✓ 检查通过：将创建 ' + files.map((f) => f.path).join(', ') + '。');
  process.exit(0);
}
for (const f of files) {
  const abs = join(REPO_ROOT, f.path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, f.content, 'utf8');
  log('✓ 写入 ' + f.path);
}
log('✓ 完成。');