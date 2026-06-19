#!/usr/bin/env node
// scripts/codemod/step7-4b-entries-mirror-storage.mjs
//
// Step 7.4b —— entries 新 key 镜像持久化引擎 (未接线, 零运行时变化)
//
// 改动:
//   [EDIT]   src/store/plugins/debouncedPersistStorage.ts
//            const preparePersistValue → export const preparePersistValue  (纯附加, 行为等价)
//   [CREATE] src/store/plugins/aiThreadEntriesStorage.ts        镜像引擎 (自带防抖器)
//   [CREATE] src/store/plugins/aiThreadEntriesStorage.spec.ts   单测 (仿 debounced spec)
//
// 设计:
//   - 写盘前复用 preparePersistValue: data:image 抽进同一 idb 指针池 (内容派生 id,
//     与 legacy 幂等同 id), 零重复 blob; 与 debounced 共用同库/表 shell-ide.ai-conversation/persist。
//   - 新增独立快照 key 'shell-ide.ai-thread-entries'; 自带 trailing+maxWait 防抖 (复刻已验证算法)。
//   - 镜像 hydrate 返回原始快照, 不还原图片指针 (还原留待 7.5 entries 渲染时)。
//   - 未被 main.ts / 任何 barrel 引用 → 零运行时变化, 可回退。
//
// 独立性: 仅依赖 main 既有的 debouncedPersistStorage; 与 7.1/7.2/7.3/7.4a 无依赖。
//
// 用法:
//   node scripts/codemod/step7-4b-entries-mirror-storage.mjs --check
//   node scripts/codemod/step7-4b-entries-mirror-storage.mjs
//   node scripts/codemod/step7-4b-entries-mirror-storage.mjs --force
//   REPO_ROOT=/path node scripts/codemod/step7-4b-entries-mirror-storage.mjs

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.env.REPO_ROOT ?? process.cwd());
const argv = new Set(process.argv.slice(2));
const CHECK = argv.has('--check');
const FORCE = argv.has('--force');

const log = (...a) => console.log('[step7-4b]', ...a);
const fail = (msg) => {
  console.error('[step7-4b] ✗', msg);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// EDIT: 导出 preparePersistValue
// ---------------------------------------------------------------------------
const EDIT = {
  path: 'src/store/plugins/debouncedPersistStorage.ts',
  find: 'const preparePersistValue = async (value: string): Promise<string> => {',
  replace: 'export const preparePersistValue = async (value: string): Promise<string> => {',
  applied: 'export const preparePersistValue = async (value: string): Promise<string> => {',
};

// ---------------------------------------------------------------------------
// CREATE: 镜像引擎
// ---------------------------------------------------------------------------
const ENGINE_TS = `import { createStore, del, get, set, type UseStore } from 'idb-keyval';

import { preparePersistValue } from '@/store/plugins/debouncedPersistStorage';
import { logger } from '@/utils/platform/logger';

/**
 * entries 模型镜像持久化引擎 (Step 7.4b)。
 *
 * 双写阶段(7.4/7.5)由 glue 在会话 store 变更时投影并 scheduleAiThreadEntriesPersist;
 * 当前未接线 (main.ts / barrel 均不引用) → 零运行时变化。
 *
 * 复用约束:
 * - 与 debouncedPersistStorage 共用同一 IndexedDB 库/表, 写盘前调用 preparePersistValue
 *   把 data:image 抽取为 idb:// 指针 (内容派生 id, 与 legacy 抽取幂等同 id), 不产生重复 blob。
 * - 仅新增独立快照 key 'shell-ide.ai-thread-entries'。
 *
 * 调度器为本引擎独有 (与 debounced 刻意分离, 不盲改数据安全关键文件);
 * Step 8 删除 legacy 引擎后本引擎转正, 故该"重复"为迁移期产物, 非长期债。
 *
 * hydrate 仅返回原始快照, 不还原图片指针 —— 还原只在 7.5 真正以 entries 渲染时需要。
 */

const AI_THREAD_ENTRIES_PERSIST_KEY = 'shell-ide.ai-thread-entries';
const IDB_DB_NAME = 'shell-ide.ai-conversation';
const IDB_STORE_NAME = 'persist';
const SAVE_DEBOUNCE_MS = 300;
const SAVE_MAX_WAIT_MS = 1000;
const HYDRATE_TIMEOUT_MS = 300;

export type TAiThreadEntriesHydrateStatus = 'loaded' | 'empty' | 'timeout';

export interface IAiThreadEntriesHydrateResult {
  status: TAiThreadEntriesHydrateStatus;
  raw: string | null;
}

const entriesLogger = logger.child({ scope: 'ai-thread-entries-persist' });

let idbStore: UseStore | null = null;
let cache: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let firstPendingAt: number | null = null;
let persistQueue: Promise<void> = Promise.resolve();
let flushListenersRegistered = false;

const getIdbStore = (): UseStore => {
  if (!idbStore) {
    idbStore = createStore(IDB_DB_NAME, IDB_STORE_NAME);
  }
  return idbStore;
};

const TIMEOUT_SENTINEL: unique symbol = Symbol('ai-thread-entries-hydrate-timeout');

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMEOUT_SENTINEL> =>
  new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(TIMEOUT_SENTINEL);
    }, timeoutMs);
    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(TIMEOUT_SENTINEL);
      });
  });

const clearSaveTimer = (): void => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
};

const enqueuePersist = (operation: () => Promise<void>, errorEvent: string): void => {
  persistQueue = persistQueue
    .catch(() => undefined)
    .then(operation)
    .catch((error) => {
      entriesLogger.error({ event: errorEvent, err: error });
    });
};

const writeSnapshot = async (value: string): Promise<void> => {
  await set(AI_THREAD_ENTRIES_PERSIST_KEY, await preparePersistValue(value), getIdbStore());
};

const schedulePersist = (value: string): void => {
  const now = Date.now();
  if (firstPendingAt === null) {
    firstPendingAt = now;
  }
  // trailing 防抖 + maxWait 上限: 高频写入时 delay 收敛到 0, 最迟 SAVE_MAX_WAIT_MS 必落盘一次。
  const elapsed = now - firstPendingAt;
  const delay = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS - elapsed));
  clearSaveTimer();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    firstPendingAt = null;
    enqueuePersist(() => writeSnapshot(value), 'ai-thread-entries-save-failed');
  }, delay);
};

const flushPendingPersist = (): void => {
  if (saveTimer === null || cache === null) return;
  clearSaveTimer();
  firstPendingAt = null;
  const value = cache;
  enqueuePersist(() => writeSnapshot(value), 'ai-thread-entries-flush-failed');
};

/** 注册页面隐藏/卸载时的 best-effort flush (应用级单例, 幂等)。 */
export const registerAiThreadEntriesFlushListeners = (): void => {
  if (flushListenersRegistered || typeof window === 'undefined') return;
  flushListenersRegistered = true;
  window.addEventListener('pagehide', flushPendingPersist);
  window.addEventListener('beforeunload', flushPendingPersist);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushPendingPersist();
      }
    });
  }
};

/**
 * 读取新 key 原始快照 JSON (不还原图片指针)。带超时, 超时返回 'timeout' 且 cache 保持 null。
 */
export const hydrateAiThreadEntriesSnapshot = async (): Promise<IAiThreadEntriesHydrateResult> => {
  if (typeof window === 'undefined') {
    cache = null;
    return { status: 'empty', raw: null };
  }
  registerAiThreadEntriesFlushListeners();
  const loadPromise = get<string>(AI_THREAD_ENTRIES_PERSIST_KEY, getIdbStore()).then((value) =>
    value === undefined ? null : value,
  );
  const result = await withTimeout(loadPromise, HYDRATE_TIMEOUT_MS);
  if (result === TIMEOUT_SENTINEL) {
    cache = null;
    entriesLogger.warn({
      event: 'ai-thread-entries-hydrate-timeout',
      detail: 'idb did not resolve within ' + HYDRATE_TIMEOUT_MS + 'ms',
    });
    return { status: 'timeout', raw: null };
  }
  cache = result;
  return { status: result === null ? 'empty' : 'loaded', raw: result };
};

/** 双写: 投影后的 entries 快照 JSON 入防抖落盘队列 (与 cache 相同则跳过)。 */
export const scheduleAiThreadEntriesPersist = (value: string): void => {
  if (value === cache) return;
  cache = value;
  if (typeof window === 'undefined') return;
  schedulePersist(value);
};

/** best-effort: 立即把未落盘的 cache 入队写入。 */
export const flushAiThreadEntriesPersist = (): void => {
  flushPendingPersist();
};

/** 当前内存 cache 中的原始快照 (测试/对账用)。 */
export const getAiThreadEntriesSnapshotRaw = (): string | null => cache;

/** 清除新 key 快照 (回退/清理用)。 */
export const clearAiThreadEntriesSnapshot = (): void => {
  clearSaveTimer();
  firstPendingAt = null;
  cache = null;
  if (typeof window === 'undefined') return;
  enqueuePersist(
    () => del(AI_THREAD_ENTRIES_PERSIST_KEY, getIdbStore()),
    'ai-thread-entries-remove-failed',
  );
};
`;

// ---------------------------------------------------------------------------
// CREATE: 镜像引擎 spec (仿 debouncedPersistStorage.spec.ts)
// ---------------------------------------------------------------------------
const ENGINE_SPEC_TS = `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 防抖窗口上限 + 余量。
const SAVE_WAIT_MS = 350;
// hydrate 超时窗口(300ms) + 余量。
const HYDRATE_TIMEOUT_WAIT_MS = 350;

const { idbMock } = vi.hoisted(() => {
  const map = new Map<string, string>();
  return {
    idbMock: {
      map,
      createStore: vi.fn(() => ({})),
      get: vi.fn(async (key: string) => map.get(key)),
      set: vi.fn(async (key: string, value: string) => {
        map.set(key, value);
      }),
      del: vi.fn(async (key: string) => {
        map.delete(key);
      }),
    },
  };
});

vi.mock('idb-keyval', () => ({
  createStore: idbMock.createStore,
  get: idbMock.get,
  set: idbMock.set,
  del: idbMock.del,
}));

const KEY = 'shell-ide.ai-thread-entries';

const loadModule = async () => {
  vi.resetModules();
  return import('./aiThreadEntriesStorage');
};

beforeEach(() => {
  idbMock.map.clear();
  idbMock.createStore.mockClear();
  idbMock.get.mockClear();
  idbMock.set.mockClear();
  idbMock.del.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ai-thread-entries 镜像持久化 storage', () => {
  it('idb 为空时 hydrate 返回 empty', async () => {
    const mod = await loadModule();
    const { status, raw } = await mod.hydrateAiThreadEntriesSnapshot();
    expect(status).toBe('empty');
    expect(raw).toBeNull();
    expect(mod.getAiThreadEntriesSnapshotRaw()).toBeNull();
  });

  it('hydrate 命中后返回原始快照(不还原图片指针)', async () => {
    const raw = JSON.stringify({ version: 1, activeThreadId: null, threads: [] });
    idbMock.map.set(KEY, raw);
    const mod = await loadModule();
    const result = await mod.hydrateAiThreadEntriesSnapshot();
    expect(result.status).toBe('loaded');
    expect(result.raw).toBe(raw);
  });

  it('schedule 后防抖落盘到新 key', async () => {
    const mod = await loadModule();
    await mod.hydrateAiThreadEntriesSnapshot();
    mod.scheduleAiThreadEntriesPersist('{"v":1}');
    expect(mod.getAiThreadEntriesSnapshotRaw()).toBe('{"v":1}');
    expect(idbMock.set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(idbMock.set).toHaveBeenCalledWith(KEY, '{"v":1}', expect.anything());
  });

  it('schedule 与 cache 相同时不重复落盘', async () => {
    idbMock.map.set(KEY, '{"v":1}');
    const mod = await loadModule();
    await mod.hydrateAiThreadEntriesSnapshot();
    idbMock.set.mockClear();
    mod.scheduleAiThreadEntriesPersist('{"v":1}');
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(idbMock.set).not.toHaveBeenCalled();
  });

  it('快照内 data:image 经 preparePersistValue 抽取为共享池指针', async () => {
    const mod = await loadModule();
    await mod.hydrateAiThreadEntriesSnapshot();
    const snapshot = JSON.stringify({
      version: 1,
      activeThreadId: 't',
      threads: [
        {
          id: 't',
          entries: [
            {
              type: 'user_message',
              references: [{ attachmentPreview: { src: 'data:image/png;base64,XYZ' } }],
            },
          ],
        },
      ],
    });
    mod.scheduleAiThreadEntriesPersist(snapshot);
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);

    const written = idbMock.map.get(KEY);
    expect(written).toContain('idb://ai-conversation-attachment-preview/');
    expect(written).not.toContain('data:image/png;base64,XYZ');
    // base64 落入共享图片池
    expect([...idbMock.map.values()]).toContain('data:image/png;base64,XYZ');
  });

  it('flush 立即把未落盘快照入队写入', async () => {
    const mod = await loadModule();
    await mod.hydrateAiThreadEntriesSnapshot();
    mod.scheduleAiThreadEntriesPersist('{"v":2}');
    expect(idbMock.set).not.toHaveBeenCalled();
    mod.flushAiThreadEntriesPersist();
    await vi.advanceTimersByTimeAsync(0);
    expect(idbMock.set).toHaveBeenCalledWith(KEY, '{"v":2}', expect.anything());
  });

  it('clear 删除新 key 并清空 cache', async () => {
    idbMock.map.set(KEY, '{"v":1}');
    const mod = await loadModule();
    await mod.hydrateAiThreadEntriesSnapshot();
    mod.clearAiThreadEntriesSnapshot();
    expect(mod.getAiThreadEntriesSnapshotRaw()).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(idbMock.del).toHaveBeenCalledWith(KEY, expect.anything());
  });

  it('hydrate 超时返回 timeout 且 cache 为 null', async () => {
    idbMock.get.mockImplementationOnce(() => new Promise<string | undefined>(() => {}));
    const mod = await loadModule();
    const hydratePromise = mod.hydrateAiThreadEntriesSnapshot();
    await vi.advanceTimersByTimeAsync(HYDRATE_TIMEOUT_WAIT_MS);
    const result = await hydratePromise;
    expect(result.status).toBe('timeout');
    expect(result.raw).toBeNull();
    expect(mod.getAiThreadEntriesSnapshotRaw()).toBeNull();
  });
});
`;

const CREATES = [
  { path: 'src/store/plugins/aiThreadEntriesStorage.ts', content: ENGINE_TS },
  { path: 'src/store/plugins/aiThreadEntriesStorage.spec.ts', content: ENGINE_SPEC_TS },
];

// ---------------------------------------------------------------------------
// 执行 (事务式: 任一校验失败即零写入)
// ---------------------------------------------------------------------------
const run = () => {
  log('REPO_ROOT =', REPO_ROOT);
  log(CHECK ? '模式: --check (干跑)' : FORCE ? '模式: 写入 (--force 覆盖)' : '模式: 写入');

  // 1) EDIT 目标校验
  const editAbs = join(REPO_ROOT, EDIT.path);
  if (!existsSync(editAbs)) {
    fail(`缺少 ${EDIT.path} —— 与预期 main 不符, 未写入任何文件。`);
  }
  const editContent = readFileSync(editAbs, 'utf8');
  let editNeeded = true;
  if (editContent.includes(EDIT.applied)) {
    editNeeded = false;
    log('• preparePersistValue 已是 export, 跳过 EDIT (幂等)。');
  } else {
    const occ = editContent.split(EDIT.find).length - 1;
    if (occ !== 1) {
      fail(`${EDIT.path} 中 preparePersistValue 锚点出现 ${occ} 次(期望 1), 未写入任何文件。`);
    }
  }

  // 2) CREATE 冲突校验
  const conflicts = CREATES.filter((f) => existsSync(join(REPO_ROOT, f.path)));
  if (conflicts.length > 0 && !FORCE) {
    conflicts.forEach((f) => console.error('[step7-4b] ✗ 目标已存在:', f.path));
    fail('目标文件已存在; 用 --force 覆盖, 或先清理。未写入任何文件。');
  }

  if (CHECK) {
    log(editNeeded ? `  [将编辑] ${EDIT.path} (export preparePersistValue)` : `  [跳过]   ${EDIT.path}`);
    CREATES.forEach((f) => {
      const state = existsSync(join(REPO_ROOT, f.path)) ? '将覆盖' : '将创建';
      log(`  [${state}] ${f.path} (${f.content.length} bytes)`);
    });
    log('✓ --check 通过, 未写入。');
    return;
  }

  // 3) 应用 (前置已全部通过)
  if (editNeeded) {
    const next = editContent.replace(EDIT.find, () => EDIT.replace);
    writeFileSync(editAbs, next, { encoding: 'utf8' });
    log('  ✓ 编辑', EDIT.path);
  }
  for (const f of CREATES) {
    const abs = join(REPO_ROOT, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, { encoding: 'utf8' });
    log('  ✓ 写入', f.path);
  }
  log('✓ 完成。下一步: pnpm typecheck && pnpm lint && pnpm test');
};

run();