import { createStore, del, get, set, type UseStore } from 'idb-keyval';

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
