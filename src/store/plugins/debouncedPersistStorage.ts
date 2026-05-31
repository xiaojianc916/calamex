import { createStore, del, get, set, type UseStore } from 'idb-keyval';
import type { StorageLike } from 'pinia-plugin-persistedstate';

/**
 * ai-conversation 专用持久化 storage：底层从 localStorage 换成 IndexedDB(idb-keyval)。
 *
 * 动机：ai-conversation 会话带有图片预览 base64，localStorage ~5MB 上限极易被
 * 撞爆触发 QuotaExceededError 使整个 store 持久化静默失败;IndexedDB 配额大得多。
 *
 * 约束：pinia-plugin-persistedstate 的 hydration 是同步的(getItem 必须同步返回),
 * 而 idb-keyval 是异步的。因此沿用仓库已有的 tauriSessionStorage 范式：
 *   1. 启动时 await hydrateAiConversationStorage() 把 idb 快照加载进内存 cache;
 *   2. 同步 getItem 从 cache 返回;
 *   3. 同步 setItem 更新 cache + 防抖异步 set() 落盘。
 * hydrate 必须在 Pinia 首次读 getItem 之前完成(见 main.ts，与 session hydrate 并行 await)。
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** pinia persist key;与旧 localStorage 持久化保持一致以便一次性迁移。 */
const AI_CONVERSATION_PERSIST_KEY = 'shell-ide.ai-conversation';
/** 写入防抖：滚动/流式期间高频 setItem 合并为一次 idb 落盘。 */
const SAVE_DEBOUNCE_MS = 300;
/** hydrate 读取 idb 的超时;超时则以空态启动，避免阻塞首屏。 */
const HYDRATE_TIMEOUT_MS = 300;
/** 专用 IndexedDB 库/表名，与其他持久化隔离。 */
const IDB_DB_NAME = 'shell-ide.ai-conversation';
const IDB_STORE_NAME = 'persist';

export type TAiConversationHydrateStatus = 'loaded' | 'empty' | 'timeout';

/** 在 plugin StorageLike 之外额外暴露 removeItem，供业务层/测试主动清理。 */
export interface IAiConversationPersistStorage extends StorageLike {
  removeItem(key: string): void;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let idbStore: UseStore | null = null;
let cache: string | null = null;
let isReady = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let persistQueue: Promise<void> = Promise.resolve();
let flushListenersRegistered = false;

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

const stringifyError = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);

const logWarn = (event: string, detail: string): void => {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'warn',
      scope: 'ai-conversation-persist',
      event,
      detail,
    }),
  );
};

const logError = (event: string, error: unknown): void => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      scope: 'ai-conversation-persist',
      event,
      detail: stringifyError(error),
    }),
  );
};

// ---------------------------------------------------------------------------
// idb helpers
// ---------------------------------------------------------------------------

const getIdbStore = (): UseStore => {
  if (!idbStore) {
    idbStore = createStore(IDB_DB_NAME, IDB_STORE_NAME);
  }
  return idbStore;
};

const readLegacyLocalStorage = (): string | null => {
  try {
    return window.localStorage.getItem(AI_CONVERSATION_PERSIST_KEY);
  } catch {
    return null;
  }
};

const removeLegacyLocalStorage = (): void => {
  try {
    window.localStorage.removeItem(AI_CONVERSATION_PERSIST_KEY);
  } catch {
    // 受限环境:忽略
  }
};

/**
 * 从 idb 读取快照;若 idb 无记录则尝试从旧 localStorage 一次性迁移。
 * 迁移成功后写入 idb 并清除旧 localStorage key，避免重复迁移。
 */
const loadFromIdbWithMigration = async (): Promise<string | null> => {
  const store = getIdbStore();
  const fromIdb = await get<string>(AI_CONVERSATION_PERSIST_KEY, store);
  if (fromIdb !== undefined) {
    return fromIdb;
  }
  const legacy = readLegacyLocalStorage();
  if (legacy !== null) {
    await set(AI_CONVERSATION_PERSIST_KEY, legacy, store);
    removeLegacyLocalStorage();
    return legacy;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Timeout helper (Promise.race 风格;超时返回 sentinel 不抛错)
// ---------------------------------------------------------------------------

const TIMEOUT_SENTINEL: unique symbol = Symbol('ai-conversation-hydrate-timeout');

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

// ---------------------------------------------------------------------------
// Persist scheduling
// ---------------------------------------------------------------------------

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
      logError(errorEvent, error);
    });
};

const schedulePersist = (value: string): void => {
  clearSaveTimer();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    enqueuePersist(
      () => set(AI_CONVERSATION_PERSIST_KEY, value, getIdbStore()),
      'ai-conversation-save-failed',
    );
  }, SAVE_DEBOUNCE_MS);
};

/** best-effort：页面隐藏/卸载时把未落盘的最新 cache 立即入队写入。 */
const flushPendingPersist = (): void => {
  if (saveTimer === null || cache === null) return;
  clearSaveTimer();
  const value = cache;
  enqueuePersist(
    () => set(AI_CONVERSATION_PERSIST_KEY, value, getIdbStore()),
    'ai-conversation-flush-failed',
  );
};

const registerFlushListeners = (): void => {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 异步初始化：从 idb(或迁移自 localStorage) 加载快照到 cache，然后置 isReady。
 * 必须在 Pinia 读 getItem 之前 await 完成(见 main.ts)，否则首次读拿到 null
 * (会退化到 store 初始值)。
 */
export const hydrateAiConversationStorage =
  async (): Promise<TAiConversationHydrateStatus> => {
    if (typeof window === 'undefined') {
      isReady = true;
      cache = null;
      return 'empty';
    }
    registerFlushListeners();
    const result = await withTimeout(loadFromIdbWithMigration(), HYDRATE_TIMEOUT_MS);
    isReady = true;
    if (result === TIMEOUT_SENTINEL) {
      cache = null;
      logWarn(
        'ai-conversation-hydrate-timeout',
        `idb did not resolve within ${HYDRATE_TIMEOUT_MS}ms; starting with empty cache`,
      );
      return 'timeout';
    }
    cache = result;
    return result === null ? 'empty' : 'loaded';
  };

const aiConversationStorage: IAiConversationPersistStorage = {
  getItem(key) {
    if (!isReady || key !== AI_CONVERSATION_PERSIST_KEY) {
      return null;
    }
    return cache;
  },

  setItem(key, value) {
    // 与 cache 相同则跳过，避免无变更的重复 idb 写入。
    if (key !== AI_CONVERSATION_PERSIST_KEY || value === cache) {
      return;
    }
    cache = value;
    if (typeof window === 'undefined') return;
    schedulePersist(value);
  },

  removeItem(key) {
    if (key !== AI_CONVERSATION_PERSIST_KEY) return;
    clearSaveTimer();
    cache = null;
    if (typeof window === 'undefined') return;
    enqueuePersist(
      () => del(AI_CONVERSATION_PERSIST_KEY, getIdbStore()),
      'ai-conversation-remove-failed',
    );
  },
};

export const getAiConversationPersistStorage = (): IAiConversationPersistStorage =>
  aiConversationStorage;
