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
 *
 * 数据安全约束(关键):hydrate 读 idb 超时时**绝不能**用空白初始态覆盖磁盘上
 * 尚未读出的历史。详见 hydrateAiConversationStorage / reconcileAfterHydrate /
 * setItem 的 deferred-write 逻辑。
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** pinia persist key;与旧 localStorage 持久化保持一致以便一次性迁移。 */
const AI_CONVERSATION_PERSIST_KEY = 'shell-ide.ai-conversation';
/** 写入防抖：滚动/流式期间高频 setItem 合并为一次 idb 落盘。 */
const SAVE_DEBOUNCE_MS = 300;
/**
 * 防抖最大等待:即使 setItem 持续高频触发(如长篇流式输出每帧都写),也必须
 * 至少每 SAVE_MAX_WAIT_MS 落盘一次。否则 trailing-only 防抖会被持续活动
 * "饿死",整段进行中的会话长时间不落盘,崩溃/退出即全部丢失。
 */
const SAVE_MAX_WAIT_MS = 1000;
/** hydrate 读取 idb 的超时;超时则以空态启动，避免阻塞首屏。 */
const HYDRATE_TIMEOUT_MS = 300;
/** 专用 IndexedDB 库/表名，与其他持久化隔离。 */
const IDB_DB_NAME = 'shell-ide.ai-conversation';
const IDB_STORE_NAME = 'persist';
const ATTACHMENT_PREVIEW_POINTER_PREFIX = 'idb://ai-conversation-attachment-preview/';
const ATTACHMENT_PREVIEW_KEY_PREFIX = 'ai-conversation-attachment-preview:';
const DATA_IMAGE_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/iu;
const ATTACHMENT_PREVIEW_POINTER_PATTERN = /^idb:\/\/ai-conversation-attachment-preview\//u;

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
/**
 * 真正的 idb 读取是否已 settle。
 * - hydrate 命中/为空:settle 后置 true。
 * - hydrate 超时:先返回 'timeout' 但保持 false,直到后台读取真正 settle
 *   (reconcileAfterHydrate)才置 true。
 * 在其为 false 期间,setItem 不直接落盘,而是把最新值暂存到 deferredWrite,
 * 杜绝"超时空态覆盖磁盘历史"。
 */
let hydrationSettled = false;
/** 超时占位期间用户写入的最新值;reconcile 时据此决定落盘还是恢复磁盘值。 */
let deferredWrite: string | null = null;
/** 是否发生过 removeItem(显式清理);若有则后台迁移/对账不得复活磁盘数据。 */
let clearedDuringHydration = false;
/**
 * hydrate 超时占位期 getItem 返回 null 后,pinia-plugin-persistedstate 会让 store
 * 以默认 state([createThread()] 这一空白线程,且能通过 schema 校验)初始化,并在
 * afterHydrate 归一化赋值时触发一次 $subscribe → setItem,把这份"空白初始态"回写。
 * 这一次回写并非用户真实输入:若把它当作 deferredWrite 落盘,reconcileAfterHydrate
 * 会用空白态覆盖磁盘上尚未读出的历史,正是"对话记录莫名其妙被清空"的根因。
 * 用此标记识别并丢弃紧随其后的那一次回写。
 */
let hydrationEchoPending = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 当前防抖批次首次入队的时间戳(ms);用于 SAVE_MAX_WAIT_MS 上限计算。 */
let firstPendingAt: number | null = null;
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

const createAttachmentPreviewStorageId = (value: string): string => {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return `${value.length.toString(36)}-${hash.toString(36).padStart(7, '0')}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isDataImageUrl = (value: string): boolean => DATA_IMAGE_URL_PATTERN.test(value);

const isAttachmentPreviewPointer = (value: string): boolean =>
  ATTACHMENT_PREVIEW_POINTER_PATTERN.test(value);

const toAttachmentPreviewKey = (id: string): string => `${ATTACHMENT_PREVIEW_KEY_PREFIX}${id}`;
const toAttachmentPreviewPointer = (id: string): string => `${ATTACHMENT_PREVIEW_POINTER_PREFIX}${id}`;

const getAttachmentPreviewIdFromPointer = (value: string): string | null => {
  if (!isAttachmentPreviewPointer(value)) {
    return null;
  }

  const id = value.slice(ATTACHMENT_PREVIEW_POINTER_PREFIX.length).trim();

  return id || null;
};

const extractAttachmentPreviewPayloads = async (value: unknown): Promise<void> => {
  if (Array.isArray(value)) {
    for (const item of value) {
      await extractAttachmentPreviewPayloads(item);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'src' && typeof child === 'string' && isDataImageUrl(child)) {
      const id = createAttachmentPreviewStorageId(child);
      await set(toAttachmentPreviewKey(id), child, getIdbStore());
      value[key] = toAttachmentPreviewPointer(id);
      continue;
    }

    await extractAttachmentPreviewPayloads(child);
  }
};

const restoreAttachmentPreviewPayloads = async (value: unknown): Promise<void> => {
  if (Array.isArray(value)) {
    for (const item of value) {
      await restoreAttachmentPreviewPayloads(item);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'src' && typeof child === 'string') {
      const id = getAttachmentPreviewIdFromPointer(child);

      if (id) {
        const restored = await get<string>(toAttachmentPreviewKey(id), getIdbStore());
        if (typeof restored === 'string' && isDataImageUrl(restored)) {
          value[key] = restored;
        }
      }

      continue;
    }

    await restoreAttachmentPreviewPayloads(child);
  }
};

const preparePersistValue = async (value: string): Promise<string> => {
  try {
    const parsed: unknown = JSON.parse(value);
    await extractAttachmentPreviewPayloads(parsed);

    return JSON.stringify(parsed);
  } catch (error) {
    logWarn('ai-conversation-attachment-preview-extract-failed', stringifyError(error));
    return value;
  }
};

const restorePersistValue = async (value: string | null): Promise<string | null> => {
  if (value === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    await restoreAttachmentPreviewPayloads(parsed);

    return JSON.stringify(parsed);
  } catch (error) {
    logWarn('ai-conversation-attachment-preview-restore-failed', stringifyError(error));
    return value;
  }
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
 *
 * 若在读取过程中已发生显式 removeItem(clearedDuringHydration),则不得把
 * legacy 迁回 idb——否则会把刚被用户删除的数据复活。
 */
const loadFromIdbWithMigration = async (): Promise<string | null> => {
  const store = getIdbStore();
  const fromIdb = await get<string>(AI_CONVERSATION_PERSIST_KEY, store);
  if (fromIdb !== undefined) {
    return restorePersistValue(fromIdb);
  }
  const legacy = readLegacyLocalStorage();
  if (legacy !== null) {
    if (clearedDuringHydration) {
      removeLegacyLocalStorage();
      return null;
    }
    await set(AI_CONVERSATION_PERSIST_KEY, await preparePersistValue(legacy), store);
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
  const now = Date.now();
  if (firstPendingAt === null) {
    firstPendingAt = now;
  }
  // trailing 防抖 + maxWait 上限:连续高频写入时,delay 随距首次入队的时间
  // 收敛到 0,保证最迟 SAVE_MAX_WAIT_MS 内必落盘一次。
  const elapsed = now - firstPendingAt;
  const delay = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS - elapsed));
  clearSaveTimer();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    firstPendingAt = null;
    enqueuePersist(
      async () => set(AI_CONVERSATION_PERSIST_KEY, await preparePersistValue(value), getIdbStore()),
      'ai-conversation-save-failed',
    );
  }, delay);
};

/** best-effort：页面隐藏/卸载时把未落盘的最新 cache 立即入队写入。 */
const flushPendingPersist = (): void => {
  if (saveTimer === null || cache === null) return;
  clearSaveTimer();
  firstPendingAt = null;
  const value = cache;
  enqueuePersist(
    async () => set(AI_CONVERSATION_PERSIST_KEY, await preparePersistValue(value), getIdbStore()),
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
 * 后台 idb 读取真正 settle 后的对账,仅由"第一个 settle 者"执行一次
 * (hydrationSettled 守卫)。
 *
 * - 占位期间已 removeItem(clearedDuringHydration):保持已清空状态,不复活。
 * - 占位期间用户已写入(deferredWrite 非空):用户值权威并落盘(此时覆盖旧值
 *   是用户主动产生新内容,符合预期)。
 * - 占位期间无写入:把磁盘真实值恢复进 cache(供后续 getItem),纯读取不落盘。
 */
const reconcileAfterHydrate = (loaded: string | null): void => {
  if (hydrationSettled) {
    return;
  }
  hydrationSettled = true;
  if (clearedDuringHydration) {
    return;
  }
  if (deferredWrite !== null) {
    const value = deferredWrite;
    deferredWrite = null;
    cache = value;
    if (typeof window !== 'undefined') {
      schedulePersist(value);
    }
    return;
  }
  cache = loaded;
};

/**
 * 异步初始化：从 idb(或迁移自 localStorage) 加载快照到 cache，然后置 isReady。
 * 必须在 Pinia 读 getItem 之前 await 完成(见 main.ts)，否则首次读拿到 null
 * (会退化到 store 初始值)。
 *
 * 超时分支不再丢弃后台读取结果:loadPromise 仍在后台运行,settle 后由
 * reconcileAfterHydrate 决定恢复磁盘数据还是落盘用户新值,从而避免
 * "磁盘偏慢一次 → 历史被空态覆盖"的静默数据丢失。
 */
export const hydrateAiConversationStorage =
  async (): Promise<TAiConversationHydrateStatus> => {
    if (typeof window === 'undefined') {
      isReady = true;
      hydrationSettled = true;
      cache = null;
      return 'empty';
    }
    registerFlushListeners();
    const loadPromise = loadFromIdbWithMigration();
    // 后台对账:无论是否在 timeout 窗口内返回,真正 settle 后都对账一次。
    void loadPromise.then(reconcileAfterHydrate).catch((error) => {
      hydrationSettled = true;
      logError('ai-conversation-hydrate-failed', error);
    });
    const result = await withTimeout(loadPromise, HYDRATE_TIMEOUT_MS);
    isReady = true;
    if (result === TIMEOUT_SENTINEL) {
      // 占位空态:getItem 暂时返回 null,但 setItem 会 defer,最终处置交给
      // reconcileAfterHydrate,绝不在此用空态覆盖磁盘历史。
      cache = null;
      logWarn(
        'ai-conversation-hydrate-timeout',
        `idb did not resolve within ${HYDRATE_TIMEOUT_MS}ms; deferring writes until settle`,
      );
      return 'timeout';
    }
    // 命中:reconcileAfterHydrate 通常已先行设置 cache,这里再确保一次。
    cache = result;
    return result === null ? 'empty' : 'loaded';
  };

const aiConversationStorage: IAiConversationPersistStorage = {
  getItem(key) {
    if (!isReady || key !== AI_CONVERSATION_PERSIST_KEY) {
      return null;
    }
    if (cache === null && !hydrationSettled) {
      // 超时占位期返回 null:store 将以默认值初始化并随即回写一次空白初始态。
      // 标记下一次 setItem 为 hydrate 回声,需丢弃以免覆盖磁盘历史。
      hydrationEchoPending = true;
    }
    return cache;
  },

  setItem(key, value) {
    if (key !== AI_CONVERSATION_PERSIST_KEY) {
      return;
    }
    if (hydrationEchoPending) {
      // hydrate 超时占位期 store 以默认值初始化后回写的空白初始态:既非用户真实
      // 输入,也绝不能据此落盘或 defer(否则会覆盖磁盘上尚未读出的历史)。仅消费一次
      // 标记并丢弃本次写入,cache 与磁盘均不动,真实历史交由 reconcileAfterHydrate 恢复。
      hydrationEchoPending = false;
      return;
    }
    // 与 cache 相同则跳过，避免无变更的重复 idb 写入。
    if (value === cache) {
      return;
    }
    cache = value;
    if (typeof window === 'undefined') return;
    if (!hydrationSettled) {
      // hydrate(超时)尚未真正 settle:暂存最新值,等 reconcileAfterHydrate
      // 处置,避免用空白初始态覆盖磁盘上尚未读出的历史。
      deferredWrite = value;
      return;
    }
    schedulePersist(value);
  },

  removeItem(key) {
    if (key !== AI_CONVERSATION_PERSIST_KEY) return;
    clearSaveTimer();
    firstPendingAt = null;
    cache = null;
    deferredWrite = null;
    // 显式清理后,占位期回声标记不再适用,清掉以免误吞后续写入。
    hydrationEchoPending = false;
    // 阻止后台迁移/对账把已删数据复活。
    clearedDuringHydration = true;
    hydrationSettled = true;
    if (typeof window === 'undefined') return;
    enqueuePersist(
      () => del(AI_CONVERSATION_PERSIST_KEY, getIdbStore()),
      'ai-conversation-remove-failed',
    );
  },
};

export const getAiConversationPersistStorage = (): IAiConversationPersistStorage =>
  aiConversationStorage;
